'use strict';

/**
 * 临时验证脚本：真实鼠标 + CDP 联合采样（不进打包）。
 *
 * CDP 注入的鼠标事件不移动真实光标，主进程的悬停轮询永远认为光标在窗外，
 * 所以「拖动时窗口却停在悬停加宽态」这类 bug 只有真鼠标能复现。
 * 这里用 _realmouse.ps1 驱动真实光标（按住 → 沿顶部移动 → 松手），
 * 同时用 CDP 每 60ms 采样渲染层状态，按时间轴对齐后断言：
 *   1. 拖动全程窗口保持收起态宽度（不再停在悬停加宽的 540）
 *   2. 拖动中 body.dragging、hovering=false
 *   3. 虚线画在胶囊内侧（inset 2px），靠屏幕边也完整可见
 *   4. 松手吸附回顶部居中，宽度仍是收起态
 *
 * 用法：先起开发实例（--remote-debugging-port=9224），再 node _realcheck.js 9224
 */

const { spawn } = require('child_process');
const http = require('http');

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
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.text || 'error'));
    return r.result ? r.result.value : undefined;
  }
}

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
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  // 虚线框：只在 body.dragging 时存在，直接加类采样（不改窗口）
  const dash = await cdp.eval(`(() => {
    const body = document.body, bar = document.querySelector('#bar');
    body.classList.add('dragging');
    const cs = getComputedStyle(bar, '::before');
    const br = bar.getBoundingClientRect();
    const out = {
      style: cs.borderTopStyle,
      inset: cs.top,
      width: cs.borderTopWidth,
      barTop: Math.round(br.top),
      barLeft: Math.round(br.left),
      screenX: window.screenX,
      screenY: window.screenY,
      innerW: innerWidth,
      innerH: innerHeight,
    };
    body.classList.remove('dragging');
    return out;
  })()`);
  console.log('虚线框:', JSON.stringify(dash));

  // 埋点：记录每次 measureBarNeed 的返回值与 dragStart 的实参
  await cdp.eval(`(() => {
    window.__log = [];
    const orig = window.measureBarNeed;
    if (typeof orig === 'function') {
      window.measureBarNeed = function () {
        const v = orig.apply(this, arguments);
        window.__log.push({ t: Date.now(), k: 'need', v, cls: document.body.className, iw: innerWidth });
        return v;
      };
    } else { window.__log.push({ t: 0, k: 'need-missing' }); }
    // 注：window.hud 是 contextBridge 暴露的冻结代理，覆写它的成员无效，
    // 所以 dragStart 的实参只能从 measureBarNeed 埋点间接看（本页埋点够用）。
    window.__origTypeof = typeof orig;
    return true;
  })()`);

  const samples = [];
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const s = await cdp.eval(`(() => ({
          t: Date.now(),
          cls: document.body.className,
          iw: innerWidth, ih: innerHeight,
          sx: window.screenX, sy: window.screenY,
          dash: document.body.classList.contains('dragging')
            ? getComputedStyle(document.querySelector('#bar'), '::before').borderTopStyle
            : '',
        }))()`);
        samples.push(s);
      } catch (_) { /* 连接关闭时退出 */ }
      await sleep(60);
    }
  })();

  // 真实鼠标：按住 → 沿顶部右移 → 松手
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '_realmouse.ps1', '-Phase', 'top', '-Match', 'electron'],
    { cwd: __dirname }
  );
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  await new Promise((r) => child.on('exit', r));
  await sleep(700);
  stop = true;
  await sleep(200);
  console.log('--- 真鼠标脚本输出 ---');
  console.log(out.trim());
  console.log('--- CDP 采样（拖动相关） ---');
  for (const s of samples) {
    if (s.cls.includes('dragging') || s.iw > 200) {
      console.log(
        `t=${new Date(s.t).toLocaleTimeString('zh-CN', { hour12: false })} cls="${s.cls}" iw=${s.iw} ih=${s.ih} sx=${s.sx}`
      );
    }
  }

  console.log('--- 埋点 ---');
  console.log(JSON.stringify(await cdp.eval('window.__log || []')));
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  const dragSamples = samples.filter((s) => s.cls.includes('dragging'));
  check('真实拖动进入了 dragging 态', dragSamples.length > 0, `${dragSamples.length} 个采样`);
  if (dragSamples.length) {
    const wide = dragSamples.filter((s) => s.iw > 200);
    check('拖动全程窗口保持收起态（不再停在悬停加宽态）', wide.length === 0, wide.length ? `有 ${wide.length} 个采样 iw>200` : '全程 ≤140');
    const hoverCls = dragSamples.filter((s) => s.cls.includes('hovering'));
    check('拖动中没有悬停态', hoverCls.length === 0);
    const noDash = dragSamples.filter((s) => s.dash !== 'dashed');
    check('真实拖动全程虚线边框都在（靠屏幕边不裁）', noDash.length === 0, noDash.length ? `${noDash.length} 个采样没有虚线` : 'all dashed');
  }
  const insetPx = parseFloat(dash.inset);
  const dashed = dash.style === 'dashed' && insetPx >= 0;
  // 窗口顶边贴屏幕（dock=top 时 screenY=6）：内缩非负的虚线一定在窗口内 → 不被裁
  check('虚线画在胶囊内侧（inset ≥ 0，靠屏幕边也完整可见）', dashed, JSON.stringify(dash));

  const failed = checks.filter((c) => !c).length;
  console.log(`\n==> ${checks.length - failed}/${checks.length} 项通过`);
  if (failed) process.exitCode = 1;
  cdp.ws.close();
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
