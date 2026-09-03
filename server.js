const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const app = express();

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

    // 將包含 \n 的地址與經緯度拆分成獨立多行
    const locRawLines = String(stampLocation || '').split('\n').map(l => l.trim()).filter(Boolean);
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

    const svg = `
      <svg
        width="${width}"
        height="${overlayHeight}"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.78)"
        />
        ${lines.map((text, index) => `
          <text
            x="30"
            y="${Math.floor(lineSpacing * (index + 0.9))}"
            font-family="Arial, 'Microsoft JhengHei', sans-serif"
            font-size="${fontSize}"
            font-weight="bold"
            fill="white"
          >
            ${escapeXml(text)}
          </text>
        `).join('')}
      </svg>
    `;

    const processedImage = await image
      .composite([
        {
          input: Buffer.from(svg),
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
