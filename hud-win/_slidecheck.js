'use strict';

/**
 * 临时诊断脚本（用完即删）：模拟用户「按住后连续小幅左右滑动」，
 * 逐帧记录 innerWidth / screenX，看胶囊会不会越滑越宽。
 *
 * 用页面内合成 PointerEvent（渲染层只读 e.screenX/screenY，走同一条代码路径），
 * 因为 CDP 注入的鼠标事件 screenX 等于 clientX，滑不出窗口宽度。
 *
 * 用法：node _slidecheck.js 9224
 */

const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9224);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((r) => this.ws.addEventListener('open', r));
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }
}

const EXPERIMENT = `(async () => {
  const bar = document.querySelector('#bar');
  const b = bar.getBoundingClientRect();
  const x0 = Math.round(b.x + b.width / 2);
  const y0 = Math.round(b.y + b.height / 2);
  const mk = (type, sx, buttons) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    button: 0, buttons, clientX: x0, clientY: y0, screenX: sx, screenY: 400,
  });
  const series = [];
  const snap = (tag, i, sx) => series.push({
    tag, i, sx, iw: innerWidth, ih: innerHeight, wx: screenX,
    cls: document.body.className,
    bw: Math.round(document.querySelector('#bar').getBoundingClientRect().width),
  });

  snap('init', -1, 800);
  bar.dispatchEvent(mk('pointerdown', 800, 1));
  await new Promise((r) => setTimeout(r, 420));
  snap('armed', 0, 800);

  let sx = 800;
  for (let i = 1; i <= 120; i++) {
    const pass = Math.floor((i - 1) / 40);
    const dir = pass % 2 === 0 ? 1 : -1;
    sx += dir * 3;
    bar.dispatchEvent(mk('pointermove', sx, 1));
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)));
    if (i % 4 === 0) snap('move', i, sx);
  }
  bar.dispatchEvent(mk('pointerup', sx, 0));
  await new Promise((r) => setTimeout(r, 500));
  snap('release', 999, sx);
  return JSON.stringify(series);
})()`;

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page 目标');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  const rows = JSON.parse(await cdp.eval(EXPERIMENT));

  const w = rows.map((r) => r.iw);
  console.log('宽度序列 innerWidth：', w.join(' '));
  console.log('窗口 screenX：      ', rows.filter((_, i) => i % 3 === 0).map((r) => r.wx).join(' '));
  const widths = rows.map((r) => r.iw);
  const uniq = [...new Set(widths)];
  console.log('不同宽度值：', uniq.join(' / '), ' 最大=', Math.max(...widths), ' 最小=', Math.min(...widths));
  const grow = Math.max(...widths) - Math.min(...widths);
  console.log(grow > 4 ? `✗ 宽度变化 ${grow}px（越滑越宽）` : `✓ 宽度稳定（变化 ${grow}px）`);
  const tail = rows.slice(-4);
  console.log('末尾状态：', JSON.stringify(tail));
  fs.writeFileSync(path.join(__dirname, '_slidecheck.json'), JSON.stringify(rows, null, 1), 'utf8');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e && e.message);
  process.exit(1);
});
