'use strict';

/**
 * renderer.js 静态检查：面板各区块都必须被 render() 真正调用。
 *
 * 历史 bug：重写 renderAllGrid 后忘了在 render() 里调用它，
 * 结果概况行永远是空的，但页面不报错、控制台也干净 ——
 * 只有实际截图或读 DOM 才能发现。node --check 查不出这类问题。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
  'utf8'
);

/**
 * 只剥注释，保留字符串字面量。
 *
 * 早期版本连字符串也剥了，结果 `addEventListener('click')` 变成
 * `addEventListener('')`，断言 'click' 永远匹配不上 —— 测试本身写错，
 * 却看起来像产品有问题。
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CODE = stripComments(SRC);

/** 取 render 函数体（到下一个顶层 function 为止）。 */
function renderBody() {
  const start = CODE.indexOf('function render(summary)');
  assert.ok(start > 0, '应找到 render(summary)');
  const rest = CODE.slice(start + 10);
  const nextFn = rest.search(/\nfunction [a-zA-Z_$]/);
  return nextFn > 0 ? rest.slice(0, nextFn) : rest;
}

test('render() 必须调用 renderTabs（否则顶部 Tab 不显示）', () => {
  assert.match(renderBody(), /renderTabs\s*\(/, 'render 应调用 renderTabs');
});

test('render() 必须调用 renderAllGrid（否则概况行永远空白）', () => {
  assert.match(renderBody(), /renderAllGrid\s*\(/, 'render 应调用 renderAllGrid');
});

test('render() 必须调用 renderMarks 与 renderQuotas', () => {
  const body = renderBody();
  assert.match(body, /renderMarks\s*\(/, 'render 应调用 renderMarks');
  assert.match(body, /renderQuotas\s*\(/, 'render 应调用 renderQuotas');
});

test('每个被 render() 调用的 render* 函数都真实存在', () => {
  const body = renderBody();
  const called = [...body.matchAll(/\b(render[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
  const defined = [...CODE.matchAll(/function\s+(render[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
  const missing = [...new Set(called)].filter((f) => !defined.includes(f));
  assert.equal(missing.length, 0, '调用了未定义的函数: ' + missing.join(', '));
});

test('Tab 切换会重绘（click 后调用 render）', () => {
  assert.match(CODE, /addEventListener\(\s*'click'/, 'Tab 应有 click 监听');
  assert.match(CODE, /if\s*\(\s*currentSummary\s*\)\s*render\(/, '切换后应重绘');
});

test('面板区块顺序：额度区必须在最近会话之后', () => {
  /*
   * 用户明确要求：积分余额、积分包明细、各 provider 的今日本地消耗
   * 都属于"想细看才看"的次要信息，不该挤在首屏把模型用量和会话推下去。
   *
   * 期望顺序：Tab → 概况 → 模型用量 → 最近会话 → 额度
   * （限流区已随 Beta 限流监测整体删除，2026-10-25）
   */
  const indexHtml = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8'
  );
  const ids = [
    ...indexHtml.matchAll(/id="(panelTabs|allModels|quotaSection|bars|sessions)"/g),
  ].map((m) => m[1]);

  assert.deepEqual(
    ids,
    ['panelTabs', 'allModels', 'bars', 'sessions', 'quotaSection'],
    `区块顺序不对，实际是 ${ids.join(' → ')}`
  );
});
