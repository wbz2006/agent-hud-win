'use strict';

/**
 * 拖动吸附的实机验证脚本（开发工具；不进打包，pack.js 排除 /^[/\\]_.*\.(js|ps1|py)$/）。
 *
 * 通过 CDP 往渲染进程注入真实鼠标事件，验证「按住拖胶囊 → 吸附到最近的边」：
 *   A. 单击（按住不动）不移动胶囊、不改停靠边
 *   B. 按在按钮上不进入拖动；位移不足 6px 不算拿起
 *   C. 越过阈值拿起：body.dragging、::before 虚线、hovering 清掉、窗口落回收起态
 *   D. 拖动跟手（window.screenX 变化量 ≈ 鼠标位移）
 *   E. 拖到左边缘中途就地翻成竖条，松手 dock=left、贴左边垂直居中
 *   F. 从左侧竖条拖回顶部：翻回横条，松手 dock=top、顶部居中
 *
 * 用法：先起开发实例（Remove-Item Env:ELECTRON_RUN_AS_NODE; electron.exe
 *   --no-sandbox --disable-gpu --user-data-dir=$env:TEMP\hud-dev
 *   --remote-debugging-port=9224 .），再 node _dragcheck.js 9224 A|B。
 *
 * 两个必须知道的坑：
 *   1. CDP 注入的鼠标事件 screenX == 客户端坐标（实测），一次手势内位移上限
 *      就是一个窗口宽度 —— 跨半屏拖动改用页面内合成 PointerEvent（渲染层只读
 *      e.screenX/screenY，走同一条代码路径，见 jsDrag）。短手势仍用真实事件。
 *   2. 合成事件不动真实光标，主进程悬停轮询永远认为光标在窗外 —— 需要悬停态
 *      时先移到窗外再移回来，靠 DOM mouseenter 恢复（见 reenter）。
 *
 * 脚本会改 config.json 的 dock 字段（验证吸附落盘），跑完记得改回 top。
 */

const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9224);
const PHASE = process.argv[3] || 'A';
// 打包版会把 config.json 放在 exe 同级，验证打包产物时用 HUD_CFG 指过去
const CFG = process.env.HUD_CFG || path.join(__dirname, 'config.json');

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
  mouse(type, x, y, buttons) {
    return this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: buttons || 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
}

const http = require('http');
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

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 读窗口与胶囊的当前状态（screenX/screenY 是窗口左上角）。 */
async function geom(cdp) {
  return cdp.eval(`(() => {
    const b = document.querySelector('#bar').getBoundingClientRect();
    const dx = document.querySelector('#expandBtn').getBoundingClientRect();
    const cls = document.body.className;
    return {
      sx: window.screenX, sy: window.screenY, iw: innerWidth, ih: innerHeight,
      aw: screen.availWidth, bx: b.x, by: b.y, bw: b.width, bh: b.height,
      dragging: cls.includes('dragging'),
      hovering: cls.includes('hovering'),
      vertical: cls.includes('vertical'),
      panelLeft: cls.includes('panel-left'),
      panelOpen: cls.includes('panel-open'),
      dx: { x: Math.round(dx.x + dx.width / 2), y: Math.round(dx.y + dx.height / 2) },
    };
  })()`);
}

/** 胶囊可见部分与视口的交集中心 —— 保证按下去的坐标落在胶囊上。 */
async function pressPoint(cdp) {
  return cdp.eval(`(() => {
    const b = document.querySelector('#bar').getBoundingClientRect();
    const loX = Math.max(2, b.x + 4), hiX = Math.min(innerWidth - 2, b.x + b.width - 4);
    const loY = Math.max(2, b.y + 4), hiY = Math.min(innerHeight - 2, b.y + b.height - 4);
    return {
      x: hiX >= loX ? Math.round((loX + hiX) / 2) : Math.round(innerWidth / 2),
      y: hiY >= loY ? Math.round((loY + hiY) / 2) : Math.round(innerHeight / 2),
      bar: { x: b.x, y: b.y, w: b.width, h: b.height }, iw: innerWidth, ih: innerHeight,
    };
  })()`);
}

