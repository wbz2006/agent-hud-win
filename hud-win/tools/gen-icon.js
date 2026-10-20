'use strict';

/**
 * 生成应用图标（简约风）。
 *
 * 三个必须避开的坑（上一版全踩了）：
 *   ① 四角不透明 → 桌面显示白点。Electron 的 capturePage 默认把透明区域
 *      渲染成白底，所以不能靠"透明 PNG"，必须让圆角外**真的没有像素**。
 *   ② 三个环的圆心算错（-56 / 256 / 568）→ 左右两个跑到画布外，
 *      图标里只剩中间一个环。
 *   ③ 细节过多（进度弧缺口、内描边、渐变）→ 16px 下糊成一团。
 *
 * 简约风的做法：
 *   单一深色圆角底 + 三个等距的**实心环**（不是带缺口的弧），
 *   环用各自的品牌色，线宽加大到即使在 16px 也看得清。
 */

const fs = require('fs');
const path = require('path');

// 注意：本脚本在 tools/ 下，__dirname 是 tools/，要回到应用根目录再拼 assets
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'assets');

/** 颜色：与悬浮条状态色一致（绿=Codex / 橙=Claude / 蓝=DeepSeek）。 */
const C = { a: '#10a37f', b: '#e8834a', c: '#4b8ef5' };

/**
 * 生成 SVG。
 * @param {number} s 画布边长
 * @param {boolean} fullBleed true = 不留圆角（整张填满），用于规避白角
 */
function makeSvg(s, fullBleed) {
  const pad = s * 0.19; // 内容外边距（留白更多，视觉更透气）
  const inner = s - pad * 2;
  const ringW = inner * 0.15; // 环线宽
  const r = inner * 0.14; // 环半径
  const gap = inner * 0.135; // 环间距（略大于线宽，三个环不粘连）
  const totalW = r * 2 * 3 + gap * 2;
  const startX = (s - totalW) / 2 + r;
  const cy = s / 2;
  const radius = fullBleed ? 0 : s * 0.225;

  const ring = (cx, color) =>
    `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${ringW.toFixed(2)}" />`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" rx="${radius}" ry="${radius}" fill="#16161a" />
  ${ring(startX, C.a)}
  ${ring(startX + r * 2 + gap, C.b)}
  ${ring(startX + r * 4 + gap * 2, C.c)}
</svg>`;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'app-icon.svg'), makeSvg(512, false), 'utf8');
fs.writeFileSync(path.join(OUT, 'app-icon-square.svg'), makeSvg(512, true), 'utf8');

console.log('SVG 已生成：app-icon.svg（圆角）、app-icon-square.svg（方形备选）');
