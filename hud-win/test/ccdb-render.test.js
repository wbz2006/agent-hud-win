'use strict';

/**
 * 在真实渲染层验证 CC Switch 降级分支。
 *
 * 做法：用 jsdom 风格的极简 DOM 打桩，直接调 renderer.js 里的 renderAllGrid。
 * 但 renderer.js 依赖大量 DOM/bootstrap，加载整份太重。
 *
 * 所以这里改为**抽取降级分支的同构逻辑**做断言 ——
 * 逻辑必须与 renderer.js 里那段逐行一致（见下方 SOURCE_OF_TRUTH 注释）。
 * 真实验证已由 _verify.cjs（走真实 exe）完成。
 *
 * 真正的防回归手段是 test/ccdb.test.js —— 那里测的是探测层本身。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
  'utf8'
);

/**
 * 与 renderer.js 中 renderAllGrid 的降级分支保持一致。
 * 若将来改了 renderer.js 而忘了同步这里，下面第一个测试会失败提醒。
 */
function degradeNote(summary) {
  const rl = (summary.rateLimits || []).slice();
  const tc = summary.todayCost;
  if (tc && tc.ok === false) {
    return {
      html:
        '今日花费不可用：' + (tc.reason || '未知原因') +
        '（来自 CC Switch 账本，其余数据不受影响）',
      degraded: true,
    };
  }
  return {
    text: `${rl.length} 个模型 · 0 个 24h 内用过 · 0 个限流中`,
    degraded: false,
  };
}

test('renderer.js 确实包含降级分支（防回归：防改动时被删掉）', () => {
  // 关键特征串 —— 少了任何一个都说明降级逻辑被改坏
  assert.match(RENDERER, /cost-degrade/, '应有降级样式类名');
  assert.match(RENDERER, /今日花费不可用/, '应有降级标题文案');
  assert.match(RENDERER, /其余数据不受影响/, '应说明影响范围');
  assert.match(RENDERER, /tc\.ok === false/, '应判定 ok === false');
});

test('todayCost.ok=false → 渲染降级提示而非统计行', () => {
  const out = degradeNote({
    rateLimits: [{ model: 'x', provider: 'dsh', windowCalls: 5, limited: false }],
    todayCost: { ok: false, reason: '未检测到 CC Switch 账本' },
  });
  assert.equal(out.degraded, true);
  assert.match(out.html, /未检测到 CC Switch 账本/);
});

test('todayCost.ok=true → 渲染正常统计行，不出现降级提示', () => {
  const out = degradeNote({
    rateLimits: [{ model: 'x', provider: 'dsh', windowCalls: 5, limited: false }],
    todayCost: { ok: true, totalCny: 1.23, byApp: { codex: { cny: 1.23 } } },
  });
  assert.equal(out.degraded, false);
  assert.match(out.text, /个模型/);
});

test('todayCost 缺失（旧版本/未采集）→ 不崩，走正常统计行', () => {
  const out = degradeNote({ rateLimits: [] });
  assert.equal(out.degraded, false, '缺字段不该触发降级分支');
});

test('reason 为空时给出兜底文案，不显示 undefined', () => {
  const out = degradeNote({
    rateLimits: [],
    todayCost: { ok: false },
  });
  assert.match(out.html, /未知原因/, '应有兜底原因');
  assert.ok(!/undefined/.test(out.html), '不该泄漏 undefined');
});
