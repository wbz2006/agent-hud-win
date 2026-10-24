'use strict';

/**
 * 拖动吸附（胶囊在上/左/右三条边之间移动）+ 横竖切换的几何与接线测试。
 *
 * 对应原 macOS 项目的 HUDDragWindowController：
 * 按住左键 → 拿起（虚线边框）→ 跟手移动 → 松手吸附到最近的一条边。
 * 与 macOS 版的差别：不保留任意坐标，胶囊只停靠在顶部横条与左右竖条。
 *
 * 这一组的重点：
 *   · 吸附边判定（离胶囊中心最近的上/左/右）
 *   · 横↔竖就地翻转时**以中心为基准**，胶囊不会横漂或竖飘
 *   · 停靠矩形与展开方向一一对应（顶→下、左→右、右→左）
 *   · 拖到屏幕边缘时窗口被夹回工作区，而不是飞出去
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const geo = require('../src/main/drag.js');

/** 1920×1040 的可用区，从 y=40 起（任务栏在顶部的情形）。 */
const WA = { x: 0, y: 40, width: 1920, height: 1040 };
const DIMS = { barW: 200, barH: 48, sideW: 52, runH: 130 };

/* ============================================================
 * 一、几何
 * ============================================================ */

test('clampPos：负坐标与越界坐标都被夹回工作区，且留 6px 边距', () => {
  assert.deepEqual(geo.clampPos(-100, -100, 420, 48, WA), { x: 6, y: 46 });
  assert.deepEqual(geo.clampPos(5000, 5000, 420, 48, WA), { x: 1494, y: 1026 });
});

test('clampPos：窗口比工作区还大时贴左上角，不产生负数', () => {
  const p = geo.clampPos(300, 300, 3000, 2000, WA);
  assert.equal(p.x, 6);
  assert.equal(p.y, 46);
});

test('isVertical：只有左右两条边是竖排', () => {
  assert.equal(geo.isVertical('top'), false);
  assert.equal(geo.isVertical('left'), true);
  assert.equal(geo.isVertical('right'), true);
});

test('anchorOf：顶→面板朝下、左→朝右、右→朝左', () => {
  assert.equal(geo.anchorOf('top'), 'down');
  assert.equal(geo.anchorOf('left'), 'right');
  assert.equal(geo.anchorOf('right'), 'left');
});

test('zoneOf：顶部横条贴在顶边时判成 top', () => {
  assert.equal(geo.zoneOf({ x: 800, y: 46, width: 200, height: 48 }, WA), 'top');
});

test('zoneOf：拖到左/右半边中部就翻成 left / right', () => {
  assert.equal(geo.zoneOf({ x: 6, y: 500, width: 52, height: 130 }, WA), 'left');
  assert.equal(geo.zoneOf({ x: 1862, y: 500, width: 52, height: 130 }, WA), 'right');
});

test('zoneOf：左右边各占半屏，中线附近才归顶部', () => {
  // 屏幕正中（x 中心 960，y 中心 560）：到顶边 520、到左右边各 960 → 顶
  assert.equal(geo.zoneOf({ x: 860, y: 536, width: 200, height: 48 }, WA), 'top');
  // 上半屏偏左：到左边 300 < 到顶边 400 → left
  assert.equal(geo.zoneOf({ x: 250, y: 400, width: 200, height: 48 }, WA), 'left');
  // 上半屏偏右：到右边更近 → right
  assert.equal(geo.zoneOf({ x: 1500, y: 400, width: 200, height: 48 }, WA), 'right');
});

test('zoneOf：底部没有第四种归宿 —— 靠哪条侧边就归哪条', () => {
  assert.equal(geo.zoneOf({ x: 100, y: 1000, width: 200, height: 48 }, WA), 'left');
  assert.equal(geo.zoneOf({ x: 1650, y: 1000, width: 200, height: 48 }, WA), 'right');
  // 屏幕正下方：到左右边（960）比到顶边（984）还近 → 吸附到左侧，由 dLeft<=dRight 定
  assert.equal(geo.zoneOf({ x: 860, y: 1000, width: 200, height: 48 }, WA), 'left');
});

