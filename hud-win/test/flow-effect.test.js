'use strict';

/**
 * 胶囊流光（金额数据健康度）静态防护。
 *
 * 视觉（2026-10-27 二次修改）：**整体律动** —— 两条光带以不同速度、反向扫过
 * 整个胶囊表面 + 缓慢呼吸脉动，而不是只描边。
 *   data-flow="ok"  → 黑绿律动（所有可见环都拿到正确金额）
 *   data-flow="bad" → 红黑律动（任一可见环金额是「—」，或采集失败）
 *   无 data-flow    → 不显示（启动首帧无数据，不预判）
 *
 * 两边都不报错只能静态对齐：
 *   · renderer 在 renderMarks 里按 items 写 body[data-flow]；
 *   · styles.css 用 @property 注册位置变量驱动 background-position；
 *   · ::before 被拖动虚线占用，流光必须用 ::after（负 z-index 压在内容之下）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

test('整体律动：位置变量驱动 background-position，双光带反向扫过', () => {
  assert.match(CSS, /@property --flow-x1 \{[\s\S]*?syntax: '<percentage>';/);
  assert.match(CSS, /@property --flow-x2 \{[\s\S]*?syntax: '<percentage>';/);
  assert.match(CSS, /\.bar::after \{[\s\S]*?background-position: var\(--flow-x1\) 0, var\(--flow-x2\) 0;/);
  assert.match(CSS, /@keyframes bar-flow \{[\s\S]*?--flow-x1: -230%;[\s\S]*?--flow-x2: 275%;/);
  // 律动 = 流动 + 呼吸两个动画并存
  assert.match(CSS, /animation:\s*\n?\s*bar-flow 9s linear infinite,\s*\n?\s*bar-pulse 4\.5s ease-in-out infinite alternate;/);
  assert.match(CSS, /@keyframes bar-pulse \{\s*from \{ opacity: 0\.55; \}\s*to \{ opacity: 1; \}\s*\}/);
});

test('律动层压在内容之下：::after 负 z-index + .bar 隔离层', () => {
  assert.match(CSS, /\.bar \{[\s\S]*?isolation: isolate;/);
  assert.match(CSS, /\.bar::after \{[\s\S]*?z-index: -1;/);
  // ::before 是拖动虚线，流光不得占用
  assert.doesNotMatch(CSS, /^\.bar::before \{/m);
  assert.match(CSS, /body\.dragging \.bar::after \{ display: none; \}/);
});

test('双色语义：ok=黑绿，bad=红黑；默认不显示', () => {
  assert.match(CSS, /body\[data-flow='ok'\] \.bar::after \{[\s\S]*?rgba\(61, 220, 132/);
  assert.match(CSS, /body\[data-flow='bad'\] \.bar::after \{[\s\S]*?rgba\(255, 69, 58/);
  assert.match(CSS, /\.bar::after \{[\s\S]*?opacity: 0;/);
  assert.match(CSS, /body\[data-flow\] \.bar::after \{\s*opacity: 1;/);
});

test('渲染层按可见环的金额健康度写 body[data-flow]', () => {
  // 任一可见环没有金额且没有余额标签 → bad；全部有 → ok；无数据 → 空
  assert.match(RENDERER, /const flowBad = items\.some\(\(r\) => r\.todayCny == null && !r\.spendLabel\);/);
  assert.match(RENDERER, /document\.body\.dataset\.flow = items\.length \? \(flowBad \? 'bad' : 'ok'\) : '';/);
  // 采集失败（已弹错误框）也转红，成功渲染后自动纠正
  assert.match(RENDERER, /采集失败：[\s\S]{0,240}document\.body\.dataset\.flow = 'bad';/);
});
