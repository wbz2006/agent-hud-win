'use strict';

/**
 * 两个交互修复的静态防护：
 *
 * 1. 关闭详情卡片时胶囊闪宽（2026-10-26 用户反馈）：
 *    收起路径原来是 measureBar()（rAF 排队，下一帧才发 measure IPC）+
 *    立刻 expand(false,0) —— 主进程先按展开期记下的加宽 contentWidth
 *    （=卡片宽）收窗，下一帧测量到了才缩回胶囊宽，肉眼可见闪一下。
 *    修复后收起前必须**同步**量宽（measureBarNeed）并把 measure IPC 发在
 *    expand 之前（同一渲染进程 IPC 保序）。
 *
 * 2. 无数据时的金额标签（2026-10-26 用户反馈）：
 *    - DSH 没打开 → 显示 ￥0.00，不再退回「余额 ￥x」占位 —— 侧置竖排
 *      宽度有限，"余额 ￥3.02" 会被裁成只剩"余额"两个字。
 *    - Claude/Codex 等 app 今天没有请求（账本可读）→ ￥0.00，不再显示「—」。
 *    金额归零走 todayCny = 0（markHtml 的 todayCny != null 分支给出 ￥0.00）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

test('关闭卡片：必须同步量宽并把 measure 发在 expand(false) 之前', () => {
  // 收起分支：panel.classList.remove('open') 之后的那个 setTimeout 回调体
  const m = src.match(
    /panel\.classList\.remove\('open'\);[\s\S]*?expandTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, FADE_MS\);/
  );
  assert.ok(m, 'renderer.js 里找不到收起卡片的 setTimeout 回调');
  const body = m[1];
  const measureAt = body.indexOf('measureBarNeed()');
  const sendAt = body.indexOf("hud.measure(need, false)");
  const expandAt = body.indexOf('hud.expand(false, 0)');
  assert.ok(measureAt !== -1, '收起前没有同步量宽（measureBarNeed）');
  assert.ok(sendAt !== -1, '收起前没有把 measure IPC 发给主进程');
  assert.ok(expandAt !== -1, '收起回调里没有 expand(false, 0)');
  assert.ok(measureAt < sendAt && sendAt < expandAt, '顺序必须是：量宽 → 发 measure → expand 收窗');
  // 竖排宽度固定（SIDE_THICKNESS），不能被横排的同步测量改写
  assert.match(body, /!verticalLayout/, '同步量宽必须以 !verticalLayout 为前提');
});

test('DSH 没打开时金额标签回退 ￥0.00（不是「余额 ￥x」）', () => {
  // dsToday 缺失时 DSH 环的 todayCny 必须落 0（人民币账户口径）
  assert.match(src, /todayCny = dsToday != null \? dsToday : 0;/);
});

test('账本可读而当天无请求时，环金额回退 0 而不是「—」', () => {
  // source 环（claude/codex）与 app 环各一处 todayCny = 0 兜底
  const hits = src.match(/todayCny = 0;/g) || [];
  assert.ok(hits.length >= 2, `期望至少两处 todayCny = 0 兜底（source 环 + app 环），实际 ${hits.length}`);
  // DSH 不进 CC Switch 账本，source 环的兜底必须跳过 dsh（避免美元账户被标 ￥）
  assert.match(src, /key !== 'dsh' && todayCny == null/);
});

test('余额信息仍保留在悬停提示（spendTip）里，没有随标签一起删掉', () => {
  assert.match(src, /DeepSeek 余额/);
  assert.match(src, /今日已用/);
});

/*
 * 2026-10-27 二次修复：关闭后胶囊"一瞬间重新展开"。
 * 真光标轨迹（CDP + GetWindowRect 采样）：窗口 500 → 135（收起态 1 帧）→ 264。
 * 根因：setBounds 收拢几何时 Chromium 合成 mouseleave→mouseenter（5ms 内），
 * mouseenter 把 hovering 加回去，胶囊被重新撑宽 —— 环多时悬停宽 ≈ 卡片宽。
 * 修复：closeSettleUntil 短窗内压制 mouseenter 的加宽请求。
 */
/*
 * 2026-10-27 三次修复（真根因）：关闭后胶囊"一瞬间展开和卡片一样宽"。
 * DOM 采样确认：点 ✕ 后 panel-open 先摘、窗口要等 FADE_MS 淡出才收拢，
 * 这 180ms 里 .bar 退回 width:auto —— 窗口还是卡片宽，胶囊就铺满整个窗口
 * （4 环实测：bar 339 → 501 → 174）。两个不能用的方案：
 *   · fit-content 兜底：收起态 .marks 是绝对定位，fit-content 量不到它，
 *     胶囊底板会缩成 18px 的一条（实机踩过）；
 *   · 无条件 fit-content：同上，收起态胶囊底板直接消失。
 * 正确做法：关闭时用内联样式把 .bar 钉在收起态内容宽上（margin auto 居中），
 * 窗口收拢后再清除。
 */
