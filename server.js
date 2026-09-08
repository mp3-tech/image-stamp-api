const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const path = require('path');

const app = express();

// Render 的 Linux 容器不含繁中字型。將 Noto Sans CJK TC 隨專案部署，
// 並讓 Sharp/libvips 透過 fontconfig 找到它，避免中文被渲染成方框。
const fontFamily = 'Noto Sans CJK TC';
const fontFile = path.join(__dirname, 'fonts', 'NotoSansCJKtc-Regular.otf');
// LINE 原圖常達數千萬像素；鋼印不需要保留原始解析度。限制最長邊可
// 大幅降低免費 Render 的記憶體與處理時間，也能讓後續圖床與 LINE 更快取用。
const STAMP_IMAGE_MAX_DIMENSION = 1920;
const STAMP_JPEG_QUALITY = 85;

const upload = multer({
  storage: multer.memoryStorage(),
});

// Google Maps 並沒有提供免金鑰、可直接呼叫的地址轉座標 API。這個端點只開啟
// Google Maps 的公開地圖頁，等待它完成定位後，讀取該地點的 !3d/!4d 標記。
// 不使用 @緯度,經度，因為那是地圖目前畫面的中心，不一定是地址的實際位置。
const GOOGLE_MAPS_TIMEOUT_MS = 20000;
const GOOGLE_MAPS_MIN_INTERVAL_MS = 1100;
const GOOGLE_MAPS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GOOGLE_MAPS_NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const GOOGLE_MAPS_MAX_PENDING = 8;
const GOOGLE_MAPS_MAX_CACHE_ENTRIES = 500;

const googleMapsCache = new Map();
let googleMapsQueue = Promise.resolve();
let googleMapsNextStartAt = 0;
let googleMapsPending = 0;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function normalizeAddress(address) {
  return String(address || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[臺台]/g, '台')
    .trim();
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

function parseGoogleMapsPlaceCoordinates(url) {
  // !3d/!4d 是 Google Maps 選定地點的座標；優先於網址中的 @ 地圖視窗中心。
  const match = String(url || '').match(
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,
  );
  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return validCoordinates(latitude, longitude) ? { latitude, longitude } : null;
}

function getCachedGoogleMapsResult(cacheKey) {
  const cached = googleMapsCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    googleMapsCache.delete(cacheKey);
    return undefined;
  }
  return cached.value;
}

function cacheGoogleMapsResult(cacheKey, value, ttlMs) {
  if (googleMapsCache.size >= GOOGLE_MAPS_MAX_CACHE_ENTRIES) {
    const oldestKey = googleMapsCache.keys().next().value;
    if (oldestKey) googleMapsCache.delete(oldestKey);
  }
  googleMapsCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
}

function enqueueGoogleMapsLookup(work) {
  const task = googleMapsQueue.then(work, work);
  // 失敗不能讓後續案件永遠卡在 rejected 的 queue 上。
  googleMapsQueue = task.catch(() => undefined);
  return task;
}

async function resolveGoogleMapsPlace(address) {
  const waitMs = Math.max(0, googleMapsNextStartAt - Date.now());
  if (waitMs) await sleep(waitMs);
  googleMapsNextStartAt = Date.now() + GOOGLE_MAPS_MIN_INTERVAL_MS;

  let browser;
  let page;
  try {
    browser = await puppeteer.launch({
      headless: 'shell',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-TW,zh;q=0.9',
    });
    page.setDefaultNavigationTimeout(GOOGLE_MAPS_TIMEOUT_MS);
    page.setDefaultTimeout(GOOGLE_MAPS_TIMEOUT_MS);

    const mapsUrl = `https://www.google.com/maps/place/${encodeURIComponent(address)}`;
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => /!3d-?\d{1,2}(?:\.\d+)?!4d-?\d{1,3}(?:\.\d+)?/.test(window.location.href),
      { timeout: GOOGLE_MAPS_TIMEOUT_MS },
    );

    const coordinates = parseGoogleMapsPlaceCoordinates(page.url());
    return coordinates
      ? { matched: true, source: 'google_maps_place', ...coordinates }
      : { matched: false, source: 'google_maps_place' };
  } catch (error) {
    // 地址找不到、Google 要求驗證或暫時不可用都視為「無法精確判定」，讓上游保持空值。
    // 只記錄去識別化的技術訊息，地址（含在網址中的查詢字串）不寫進 Render 日誌。
    const safeDetail = String(error?.message || error || 'unknown error')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .slice(0, 300);
    console.warn(`Google Maps coordinate resolver failed: ${safeDetail}`);
    return { matched: false, source: 'google_maps_place' };
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 1. 健康檢查端點 (Render 部署與監控驗證)
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Taoyuan Wildlife Rescue Image Stamp API',
    features: ['image-stamp', 'google-maps-address-coordinates'],
    timestamp: new Date().toISOString()
  });
});

