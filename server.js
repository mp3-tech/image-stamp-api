const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');

const app = express();

// Render 的 Linux 容器不含繁中字型。將 Noto Sans CJK TC 隨專案部署，
// 並讓 Sharp/libvips 透過 fontconfig 找到它，避免中文被渲染成方框。
const fontFamily = 'Noto Sans CJK TC';
const fontFile = path.join(__dirname, 'fonts', 'NotoSansCJKtc-Regular.otf');

const upload = multer({
  storage: multer.memoryStorage(),
});

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
    timestamp: new Date().toISOString()
  });
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
      stampType = '📸 救傷現場紀錄',
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
      if (line.startsWith('📍') || line.startsWith('🧭') || line.startsWith('🗺️')) {
        return line;
      }
      return `📍 ${line}`;
    });

    const lines = [
      stampType,
      stampTime ? `🕒 拍攝時間：${stampTime.replace(/^🕒\s*/, '')}` : '',
      ...formattedLocLines,
      caseNumber ? `📋 案件編號：${caseNumber.replace(/^📋\s*/, '')}` : '',
    ].filter(Boolean);

    const image = sharp(req.file.buffer);
    const metadata = await image.metadata();
    const width = metadata.width || 1200;
    const height = metadata.height || 800;

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
        quality: 92,
      })
      .toBuffer();

    res.type('image/jpeg').send(processedImage);
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
