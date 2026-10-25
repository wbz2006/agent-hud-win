'use strict';

/**
 * 探针：横排时收到"竖排悬停展开"（hoverGrow=true）必须被忽略。
 *
 * 复现渲染层朝向标记滞后时发出的那条请求：
 *   window.hud.expand(true, SIDE_THICKNESS, VERTICAL_HOVER_H, true)
 * 修复前它会走横排分支的完整展开（w ≥ PANEL_MIN_WIDTH、expanded=true），
 * 窗口被撑成一条宽 bar 且此后所有测量都不再改尺寸。
 *
 * 用法：node _expandprobe.js 9228
 */

const http = require('http');

const PORT = Number(process.argv[2] || 9228);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(d));
      })
      .on('error', rej);
  });

async function main() {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((p) => p.type === 'page');
  if (!page) throw new Error('没有页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result);
      pend.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const ev = (expr) =>
    new Promise((r) => {
      const i = ++id;
      pend.set(i, r);
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression: expr, returnByValue: true, awaitPromise: true },
        })
      );
    });
  const state = async () => {
    const r = await ev(`(() => {
      const p = document.querySelector('#panel');
      return { iw: innerWidth, ih: innerHeight, cls: document.body.className, open: !!(p && p.classList.contains('open')) };
    })()`);
    return r.result.value;
  };

  const before = await state();
  console.log('before ', JSON.stringify(before));
  await ev('window.hud.expand(true, 52, 245, true)');
  await sleep(700);
  const after = await state();
  console.log('after  ', JSON.stringify(after));
  const ok = after.iw <= 200 && after.ih === 48 && !after.cls.includes('hovering');
  console.log(ok ? 'PASS  横排忽略 hoverGrow（窗口仍是胶囊）' : 'FAIL  窗口被撑成宽 bar');
  await ev('window.hud.expand(false, 52, 130, true)');
  await sleep(500);
  console.log('cleanup', JSON.stringify(await state()));
  ws.close();
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