// 1a. 地址轉經緯度：只在 Google Maps 出現選定地點的 !3d/!4d 座標時才成功。
// 若查無結果、Google 暫時無回應或不確定，固定回傳 matched:false；上游不可填入替代值。
app.get('/geocode/google-maps', async (req, res) => {
  const address = String(req.query.address || '').trim();
  const cacheKey = normalizeAddress(address);

  if (!cacheKey || address.length > 200) {
    return res.status(400).json({
      matched: false,
      source: 'google_maps_place',
      error: '請提供 1 至 200 個字的地址',
    });
  }

  const cached = getCachedGoogleMapsResult(cacheKey);
  if (cached !== undefined) {
    return res.json({ ...cached, cached: true });
  }

  if (googleMapsPending >= GOOGLE_MAPS_MAX_PENDING) {
    return res.status(429).json({
      matched: false,
      source: 'google_maps_place',
      error: '地址查詢忙碌中，請稍後再試',
    });
  }

  googleMapsPending += 1;
  try {
    const result = await enqueueGoogleMapsLookup(() => resolveGoogleMapsPlace(address));
    cacheGoogleMapsResult(
      cacheKey,
      result,
      result.matched ? GOOGLE_MAPS_CACHE_TTL_MS : GOOGLE_MAPS_NEGATIVE_CACHE_TTL_MS,
    );
    return res.json({ ...result, cached: false });
  } finally {
    googleMapsPending -= 1;
  }
});

// 2. 數位時間相機圖片防偽鋼印端點
app.post('/stamp', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: '找不到 image 圖片檔案',
      });
    }

    const {
      stampType = '救傷現場紀錄',
      stampTime = '',
      stampLocation = '',
      caseNumber = '',
    } = req.body;

    // 將包含 \n 的地址與經緯度拆分成獨立多行。Google Maps 的長網址
    // 不適合寫入圖片，也可能超出 Pango 文字圖層的寬度而讓合成失敗。
    const locRawLines = String(stampLocation || '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !/(?:google\s*maps|https?:\/\/)/i.test(line));
    const formattedLocLines = locRawLines.map(line => {
      return line
        .replace(/^[📍🧭🗺️]\s*/u, '')
        .replace(/^GPS\s*經緯度[：:]/, 'GPS：');
    });

    const stripEmoji = value => String(value || '')
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const lines = [
      stampType,
      stampTime ? `拍攝時間：${stampTime.replace(/^🕒\s*/, '')}` : '',
      ...formattedLocLines,
      caseNumber ? `案件編號：${caseNumber.replace(/^📋\s*/, '')}` : '',
    ].map(stripEmoji).filter(Boolean);

    const metadata = await sharp(req.file.buffer).metadata();
    const sourceWidth = metadata.width || 1200;
    const sourceHeight = metadata.height || 800;
    // EXIF 5–8 代表圖片顯示時會旋轉 90 度；先以實際顯示方向計算疊圖尺寸。
    const isSidewaysOrientation = [5, 6, 7, 8].includes(metadata.orientation);
    const orientedWidth = isSidewaysOrientation ? sourceHeight : sourceWidth;
    const orientedHeight = isSidewaysOrientation ? sourceWidth : sourceHeight;
    const scale = Math.min(1, STAMP_IMAGE_MAX_DIMENSION / Math.max(orientedWidth, orientedHeight));
    const width = Math.max(1, Math.round(orientedWidth * scale));
    const height = Math.max(1, Math.round(orientedHeight * scale));
    const image = sharp(req.file.buffer)
      .rotate()
      .resize(width, height, { fit: 'fill' });

    // 動態根據行數計算 SVG 疊加層高度與字體大小，確保多行換行 100% 完美呈現
    const lineCount = lines.length;
    const overlayHeight = Math.max(100, Math.min(380, Math.floor(height * 0.45)));
    const fontSize = Math.max(14, Math.min(30, Math.floor(overlayHeight / (lineCount + 1.2))));
    const lineSpacing = Math.max(22, Math.floor(overlayHeight / (lineCount + 0.5)));

    // 即使上游送來未被辨識的長字串，也絕不讓單一文字圖層超出底圖。
    // 中文一字最寬約等於 fontSize，保留邊界後計算安全字數。
    const maxCharsPerLine = Math.max(16, Math.floor((width - 70) / fontSize));
    const renderLines = lines.map(line => {
      const chars = Array.from(String(line));
      return chars.length > maxCharsPerLine
        ? `${chars.slice(0, maxCharsPerLine - 1).join('')}…`
        : line;
    });

    // 不使用 SVG 文字：其字型解析在 Render 上可能忽略專案的 fontconfig。
    // Sharp 的原生 text 輸入可直接指定字型檔絕對路徑，確保繁中一定使用內附字型。
    const textOverlay = await sharp({
      create: {
        width,
        height: overlayHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.78 },
      },
    })
      .composite(renderLines.map((text, index) => ({
        input: {
          text: {
            text: `<span foreground="white" font_weight="bold">${escapeXml(text)}</span>`,
            font: `${fontFamily} ${fontSize}px`,
            fontfile: fontFile,
            width: width - 60,
            height: lineSpacing,
            rgba: true,
          },
        },
        left: 30,
        top: Math.floor(lineSpacing * (index + 0.1)),
      })))
      .png()
      .toBuffer();

    const processedImage = await image
      .composite([
        {
          input: textOverlay,
          gravity: 'south',
        },
      ])
      .jpeg({
        quality: STAMP_JPEG_QUALITY,
        mozjpeg: true,
      })
      .toBuffer();

    // n8n 會將這個檔名帶往圖床；保留 .jpg 副檔名可讓 LINE 正確辨識返圖 MIME 類型。
    res
      .type('image/jpeg')
      .set('Content-Disposition', 'inline; filename="time-camera.jpg"')
      .send(processedImage);
  } catch (error) {
    console.error('圖片處理失敗:', error);
    res.status(500).json({
      error: '圖片處理失敗',
      message: error.message,
    });
  }
});

// Render Web Service 需要幫綁定 0.0.0.0 與讀取 PORT 環境變數
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Taoyuan Wildlife Rescue Image Stamp API running on port ${PORT}`);
});
