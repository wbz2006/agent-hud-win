'use strict';

/**
 * 压力回归：左侧竖条 → 拖到顶部 的「拖完变宽 bar、只剩三个圆环」复现器。
 *
 * 用户报告（2026-10-25）：从左侧停靠拖到上边时，有概率胶囊不收回收起态，
 * 而是变成一条宽 bar（内容只有三个圆环）。这是主进程 contentWidth 被悬停
 * 加宽值污染、且 hovering=false 的组合症状。
 *
 * CDP 注入不移动真实光标，主进程的悬停轮询（getCursorScreenPoint）进不了
 * 这条路径 —— 所以用 _realmouse.ps1 的 toLeft/toTop 相位驱动真光标复现，
 * CDP 只采样渲染层状态（不改窗口）。循环 N 次抓概率性竞态。
 *
 * 用法：先起开发实例（--remote-debugging-port=9227），node _toTopCheck.js 9227 [次数]
 */

const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');

const PORT = Number(process.argv[2] || 9227);
const ROUNDS = Number(process.argv[3] || 8);
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

function runPhase(phase) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '_realmouse.ps1', '-Phase', phase, '-Match', 'electron'],
      { cwd: __dirname }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', () => resolve(out));
  });
}

/** 把真实光标停到屏幕下方中央（悬停轮询判定"在外"），纯 ASCII 命令。 */
function parkCursor() {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public static class PC { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); }"; [void][PC]::SetCursorPos(1280, 1350)',
      ],
      { cwd: __dirname }
    );
    child.on('exit', resolve);
  });
}

async function snapshot(cdp) {
  return cdp.eval(`(() => ({
    t: Date.now(),
    cls: document.body.className,
    iw: innerWidth, ih: innerHeight,
    sx: window.screenX, sy: window.screenY,
    panelOpen: document.querySelector('#panel') ? document.querySelector('#panel').classList.contains('open') : false,
  }))()`);
}

function isStuckWide(s) {
  // 宽 bar + 无悬停类 + 面板没开 = 悬停宽度污染了收起态宽度
  return s.iw > 200 && !s.cls.includes('hovering') && !s.cls.includes('vertical') && !s.panelOpen;
}

async function main() {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((p) => p.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  await parkCursor();
  await sleep(800);

  let stuckCount = 0;
  const traces = [];
  for (let round = 1; round <= ROUNDS; round++) {
    // 1) 先回到左侧竖条（toLeft 相位把胶囊拖到左边缘）
    await runPhase('toLeft');
    await sleep(900);
    const sLeft = await snapshot(cdp);
    const leftOk = sLeft.cls.includes('vertical') && sLeft.iw <= 120;

    // 2) 从左侧拖到顶部（用户报告的触发手势），采样拖动全程
    const trace = [];
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          trace.push(await snapshot(cdp));
        } catch (_) {
          break;
        }
        await sleep(60);
      }
    })();
    const out = await runPhase('toTop');
    await sleep(600);
    stop = true;
    await sleep(150);

    // 3) 光标停远，等 RECOLLAPSE_MS 过后看最终态
    await parkCursor();
    await sleep(900);
    const sEnd = await snapshot(cdp);
    // 4) 再来一次真实的「悬停进入 → 移开」：用户松手后通常会动一下鼠标，
    //    悬停加宽/收窄这条最常走的路径必须也能收回收起态
    const hoverOut = await runPhase('hover');
    await sleep(300);
    const sHover = await snapshot(cdp);

    const stuck = isStuckWide(sEnd) || isStuckWide(sHover);
    if (stuck) stuckCount++;
    const cfg = (() => {
      try {
        const c = JSON.parse(
          fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^\uFEFF/, '')
        );
        return `dock=${c.dock} dockPos=${JSON.stringify(c.dockPos || {})}`;
      } catch {
        return 'config?';
      }
    })();
    console.log(
      `R${round}: left[${leftOk ? 'ok' : 'BAD ' + sLeft.cls + ' iw=' + sLeft.iw}] -> end ` +
        `cls="${sEnd.cls}" ${sEnd.iw}x${sEnd.ih} @${sEnd.sx},${sEnd.sy} ${cfg} ${stuck ? '  <== 卡在宽bar' : ''}`
    );
    if (stuck) traces.push({ round, out: out.trim(), trace });
    await sleep(400);
  }

  console.log(`\n==> ${ROUNDS - stuckCount}/${ROUNDS} 轮正常收起${stuckCount ? `，${stuckCount} 轮卡在宽 bar` : ''}`);
  for (const t of traces) {
    console.log(`\n--- R${t.round} 真鼠标脚本输出 ---`);
    console.log(t.out);
    console.log(`--- R${t.round} 拖动后 2s 内的采样（iw>150 或含 hovering） ---`);
    for (const s of t.trace) {
      if (s.iw > 150 || s.cls.includes('hovering')) {
        console.log(
          `t=${new Date(s.t).toLocaleTimeString('zh-CN', { hour12: false })} cls="${s.cls}" ${s.iw}x${s.ih} @${s.sx},${s.sy}`
        );
      }
    }
  }
  if (stuckCount) process.exitCode = 1;
  cdp.ws.close();
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