const cfgDock = () => {
  try {
    return JSON.parse(fs.readFileSync(CFG, 'utf8')).dock;
  } catch (_) {
    return '(读不到)';
  }
};

/** 悬停态恢复：CDP 不动真实光标，主进程轮询看不到，只能靠 DOM mouseenter。 */
async function reenter(cdp, g) {
  await cdp.mouse('mouseMoved', g.iw + 120, g.ih + 120, 0);
  await sleep(140);
  await cdp.mouse('mouseMoved', Math.round(g.bx + g.bw / 2), Math.round(g.by + g.bh / 2), 0);
  await sleep(320);
}

/**
 * 按住并连续拖动：每步位移由 deltas 给出，**派发坐标恒为 press + 该步位移**。
 *
 * 为什么不是累加坐标：CDP 会丢弃落在窗口外的鼠标事件，而胶囊一直跟在指针
 * 底下 —— 窗口自己也在移动，所以「每步偏移固定的小坐标」就能让窗口持续移动
 * （delta = 上一步窗口位置差），一路拖到屏幕边缘也不会跑出窗口外。
 */
/**
 * 长距离拖动用**页面内合成 PointerEvent**（screenX 是真实屏幕坐标）。
 *
 * 为什么不用 CDP 注入：CDP 派发的鼠标事件 screenX == 客户端坐标（探针实测），
 * 一次手势内指针最多移动一个窗口的宽度，跨半屏的拖动根本模拟不出来。
 * 渲染层的拖动逻辑只读 e.screenX/screenY 和 pointerId，合成事件走的是
 * 同一条代码路径（pointerdown → 拿起 → 增量 → dragEnd）。
 */
async function jsDrag(cdp, to, steps, onStep) {
  await cdp.eval(`(() => {
    window.__fire = (type, sx, sy) => {
      const el = document.querySelector('#bar');
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerup' ? 0 : 1,
        screenX: sx, screenY: sy,
        clientX: sx - window.screenX, clientY: sy - window.screenY,
      }));
    };
  })()`);
  const g = await geom(cdp);
  const start = { x: g.sx + g.bw / 2, y: g.sy + g.bh / 2 };
  await cdp.eval(`window.__fire('pointerdown', ${start.x}, ${start.y})`);
  await sleep(120);
  let last = start;
  for (let i = 1; i <= steps; i++) {
    last = {
      x: Math.round(start.x + ((to.x - start.x) * i) / steps),
      y: Math.round(start.y + ((to.y - start.y) * i) / steps),
    };
    await cdp.eval(`window.__fire('pointermove', ${last.x}, ${last.y})`);
    await sleep(110);
    if (onStep) await onStep(i, last);
  }
  await cdp.eval(`window.__fire('pointerup', ${last.x}, ${last.y})`);
  await sleep(500);
}

/** 等窗口尺寸稳定（收起态）：启动后首帧会把默认宽收到内容宽。 */
async function waitCollapsed(cdp, ms) {
  const until = Date.now() + (ms || 3000);
  for (;;) {
    const g = await geom(cdp);
    if (g.iw <= 170) return g;
    if (Date.now() > until) return g;
    await sleep(120);
  }
}

/** 等悬停加宽生效（hovering → 量宽 → 主进程改窗口是异步的，不能立刻读）。 */
async function waitWidened(cdp, ms) {
  const until = Date.now() + (ms || 2500);
  for (;;) {
    const g = await geom(cdp);
    if (g.iw > 200) return g;
    if (Date.now() > until) return g;
    await sleep(120);
  }
}

