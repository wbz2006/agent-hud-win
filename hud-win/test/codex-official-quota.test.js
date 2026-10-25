'use strict';

/**
 * Codex 官方登录态百分比额度 —— 单测 + 接线静态防护。
 *
 * 起点（2026-10-25 用户需求）：官方 GPT（ChatGPT 订阅版 Codex）的
 * 5 小时 / 周窗口百分比额度。数据在本地 rollout 的
 * event_msg/token_count → rate_limits（primary.used_percent 等），
 * 与官方登录态绑定 —— 走中转站时字段整体为 null。
 *
 * 防的两类回归：
 *   1. 解析回归：字段整体为 null 时把额度覆盖成假数据 / 末尾 null 覆盖前值。
 *   2. 接线回归：index 算出 codexQuota 但 renderer 不读（与 relayBalance
 *      2026-10-21 那个 bug 同型）—— 代码不报错、页面不崩、只是少一块内容。
 *
 * 跑法：node --test test/codex-official-quota.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const codex = require('../src/main/sources/codex-source');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
const INDEX = path.join(__dirname, '..', 'src', 'main', 'sources', 'index.js');

const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const indexSrc = fs.readFileSync(INDEX, 'utf8');

/** 只剥注释，保留字符串字面量（剥字符串会让断言假通过，踩过这个坑）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const rendererCode = stripComments(rendererSrc);
const indexCode = stripComments(indexSrc);

/* ------------------------------------------------------------------ */
/* 单测：normalizeRateLimits（纯函数）                                  */
/* ------------------------------------------------------------------ */

test('真实形状：primary 带值 → 归一化出 usedPercent/windowMinutes', () => {
  // 取自本机 2026-09-22 官方登录会话的真实形状
  const rl = {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 24.0, window_minutes: 10080, resets_at: null },
    secondary: null,
    credits: null,
    plan_type: null,
    rate_limit_reached_type: null,
  };
  const norm = codex.normalizeRateLimits(rl, '2026-09-22T14:00:00.000Z');
  assert.ok(norm, 'primary 带值时必须归一化成功');
  assert.equal(norm.primary.usedPercent, 24.0);
  assert.equal(norm.primary.windowMinutes, 10080);
  assert.equal(norm.primary.resetsAt, null); // resets_at 为 null 时如实保留
  assert.equal(norm.secondary, null);
  assert.equal(norm.fetchedAt, '2026-09-22T14:00:00.000Z');
});

test('中转站形状：字段整体为 null → 返回 null（不编造数据）', () => {
  // 取自本机 2026-10-24 乐米中转会话的真实形状
  const rl = {
    limit_id: 'codex',
    limit_name: null,
    primary: null,
    secondary: null,
    credits: null,
    individual_limit: null,
    spend_control_reached: null,
    plan_type: null,
    rate_limit_reached_type: null,
  };
  assert.equal(codex.normalizeRateLimits(rl), null, 'primary 为 null 时必须返回 null');
  assert.equal(codex.normalizeRateLimits(null), null);
  assert.equal(codex.normalizeRateLimits({}), null);
});

test('resets_at 为 ISO 字符串时保留；5h 窗口（300 分钟）可归一化', () => {
  const rl = {
    primary: { used_percent: 7.5, window_minutes: 300, resets_at: '2026-10-25T04:00:00Z' },
    secondary: { used_percent: 42, window_minutes: 10080, resets_at: null },
    plan_type: 'plus',
  };
  const norm = codex.normalizeRateLimits(rl, '2026-10-25T01:00:00.000Z');
  assert.equal(norm.primary.windowMinutes, 300);
  assert.equal(norm.primary.resetsAt, '2026-10-25T04:00:00Z');
  assert.equal(norm.secondary.usedPercent, 42);
  assert.equal(norm.planType, 'plus');
});

test('used_percent 缺失/非数的窗口不算有效数据', () => {
  assert.equal(codex.normalizeRateLimits({ primary: { window_minutes: 300 } }), null);
  assert.equal(codex.normalizeRateLimits({ primary: { used_percent: 'x' } }), null);
});

/* ------------------------------------------------------------------ */
/* 单测：parseRollout 端到端（临时 fixture 文件）                       */
/* ------------------------------------------------------------------ */