test('pillSize：横条用内容宽，竖条用条厚/条长', () => {
  assert.deepEqual(geo.pillSize(false, DIMS), { width: 200, height: 48 });
  assert.deepEqual(geo.pillSize(true, DIMS), { width: 52, height: 130 });
});

test('pillRect：以中心为基准摆胶囊 —— 横条翻竖条时中心不动', () => {
  const h = geo.pillRect(900, 400, false, DIMS, WA);
  const v = geo.pillRect(900, 400, true, DIMS, WA);
  assert.deepEqual(h, { x: 800, y: 376, width: 200, height: 48 });
  assert.deepEqual(v, { x: 874, y: 335, width: 52, height: 130 });
  // 两个矩形的中心点必须重合，否则翻转时胶囊会漂
  assert.equal(h.x + h.width / 2, v.x + v.width / 2);
  assert.equal(h.y + h.height / 2, v.y + v.height / 2);
});

test('pillRect：靠边翻转时被夹回工作区，中心允许偏移', () => {
  const v = geo.pillRect(10, 400, true, DIMS, WA);
  assert.equal(v.x, 6); // 贴左边距
  assert.equal(v.y, 335);
});

test('dockedRect：顶部居中 + 距顶 6px', () => {
  assert.deepEqual(geo.dockedRect('top', WA, DIMS), { x: 860, y: 46, width: 200, height: 48 });
});

test('dockedRect：左侧竖条贴左边、垂直居中', () => {
  assert.deepEqual(geo.dockedRect('left', WA, DIMS), { x: 6, y: 495, width: 52, height: 130 });
});

test('dockedRect：右侧竖条贴右边、垂直居中', () => {
  const r = geo.dockedRect('right', WA, DIMS);
  assert.equal(r.x, 1920 - 6 - 52);
  assert.equal(r.y, 495);
  assert.equal(r.width, 52);
  assert.equal(r.height, 130);
});

test('barRectFrom（横排）：从展开窗口反推回收起态，中心对齐', () => {
  const cur = { x: 700, y: 200, width: 520, height: 600 };
  assert.deepEqual(geo.barRectFrom(cur, false, 'down', DIMS, WA), {
    x: 860,
    y: 200,
    width: 200,
    height: 48,
  });
});

test('barRectFrom（横排）：展开宽度比胶囊窄时取窗口宽度', () => {
  const cur = { x: 700, y: 200, width: 120, height: 600 };
  assert.equal(geo.barRectFrom(cur, false, 'down', DIMS, WA).width, 120);
});

test('barRectFrom（竖排·左停靠）：竖条在展开窗口最左', () => {
  const cur = { x: 6, y: 200, width: 600, height: 700 };
  const r = geo.barRectFrom(cur, true, 'right', DIMS, WA);
  assert.equal(r.x, 6);
  assert.equal(r.y, 200 + 350 - 65);
  assert.equal(r.width, 52);
  assert.equal(r.height, 130);
});

test('barRectFrom（竖排·右停靠）：竖条在展开窗口最右', () => {
  const cur = { x: 1100, y: 200, width: 600, height: 700 };
  const r = geo.barRectFrom(cur, true, 'left', DIMS, WA);
  assert.equal(r.x, 1100 + 600 - 52);
});

/* ============================================================
 * 二、接线（静态检查：这些代码路径漏一处，拖动手感就会缺一块）
 * ============================================================ */

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MAIN = read('src', 'main', 'main.js');
const MAIN_CODE = stripComments(MAIN);
const PRELOAD = read('src', 'main', 'preload.js');
const RENDERER = read('src', 'renderer', 'renderer.js');
const RENDERER_CODE = stripComments(RENDERER);
const CSS = read('src', 'renderer', 'styles.css');
const CSS_CODE = stripComments(CSS);
const CONFIG = read('src', 'main', 'config.js');
const CONFIG_CODE = stripComments(CONFIG);
const SETTINGS_HTML = read('src', 'renderer', 'settings.html');