async function main() {
  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find((p) => p.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  let g = await geom(cdp);
  console.log('初始:', JSON.stringify(g));

  if (PHASE === 'A') {
    // ---- A. 按住不动再松手：不换边、不位移 ----
    /*
     * 拿起会让主进程立刻把窗口从悬停加宽收回收起宽度（这是修过两次的行为），
     * 所以"悬停时的位置"不能当基准：松开后应回到**顶部居中的收起态矩形**上。
     * 这里直接按"收起态 + 顶边居中"的几何判据断言，不依赖按下前的状态。
     */
    let press = await pressPoint(cdp);
    await cdp.mouse('mouseMoved', press.x, press.y, 0);
    const hovered = await waitWidened(cdp);
    check('悬停把胶囊加宽（统计与按钮露出来）', hovered.iw > 200, `innerWidth=${hovered.iw}`);
    press = await pressPoint(cdp);
    await cdp.mouse('mousePressed', press.x, press.y, 1);
    await sleep(450);
    await cdp.mouse('mouseReleased', press.x, press.y, 0);
    await sleep(500);
    let g = await geom(cdp);
    const expectX = (g.aw - g.iw) / 2;
    check(
      '按住 450ms 不动再松手：回到顶部居中的收起态（不算拖动）',
      g.iw <= 170 && g.sy === 6 && Math.abs(g.sx - expectX) <= 2,
      `${g.sx},${g.sy} w${g.iw}（期望 x≈${Math.round(expectX)} y=6 且 w≤170）`
    );
    check('按住不动再松手：停靠边不变（慢速单击不算拖动）', cfgDock() === 'top', 'dock=' + cfgDock());
    check('单击后没有 dragging 残留', g.dragging === false);

    // ---- B. 按钮不参与拖动 ----
    await reenter(cdp, g);
    await waitWidened(cdp);
    /*
     * 加宽过程中 .bar 的 width 过渡还没走完时，flex 末端溢出会把按钮摆到
     * 负坐标（实测 -22），等布局稳定再取按钮位置。
     */
    await sleep(380);
    g = await geom(cdp);
    check('悬停后 ☰ 按钮有实际尺寸', g.dx.x >= 0 && g.dx.y > 0, `button@${g.dx.x},${g.dx.y} w${g.iw}`);
    await cdp.mouse('mouseMoved', g.dx.x, g.dx.y, 0);
    await sleep(120);
    await cdp.mouse('mousePressed', g.dx.x, g.dx.y, 1);
    await cdp.mouse('mouseMoved', g.dx.x + 20, g.dx.y, 1);
    await sleep(120);
    g = await geom(cdp);
    check('按在按钮上移动不进入拖动', g.dragging === false);
    await cdp.mouse('mouseReleased', g.dx.x + 20, g.dx.y, 0);
    await sleep(350);
    if (await cdp.eval(`document.querySelector('#panel').classList.contains('open')`)) {
      await cdp.eval(`(() => { const b = document.querySelector('#expandBtn').getBoundingClientRect(); window.dispatchEvent(new Event('blur')); return [b.x, b.y]; })()`);
      await sleep(300);
    }

    // ---- C/D. 阈值 + 拿起 + 跟手 ----
    await reenter(cdp, await geom(cdp));
    g = await geom(cdp);
    press = await pressPoint(cdp);
    const startX = g.sx;
    await cdp.mouse('mousePressed', press.x, press.y, 1);
    await sleep(60);
    await cdp.mouse('mouseMoved', press.x + 4, press.y + 1, 1);
    await sleep(90);
    g = await geom(cdp);
    check('位移不足 6px 还不算拿起', g.dragging === false);

    await cdp.mouse('mouseMoved', press.x + 12, press.y + 2, 1);
    await sleep(160);
    g = await geom(cdp);
    const dashed = await cdp.eval(
      `getComputedStyle(document.querySelector('#bar'), '::before').borderTopStyle`
    );
    check('越过 6px 后进入拖动（body.dragging）', g.dragging === true);
    check('拖动中边框为虚线', dashed === 'dashed', 'borderTopStyle=' + dashed);
    check('拖动中清掉了悬停态（胶囊不被撑宽）', g.hovering === false);
    check('拖动中窗口落回收起态（innerHeight=48）', Math.round(g.ih) === 48, 'innerHeight=' + g.ih);
    check('顶部横条拖动中仍是横排（body.vertical=false）', g.vertical === false);

    const beforeMove = g.sx;
    await cdp.mouse('mouseMoved', press.x + 52, press.y + 3, 1);
    await sleep(220);
    g = await geom(cdp);
    check('胶囊跟手移动（screenX 变化 ≈ 40px）', Math.abs(g.sx - beforeMove - 40) <= 6, `${beforeMove} → ${g.sx}`);

    await cdp.mouse('mouseReleased', press.x + 52, press.y + 3, 0);
    await sleep(450);
    g = await geom(cdp);
    check('松手后 dragging 消失', g.dragging === false);
    check('顶部小位移松手后仍停靠顶部', cfgDock() === 'top', 'dock=' + cfgDock());
    // 吸附回顶部居中：x = 工作区中心 - 胶囊宽/2
    const centered = Math.abs(g.sx - Math.round((1707 - Math.round(g.bw)) / 2)) <= 3;
    check('松手吸附回顶部居中', centered, `screenX=${g.sx} 期望≈${Math.round((1707 - Math.round(g.bw)) / 2)}`);
  }

  if (PHASE === 'B') {
    // ---- E/F. 顶部横条拖到左边缘：中途翻竖条，松手吸附左侧 ----
    check('起始在顶部横排', g.vertical === false && cfgDock() === 'top', `vertical=${g.vertical} dock=${cfgDock()}`);
    await reenter(cdp, g);
    g = await geom(cdp);

    // 目标：屏幕左边缘中部（工作区约 1707×1019）
    let flipped = null;
    const seen = [];
    await jsDrag(
      cdp,
      { x: 30, y: 500 },
      12,
      async (_i, _pt) => {
        const s = await geom(cdp);
        seen.push({ x: s.sx, y: s.sy, iw: s.iw, ih: s.ih, v: s.vertical });
        if (!flipped && s.vertical) flipped = s;
      }
    );
    g = await geom(cdp);
    console.log('拖动采样:', JSON.stringify(seen));
    check('拖动过程中翻成过竖排（body.vertical）', !!flipped, flipped ? `于 x=${flipped.x}` : '从未翻转');
    check('松手时是竖排', g.vertical === true, 'vertical=' + g.vertical);
    check('松手写盘 dock=left', cfgDock() === 'left', 'dock=' + cfgDock());
    check('吸附到左边缘（screenX=6）', Math.abs(g.sx - 6) <= 2, 'screenX=' + g.sx);
    check('左侧竖条垂直居中', Math.abs(g.sy - Math.round((1019 - 130) / 2)) <= 3, 'screenY=' + g.sy);
    check('松手后胶囊宽度 = 竖条厚（52）', Math.round(g.bw) === 52, 'barWidth=' + g.bw);
    const anchor = await cdp.eval(`(async () => (await window.hud.getLayout()).anchor)()`);
    check('左停靠时面板朝屏幕内（anchor=right）', anchor === 'right', 'anchor=' + anchor);

    // ---- G. 从左侧竖条拖回顶部：翻回横条，松手吸附顶部 ----
    await reenter(cdp, g);
    g = await geom(cdp);
    let flippedBack = null;
    await jsDrag(
      cdp,
      { x: 850, y: 60 },
      12,
      async () => {
        const s = await geom(cdp);
        if (!flippedBack && !s.vertical) flippedBack = s;
      }
    );
    g = await geom(cdp);
    check('拖回顶部过程中翻回过横排', !!flippedBack, flippedBack ? `于 x=${flippedBack.x}` : '从未翻转');
    check('松手写盘 dock=top', cfgDock() === 'top', 'dock=' + cfgDock());
    check('吸附回顶部（screenY=6）', Math.abs(g.sy - 6) <= 2, 'screenY=' + g.sy);
    check('顶部居中', Math.abs(g.sx - Math.round((1707 - Math.round(g.bw)) / 2)) <= 3, `screenX=${g.sx} 期望≈${Math.round((1707 - Math.round(g.bw)) / 2)}`);
    check('松手后是横排（body.vertical=false）', g.vertical === false);
    check('松手后窗口高度 = 栏高（48）', Math.round(g.ih) === 48, 'innerHeight=' + g.ih);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n==> ${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length) {
    console.log('失败项:', failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
  }
  cdp.ws.close();
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
