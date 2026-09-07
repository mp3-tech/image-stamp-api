const { join } = require('path');

/** @type {import('puppeteer').Configuration} */
module.exports = {
  // Render 的建置與執行環境不同；把瀏覽器放在專案的 node_modules 內，
  // 才會隨建置產物一起部署，而不是遺失在建置帳號的家目錄快取中。
  cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
  // 服務只使用無頭瀏覽器，無須下載完整桌面版 Chrome。
  chrome: {
    skipDownload: true,
  },
  'chrome-headless-shell': {
    skipDownload: false,
  },
};