test('主进程注册了拖动三段 IPC，松手时写 dock（吸附边）', () => {
  assert.match(MAIN_CODE, /ipcMain\.handle\(\s*'hud:drag-start'/);
  assert.match(MAIN_CODE, /ipcMain\.on\(\s*'hud:drag-move'/);
  assert.match(MAIN_CODE, /ipcMain\.handle\(\s*'hud:drag-end',\s*\(_e, commit\)/);
  // 松手写停靠边 + 沿边落点（dockPos[dock] = axisCenter），不再保存任意 2D 坐标
  assert.match(MAIN_CODE, /config\.save\(\{\s*dock,\s*dockPos:/);
  assert.match(MAIN_CODE, /dragGeo\.axisCenter\(b,\s*dock\)/);
  assert.doesNotMatch(MAIN_CODE, /freePos/);
  assert.doesNotMatch(MAIN_CODE, /dock:\s*'free'/);
});

test('沿边落点：松手记位置，重排原样放回（不再弹回边中间）', () => {
  // dockRect 把 dockPos[dock] 传给 dockedRect；没记过的边返回 null → 居中
  assert.match(MAIN_CODE, /function dockOffsetOf\(dock\)/);
  assert.match(MAIN_CODE, /dockOffsetOf\(dock\)/);
  // 几何：offset 缺省居中，有 offset 时夹在屏内
  const g = require('../src/main/drag');
  const wa = { x: 0, y: 0, width: 1707, height: 1019 };
  const dims = { barW: 134, barH: 48, sideW: 52, runH: 130 };
  const centered = g.dockedRect('top', wa, dims);
  assert.equal(centered.x, Math.round((wa.width - dims.barW) / 2));
  assert.equal(centered.y, g.MARGIN);
  const atOffset = g.dockedRect('top', wa, dims, 300);
  assert.equal(atOffset.x, 300 - Math.round(dims.barW / 2)); // 中心在 300，不弹回居中
  // 越界落点夹回屏内：中心不能小于 MARGIN+半宽
  const clamped = g.dockedRect('top', wa, dims, 10);
  assert.ok(clamped.x >= g.MARGIN, `x=${clamped.x} 应 ≥ MARGIN`);
  // 竖条同理
  const vCentered = g.dockedRect('left', wa, dims);
  assert.equal(vCentered.y, Math.round((wa.height - dims.runH) / 2));
  const vAtOffset = g.dockedRect('left', wa, dims, 200);
  assert.equal(vAtOffset.y, 200 - Math.round(dims.runH / 2));
  assert.equal(vAtOffset.x, g.MARGIN);
});

test('拖动期间窗口尺寸钉死，不用 setPosition 累积漂移', () => {
  /*
   * Windows 150% 缩放下 win.setPosition 每次都会把 DIP 尺寸按物理像素
   * 来回取整、宽度 +1px：实测按住左右滑 120 次，innerWidth 从 134 涨到 254
   * （用户反馈「按住后随着左右滑动 bar 越来越宽」）。
   * 修法：拖动中记一份 dragSize，每次 move 显式带上宽高，漂了立刻纠回。
   */
  assert.match(MAIN_CODE, /let dragSize = null;/);
  assert.match(MAIN_CODE, /dragSize = \{ width: barRect\.width, height: barRect\.height \};/);
  assert.match(MAIN_CODE, /if \(dragSize && \(b\.width !== dragSize\.width \|\| b\.height !== dragSize\.height\)\)/);
  assert.match(MAIN_CODE, /width: dragSize \? dragSize\.width : b\.width/);
  // 翻转朝向时换的就是"钉住的尺寸"
  assert.match(MAIN_CODE, /dragSize = \{ width: pill\.width, height: pill\.height \};/);
  // 松手后清掉，避免影响下一次拖动与悬停
  const end = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.handle('hud:drag-end'"));
  assert.match(end.slice(0, 900), /dragSize = null;/);
  // setPosition 是高 DPI 漂移的来源，拖动路径里一律不用
  assert.doesNotMatch(MAIN_CODE, /win\.setPosition\(/);
});

test('拿起过就必须结束拖动，只有真拖过才写盘', () => {
  // 慢速单击（按住 300ms 拿起但没动）也走 dragEnd(commit=false)：
  // 否则主进程 dragging 常驻 true，悬停轮询与 hud:measure 永久被挡
  assert.match(PRELOAD, /dragEnd:\s*\(commit\)\s*=>\s*ipcRenderer\.invoke\('hud:drag-end',\s*commit === true\)/);
  assert.match(RENDERER_CODE, /if \(armed && window\.hud && window\.hud\.dragEnd\)/);
  assert.match(RENDERER_CODE, /window\.hud\.dragEnd\(moved\)/);
  const fn = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.handle('hud:drag-end'"));
  // 截到下一个顶层语句（早退分支里也有 }\n，不能按它切）
  const end = Math.min(
    ...[fn.indexOf('\nipcMain.'), fn.indexOf('\napp.on('), fn.indexOf('\nfunction ') ].filter((i) => i > 0)
  );
  const body = fn.slice(0, end > 0 ? end : 2000);
  assert.match(body, /dragging = false;/);
  assert.match(body, /if \(commit === true\) \{/);
  // 不提交的分支里不能再出现写盘
  const noCommit = body.slice(body.indexOf('if (commit === true)'));
  assert.doesNotMatch(noCommit.slice(noCommit.indexOf('applyDock')), /config\.save/);
});

test('拖动中按预测吸附边就地翻转朝向（横条 ↔ 竖条）', () => {
  const fn = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.on('hud:drag-move'"));
  const body = fn.slice(0, fn.indexOf('ipcMain.handle'));
  assert.match(body, /dragGeo\.zoneOf\(b,\s*wa\)/);
  assert.match(body, /if \(zone !== dragZone\)/);
  // 以胶囊中心重设矩形（不是左上角），否则翻转会横漂
  assert.match(body, /dragGeo\.pillRect\(b\.x \+ b\.width \/ 2,\s*b\.y \+ b\.height \/ 2,\s*vertical/);
  assert.match(body, /sendLayout\(\{\s*vertical,\s*dock:\s*zone/);
});

test('开始拖动时记住当前停靠边，松手用它兜底', () => {
  assert.match(MAIN_CODE, /dragZone = layout\.dock/);
  assert.match(MAIN_CODE, /const dock = dragZone \|\| dragGeo\.zoneOf/);
});

test('拖动落回用「最近一次非悬停测量」的收起宽度，不在拿起时现量', () => {
  // 悬停态的 contentWidth 是加宽值（实测 284/540），拿它收窗口就等于
  // 拖着一条"完全展开"的大胶囊；而在拿起瞬间现量又会在启动初期
  // （.marks 还没渲染）量到 24px，被夹成 100px 窄条。
  assert.match(MAIN_CODE, /let collapsedWidth = BAR\.width;/);
  assert.match(MAIN_CODE, /if \(!hovering\) collapsedWidth = next;/);
  const start = MAIN_CODE.slice(MAIN_CODE.indexOf("ipcMain.handle('hud:drag-start'"));
  const startBody = start.slice(0, start.indexOf('ipcMain.on'));
  assert.match(start, /'hud:drag-start',\s*\(\)\s*=>/);
  assert.match(startBody, /contentWidth = clampWidth\(collapsedWidth\);/);
  assert.doesNotMatch(startBody, /widthHint|Number\(width/);
});

test('停靠边决定朝向与展开方向，量宽度时忽略竖排', () => {
  assert.match(MAIN_CODE, /function layoutOf\(cfg\)/);
  assert.match(MAIN_CODE, /config\.normalizeDock\(conf\.dock\)/);
  assert.match(MAIN_CODE, /anchor: dragGeo\.anchorOf\(dock\)/);
  // 竖排下 hud:measure 直接返回条厚，避免把竖条按横条宽度摆
  assert.match(MAIN_CODE, /if \(layout\.vertical\) return SIDE_THICKNESS;/);
});

test('拖动期间冻结 hover / 测量 / 展开，防止胶囊抖动', () => {
  assert.match(MAIN_CODE, /if \(dragging\) return;/);
  assert.match(MAIN_CODE, /if \(!expanded && !dragging\) applyDock\(\)/);
  assert.match(RENDERER_CODE, /if\s*\(drag\s*&&\s*drag\.armed\)\s*return;/);
});

test('preload 暴露 dragStart / dragMove / dragEnd', () => {
  assert.match(PRELOAD, /dragStart:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('hud:drag-start'\)/);
  // 收起宽度由主进程 collapsedWidth 提供，测量上报带"是否悬停"标记
  assert.match(PRELOAD, /measure:\s*\(w,\s*hovering\)\s*=>\s*ipcRenderer\.invoke\('hud:measure',\s*w,\s*!!hovering\)/);
  assert.match(PRELOAD, /collapsedWidth/);
  assert.match(PRELOAD, /dragMove:\s*\(dx,\s*dy\)\s*=>\s*ipcRenderer\.send\('hud:drag-move',\s*dx,\s*dy\)/);
});

test('渲染层拖动全程：pointerdown/move/up 都挂在胶囊上，松手提交', () => {
  assert.match(RENDERER_CODE, /bar\.addEventListener\('pointerdown',\s*onBarPointerDown\)/);
  assert.match(RENDERER_CODE, /bar\.addEventListener\('pointermove',\s*onBarPointerMove\)/);
  assert.match(RENDERER_CODE, /bar\.addEventListener\('pointerup',\s*endDrag\)/);
  // 拿起时不再现量宽度：主进程按 collapsedWidth（最近一次非悬停测量）收窗口
  assert.match(RENDERER_CODE, /dragStart\(\)/);
  assert.doesNotMatch(RENDERER_CODE, /dragStart\(need/);
  const armFn = RENDERER_CODE.slice(RENDERER_CODE.indexOf('function armDrag('));
  const armBody = armFn.slice(0, armFn.indexOf('\n}'));
  assert.match(armBody, /collapseForDrag\(\)/);
  assert.doesNotMatch(armBody, /measureBarNeed/);
  // 测量上报必须带悬停标记，否则加宽值会被主进程当成收起态宽度
  assert.match(RENDERER_CODE, /window\.hud\.measure\(need, hovering\)/);
  assert.match(RENDERER_CODE, /const hovering = document\.body\.classList\.contains\('hovering'\) \|\| panelOpen/);
  assert.match(RENDERER_CODE, /dragMove\(dx,\s*dy\)/);
  assert.match(RENDERER_CODE, /dragEnd\(moved\)/);
  assert.match(RENDERER_CODE, /classList\.add\('dragging'\)/);
  assert.match(RENDERER_CODE, /classList\.remove\('dragging'\)/);
});

test('按住超过阈值才拿起（6px / 300ms），按钮不参与拖动', () => {
  assert.match(RENDERER_CODE, /const DRAG_TRAVEL = 6/);
  assert.match(RENDERER_CODE, /const DRAG_HOLD_MS = 300/);
  assert.match(RENDERER_CODE, /closest\('\.icon-btn'\)/);
  assert.match(RENDERER_CODE, /setTimeout\(armDrag,\s*DRAG_HOLD_MS\)/);
});

test('拿起后没拖动就松手不提交，但一定结束拖动（慢速单击不该改变停靠边）', () => {
  const fn = RENDERER_CODE.slice(RENDERER_CODE.indexOf('function endDrag('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // 提交条件仍是 armed && moved，只是把它做成 dragEnd(commit) 的参数
  assert.match(body, /if\s*\(armed\s*&&\s*window\.hud\s*&&\s*window\.hud\.dragEnd\)/);
  assert.match(body, /dragEnd\(moved\)/);
  assert.doesNotMatch(body, /if\s*\(armed\s*&&\s*moved\s*&&/);
  assert.match(RENDERER_CODE, /drag\.moved = true/);
});

test('测量胶囊宽度时关掉过渡（否则量到 width 过渡的中间值）', () => {
  assert.match(CSS_CODE, /body\.measuring \.bar > \* \{ transition: none !important; \}/);
  const fn = RENDERER_CODE.slice(RENDERER_CODE.indexOf('function measureBarNeed('));
  assert.match(fn.slice(0, 600), /classList\.add\('measuring'\)/);
  assert.match(fn.slice(0, 1400), /classList\.remove\('measuring'\)/);
});

test('拖动中显示虚线边框，并且不显示面板', () => {
  assert.match(CSS_CODE, /body\.dragging \.bar::before/);
  assert.match(CSS_CODE, /border:\s*1\.5px dashed/);
  // 虚线画在胶囊内侧（inset 2px）：画在外扩位置会被窗口边界裁掉，
  // 而胶囊永远贴着屏幕边（上下左右 6px 边距），靠边那侧的虚线就没了
  const dashRule = CSS_CODE.slice(CSS_CODE.indexOf('body.dragging .bar::before'));
  assert.match(dashRule.slice(0, dashRule.indexOf('}')), /inset:\s*2px/);
  assert.doesNotMatch(dashRule.slice(0, dashRule.indexOf('}')), /inset:\s*-/);
  assert.match(CSS_CODE, /border-radius:\s*999px/);
  assert.match(CSS_CODE, /body\.dragging \.panel \{ display: none; \}/);
  // 抓取光标
  assert.match(CSS_CODE, /body\.hovering \.bar \{ cursor: grab; \}/);
  assert.match(CSS_CODE, /body\.dragging \.bar \{ cursor: grabbing; \}/);
});

test('渲染层按 anchor 切面板方向：右侧竖条时面板朝左', () => {
  assert.match(RENDERER_CODE, /document\.body\.classList\.toggle\('panel-left',\s*anchor === 'left'\)/);
  assert.match(CSS_CODE, /body\.vertical\.panel-left \.panel/);
});

test('配置只认三条停靠边，旧值归一化成 top', () => {
  assert.match(CONFIG_CODE, /const DOCKS = \['top', 'left', 'right'\]/);
  assert.match(CONFIG_CODE, /function normalizeDock\(v\)/);
  assert.match(CONFIG_CODE, /return DOCKS\.includes\(v\) \? v : 'top'/);
  assert.match(CONFIG_CODE, /dock: normalizeDock\(raw\.dock\)/);
  // 自由位置的字段已经删干净
  assert.doesNotMatch(CONFIG_CODE, /freePos/);
});

test('设置页只提供上/左/右三个停靠选项，并提示可拖动', () => {
  const dockBlock = SETTINGS_HTML.slice(SETTINGS_HTML.indexOf('id="dock"'));
  const options = dockBlock.slice(0, dockBlock.indexOf('</select>'));
  assert.match(options, /<option value="top">/);
  assert.match(options, /<option value="left">/);
  assert.match(options, /<option value="right">/);
  assert.doesNotMatch(options, /value="free"/);
  assert.doesNotMatch(options, /top-left/);
  assert.match(SETTINGS_HTML, /按住胶囊左键拖动/);
});
