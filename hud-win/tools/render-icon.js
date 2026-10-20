'use strict';

/**
 * 把 SVG 渲染成多尺寸 PNG + ICO。
 *
 * 关键：圆角外的像素必须是**完全透明**（alpha=0），否则桌面会看到白点。
 *
 * Electron 的 capturePage 在透明窗口上会有两种情况：
 *   - offscreen 模式：透明区域可能被填成白色
 *   - 普通窗口 + transparent:true：alpha 正常保留
 * 这里用后者，并且**在任何情况下都对导出结果做一次圆角遮罩清理**作为兜底：
 * 把四角圆形半径之外的像素 alpha 强制置 0。双保险，不依赖平台行为。
 *
 * 用法：npx electron tools/render-icon.js
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const ASSETS = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const svgPath = path.join(ASSETS, 'app-icon.svg');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });

  // 用 HTML 包一层，页面背景设为透明
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;}
img{display:block;width:512px;height:512px;}</style></head>
<body><img src="file:///${svgPath.replace(/\\/g, '/')}"></body></html>`;

  const tmpHtml = path.join(app.getPath('temp'), 'icon-render.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 500));

  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });

  for (const size of SIZES) {
    const resized = img.resize({ width: size, height: size, quality: 'best' });
    let buf = resized.toPNG();

    // 兜底：清理圆角外的 alpha。
    // 所有尺寸都做 —— 早期只对 ≥48px 做，结果 24px 残留了 alpha=2 的边缘像素。
    // 圆角遮罩用的是与 SVG 相同的 radius 比例，不会削掉可见内容。
    buf = clearCorners(resized, size, 0.225);

    const out = path.join(ASSETS, `icon-${size}.png`);
    fs.writeFileSync(out, buf);
    console.log('生成 icon-' + size + '.png');
  }

  // 打包 ICO（7 个尺寸内嵌）
  buildIco();

  app.quit();
});

/**
 * 把圆角矩形之外的像素 alpha 归零。
 *
 * capturePage 给的是 NativeImage，这里走一遍 ImageData：
 * 转成位图的 RGBA buffer，逐像素判断是否在圆角矩形内。
 */
function clearCorners(nativeImage, size, radiusRatio) {
  const src = nativeImage.toBitmap(); // BGRA 顺序
  const rad = size * radiusRatio;
  const out = Buffer.from(src);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 判断点是否落在圆角矩形外
      let outside = false;
      const cx =
        x < rad ? rad : x > size - rad ? size - rad : -1;
      const cy =
        y < rad ? rad : y > size - rad ? size - rad : -1;
      if (cx >= 0 && cy >= 0) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > rad * rad) outside = true;
      }
      if (outside) {
        const i = (y * size + x) * 4;
        out[i + 3] = 0; // BGRA 的第 4 字节是 alpha
      }
    }
  }

  // 用 createFromBitmap 回写并转 PNG
  const { nativeImage: NI } = require('electron');
  const fixed = NI.createFromBitmap(out, { width: size, height: size });
  return fixed.toPNG();
}

/** ICO 容器：ICONDIR + 各尺寸条目 + PNG 数据（Vista+ 支持内嵌 PNG）。 */
function buildIco() {
  const entries = [];
  for (const s of SIZES) {
    const p = path.join(ASSETS, `icon-${s}.png`);
    if (fs.existsSync(p)) entries.push({ size: s, data: fs.readFileSync(p) });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2); // type = icon
  header.writeUInt16BE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16BE(1, 4);
    d.writeUInt16BE(32, 6);
    d.writeUInt32BE(e.data.length, 8);
    d.writeUInt32BE(offset, 12);
    offset += e.data.length;
    dirs.push(d);
  }

  const ico = Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);
  fs.writeFileSync(path.join(ASSETS, 'app-icon.ico'), ico);
  console.log('生成 app-icon.ico（' + entries.length + ' 尺寸，' + ico.length + ' 字节）');
}
