'use strict';

/**
 * 悬停加宽的**自愈**护栏（2026-10-25 用户反馈之后补的）。
 *
 * 症状：从左侧竖条拖到上边松手，有概率胶囊不收回收起态，而是变成一条宽 bar，
 * 里面只有三个圆环（悬停加宽宽度 + 没有 hovering 类）。
 *
 * 链条上一共有三个洞，任何一个漏一次都不可恢复：
 *   1. 渲染层松手后的重测被主进程 `if (dragging) return` 门禁**静默丢弃**
 *      （dragEnd 与 measure 是两条并发 IPC，顺序不保证，丢了也不补投）；
 *   2. 主进程悬停结束后只发 hud:hover=false，宽度靠渲染层再测一次才回来 ——
 *      那一次若被吃掉（竖排/展开态门禁），窗口永久停在加宽值；
 *   3. 渲染层朝向标记是异步推的，拖动刚翻到横排时它可能还认为"竖排"，
 *      于是发一次 hoverGrow 展开；横排分支按完整展开处理（w ≥ PANEL_MIN_WIDTH），
 *      把 expanded 永久留在 true，之后所有测量都不再改窗口尺寸。
 *
 * 这里把三处护栏都钉成断言，防止将来重构成"看起来对"的样子。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MAIN = stripComments(fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8'));
const RENDERER = stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8'));

test('横排收到 hoverGrow 一律忽略（不许把悬停当完整展开）', () => {
  const fn = MAIN.slice(MAIN.indexOf('function setExpanded('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(hoverGrow && !vertical\) return;/, 'hoverGrow 必须只在竖排生效');
  // 必须出现在 expanded 赋值之前，否则已经把展开态留成 true 了
  assert.ok(
    body.indexOf('hoverGrow && !vertical') < body.indexOf('expanded = next;'),
    '护栏必须早于 expanded = next（否则展开态已经被污染）'
  );
});

test('悬停结束由主进程自己收窄（不依赖渲染层的测量回报）', () => {
  assert.match(MAIN, /function enforceCollapsedWidth\(\)/, '缺少自愈函数');
  const fn = MAIN.slice(MAIN.indexOf('function enforceCollapsedWidth('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /const w = clampWidth\(collapsedWidth\);/, '自愈必须用 collapsedWidth（非悬停测量值）');
  assert.match(body, /if \(layout\.vertical\) return;/, '竖排不能动（悬停加高是另一套）');
  assert.match(body, /if \(!win \|\| win\.isDestroyed\(\) \|\| dragging \|\| expanded\) return/, '展开态/拖动中不抢尺寸');
  // 悬停轮询的"离开"分支里必须真的调用
  const poll = MAIN.slice(MAIN.indexOf('function startHoverWatch('));
  const pollBody = poll.slice(0, poll.indexOf('\n}'));
  assert.match(pollBody, /hovering = false;[\s\S]{0,400}enforceCollapsedWidth\(\);/, '悬停结束时必须调自愈');
});

test('拖动落地与拿起都必须按 collapsedWidth 取宽', () => {
  // 拿起时（drag-start）与落地时（drag-end）各一次，缺一个就会带着残留宽度落地
  const hits = MAIN.match(/contentWidth = clampWidth\(collapsedWidth\);/g) || [];
  assert.ok(hits.length >= 2, `drag-start 与 drag-end 都要按 collapsedWidth 取宽，实际 ${hits.length} 处`);
  const end = MAIN.slice(MAIN.indexOf("ipcMain.handle('hud:drag-end'"));
  // 截到下一个顶层语句（handler 尾部与里面的对象字面量都有 })，不能按 '});' 切
  const stop = Math.min(
    ...[end.indexOf('\nipcMain.'), end.indexOf('\napp.on('), end.indexOf('\nfunction ')].filter((i) => i > 0)
  );
  const endBody = end.slice(0, stop > 0 ? stop : end.length);
  assert.match(endBody, /contentWidth = clampWidth\(collapsedWidth\);/, 'drag-end 必须重取宽度');
  assert.ok(
    endBody.indexOf('contentWidth = clampWidth(collapsedWidth)') < endBody.indexOf('applyDock()'),
    '必须在 applyDock 之前重取（否则落位用的还是旧宽度）'
  );
});

test('渲染层松手后的重测必须排在 dragEnd 之后，并留一条延时补测', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function endDrag('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /window\.hud\s*\.dragEnd\(moved\)[\s\S]{0,120}\.then\(\(\) => measureBar\(\)\)/, '重测必须挂在 dragEnd 的 then 上');
  assert.match(body, /setTimeout\(\(\) => \{[\s\S]{0,80}if \(!drag\) measureBar\(\);/, '缺少延时补测');
});

test('竖排悬停收起时保留沿边落点（dockPos 不被弹回边中间）', () => {
  const fn = MAIN.slice(MAIN.indexOf('function setExpanded('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.length > 200, '没截到 setExpanded 函数体');
  assert.match(body, /win\.setBounds\(dockRect\(/, '竖排收起必须走 dockRect（带 dockPos 落点）');
  assert.doesNotMatch(body, /d2\.height - SIDE_RUN/, '不许再硬编码竖直居中');
});