test('关闭卡片期间胶囊宽度必须内联钉在收起宽上，收拢后清除', () => {
  // 关闭分支：先钉宽再进 FADE_MS 定时器（中间隔一行注释）
  const m = src.match(
    /panel\.classList\.remove\('open'\);[\s\S]{0,220}?pinBarToCollapsedWidth\(\);[\s\S]*?expandTimer = setTimeout/
  );
  assert.ok(m, '关闭分支没有在定时器前立即调用 pinBarToCollapsedWidth()');
  // 钉宽 = 内联 width + margin auto（不能用 fit-content：marks 绝对定位量不到）
  const fn = src.match(/function pinBarToCollapsedWidth\(\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, '缺少 pinBarToCollapsedWidth 定义');
  assert.match(fn[1], /bar\.style\.width = need \+ 'px';/);
  assert.match(fn[1], /bar\.style\.margin = '0 auto';/);
  assert.match(fn[1], /verticalLayout/, '竖条宽度由 CSS 锁死，钉宽必须跳过竖排');
  // 打开 / 拖动 / 收拢后三条路径都要清掉内联样式
  assert.match(src, /if \(next\) clearPinnedBarWidth\(\);/);
  assert.match(src, /setTimeout\(clearPinnedBarWidth, \d+\);/);
  assert.match(src.match(/function collapseForDrag\(\) \{[\s\S]*?\n\}/)[0], /clearPinnedBarWidth\(\);/);
});

test('关闭卡片后必须压制几何抖动合成的 mouseenter 加宽', () => {
  assert.match(src, /let closeSettleUntil = 0;/, '缺少 settle 窗口状态');
  // setHovering 入口：只压 true（真正的移出不受影响）
  assert.match(src, /if \(next && Date\.now\(\) < closeSettleUntil\) return;/);
  // 收起路径收窗后必须开启 settle 窗口
  const m = src.match(/panel\.classList\.remove\('open'\);[\s\S]*?closeSettleUntil = Date\.now\(\) \+ \d+;/);
  assert.ok(m, '收起回调末尾没有开启 settle 窗口');
});

/*
 * 2026-10-27：侧置竖条长度随环数自适应。
 * 旧实现主进程写死 SIDE_RUN=130（3 个环的尺寸），设置里多勾几个环就被裁掉。
 * 渲染层按环数回报收起态高度，主进程记进动态 sideRun 并在 dockRect /
 * setExpanded / barDims（拖动吸附）全线使用。
 */
test('竖条长度必须随环数动态计算（渲染层回报 + 主进程动态 sideRun）', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  // 渲染层：measureBar 竖排分支回报 verticalRunHeight()
  assert.match(src, /if \(verticalLayout\) \{\s*\n\s*const h = verticalRunHeight\(\);/);
  // 渲染层：两个高度公式按环数走
  assert.match(src, /function verticalRunHeight\(\)/);
  assert.match(src, /40 \* verticalMarkCount\(\) \+ 8/);
  assert.match(src, /53 \* verticalMarkCount\(\) \+ 30/);
  // 主进程：动态 sideRun + 三处使用点不再写死
  assert.match(mainSrc, /let sideRun = SIDE_RUN;/);
  assert.match(mainSrc, /runH: sideRun/);
  const dockRectRuns = mainSrc.match(/runH: sideRun/g) || [];
  assert.ok(dockRectRuns.length >= 2, `dockRect 与 barDims 都要用 sideRun，实际 ${dockRectRuns.length} 处`);
  assert.match(mainSrc, /if \(Math\.abs\(next - sideRun\) > 1\) \{/, 'measure 竖排分支要更新 sideRun');
  // 悬停加高与完整展开的下限都用 sideRun（不再写死 SIDE_RUN）
  assert.match(mainSrc, /Math\.max\(sideRun, Math\.min\(wa0\.height, want\)\)/);
  assert.match(mainSrc, /Math\.max\(sideRun, Math\.min\(wa\.height, panelH\)\)/);
  // 渲染层的 setHovering / 拖动仍引用 SIDE_THICKNESS —— 曾在改高度公式时把
  // 声明一起删掉（静态测试与 node --check 都抓不到，实机悬停才炸 ReferenceError）
  assert.match(src, /const SIDE_THICKNESS = 52;/);
});