test('parseRollout 从 rollout 提取 rate_limits，且末尾 null 不覆盖前值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rl-'));
  const file = path.join(dir, 'rollout-2026-10-25T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  const lines = [
    JSON.stringify({
      timestamp: '2026-10-25T00:00:00.000Z',
      type: 'session_meta',
      payload: { cwd: 'D:\\work\\demo', model_provider: 'openai', originator: 'Codex Desktop', cli_version: '0.153.4' },
    }),
    // 第一条：官方值（真实形状）
    JSON.stringify({
      timestamp: '2026-10-25T00:01:00.000Z',
      ordinal: 1,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1 }, last_token_usage: {}, model_context_window: 258400 },
        rate_limits: { limit_id: 'codex', primary: { used_percent: 13.0, window_minutes: 10080, resets_at: null }, secondary: null, plan_type: null },
      },
    }),
    // 中间一条：没有 rate_limits（不同形状的 token_count），不能破坏前值
    JSON.stringify({
      timestamp: '2026-10-25T00:02:00.000Z',
      ordinal: 2,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2 } } },
    }),
    // 末尾一条：字段整体为 null（中转站常态），不能覆盖前值
    JSON.stringify({
      timestamp: '2026-10-25T00:03:00.000Z',
      ordinal: 3,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 3 } },
        rate_limits: { limit_id: 'codex', primary: null, secondary: null, plan_type: null },
      },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');

  const s = codex.parseRollout(file);
  assert.ok(s, 'fixture 必须能解析');
  assert.equal(s.provider, 'openai');
  assert.ok(s.rateLimits, '官方值必须被提取');
  assert.equal(s.rateLimits.primary.usedPercent, 13.0);
  assert.equal(s.rateLimits.primary.windowMinutes, 10080);
  // 末尾 null 没有覆盖前值：fetchedAt 仍是官方那条的时间
  assert.equal(s.rateLimits.fetchedAt, '2026-10-25T00:01:00.000Z');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('纯中转站 rollout（rate_limits 全 null）不产生额度', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rl-'));
  const file = path.join(dir, 'rollout-2026-10-25T00-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
  const lines = [
    JSON.stringify({
      timestamp: '2026-10-25T00:00:00.000Z',
      type: 'session_meta',
      payload: { cwd: 'D:\\work\\demo', model_provider: 'custom' },
    }),
    JSON.stringify({
      timestamp: '2026-10-25T00:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1 } },
        rate_limits: { limit_id: 'codex', primary: null, secondary: null, plan_type: null },
      },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');

  const s = codex.parseRollout(file);
  assert.equal(s.rateLimits, null, '全 null 时不得编造额度');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 单测：collectOfficialQuota（跨会话聚合）                             */
/* ------------------------------------------------------------------ */

test('collectOfficialQuota 取最近更新的那条（窗口内）', () => {
  const sessions = [
    { id: 'a', provider: 'openai', rateLimits: { primary: { usedPercent: 13, windowMinutes: 10080, resetsAt: null }, secondary: null, planType: null, fetchedAt: '2026-09-22T14:00:00.000Z' } },
    { id: 'b', provider: 'openai', rateLimits: { primary: { usedPercent: 24, windowMinutes: 10080, resetsAt: null }, secondary: null, planType: null, fetchedAt: '2026-09-22T15:00:00.000Z' } },
  ];
  const best = codex.collectOfficialQuota(sessions, Date.parse('2026-09-22T16:00:00.000Z'));
  assert.equal(best.primary.usedPercent, 24, '必须取时间戳更新的那条');

  assert.equal(codex.collectOfficialQuota([]), null);
  assert.equal(codex.collectOfficialQuota([{ id: 'c', rateLimits: null }]), null);
  assert.equal(codex.collectOfficialQuota(null), null);
});

test('新鲜度：数据年龄超过窗口时长即视为过期（旧百分比不得冒充当前额度）', () => {
  const sessions = [
    {
      id: 'old',
      // 7 天窗口、9/23 的数据 —— 到了 10/25 窗口早已重置
      rateLimits: {
        primary: { usedPercent: 24, windowMinutes: 10080, resetsAt: null },
        secondary: null,
        planType: null,
        fetchedAt: '2026-09-23T07:06:05.423Z',
      },
    },
  ];
  // 窗口内：显示
  assert.ok(codex.collectOfficialQuota(sessions, Date.parse('2026-09-25T00:00:00.000Z')));
  // 超过 7 天：必须丢弃
  assert.equal(codex.collectOfficialQuota(sessions, Date.parse('2026-10-25T00:00:00.000Z')), null);
});

test('新鲜度：resetsAt 已过 → 窗口已重置，旧值丢弃', () => {
  const sessions = [
    {
      id: 'reset',
      rateLimits: {
        primary: { usedPercent: 80, windowMinutes: 300, resetsAt: '2026-10-25T03:00:00Z' },
        secondary: null,
        planType: null,
        fetchedAt: '2026-10-25T01:00:00.000Z',
      },
    },
  ];
  assert.ok(codex.collectOfficialQuota(sessions, Date.parse('2026-10-25T02:00:00.000Z')), '重置前有效');
  assert.equal(
    codex.collectOfficialQuota(sessions, Date.parse('2026-10-25T04:00:00.000Z')),
    null,
    '重置后必须丢弃'
  );
});

/* ------------------------------------------------------------------ */
/* 接线静态防护（与 quota-render.test.js 同型）                         */
/* ------------------------------------------------------------------ */

test('index.js 必须把 codexQuota 算进 summary（数据源头）', () => {
  assert.match(indexCode, /codex\.collectOfficialQuota\(/, '必须调用 codex 的聚合函数');
  assert.match(indexCode, /codexQuota,/, 'summarizeAll 返回值必须挂 codexQuota');
});

test('renderer 必须读取 summary.codexQuota（防「算了不显示」回归）', () => {
  assert.match(
    rendererCode,
    /summary\.codexQuota/,
    'renderer 从未读取 codexQuota —— 官方百分比会算出却不显示，与 relayBalance bug 同型'
  );
});

test('官方百分比只在 Codex/ALL Tab 且真有窗口数据时显示', () => {
  assert.match(rendererCode, /showOfficial/, '必须有 showOfficial 判定');
  assert.match(
    rendererCode,
    /official\.primary\s*\|\|\s*official\.secondary/,
    '必须按 primary/secondary 任一存在判定，null 时不渲染'
  );
});

test('renderQuotas 必须支持 opts.official 分段开关', () => {
  assert.match(rendererCode, /opts\.official/, 'renderQuotas 必须接受 official 开关');
  assert.match(rendererCode, /officialShown/, '时间戳条件必须包含官方段');
});

test('重置时刻未知时不得编造倒计时', () => {
  assert.ok(
    /重置时刻未知/.test(rendererCode),
    'resets_at 为 null 时必须如实说明，不能显示假的重置时间'
  );
});
