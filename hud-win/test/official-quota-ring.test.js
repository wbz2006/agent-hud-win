'use strict';

/**
 * 官方额度驱动圆环（2026-10-31 用户反馈）：
 *
 * 切到官方账号的 Codex 后，圆环与展开态金额标签必须改说「配额」——
 * 环弧 = 最紧窗口已用比例，标签 = 剩余百分比，颜色随剩余多少变。
 * 之前环永远走「今日花费/预算」口径，官方百分比只存在于卡片额度区，
 * 用户在胶囊上看不到任何剩余额度（官方账号当天没花钱时还是一条横线）。
 *
 * 数据链路：collectOfficialQuota（已按窗口时长过滤过期）→ summarizeAll 的
 * summary.codexQuota → sourceMeterItems 挑最紧窗口挂到 item.quota →
 * markHtml 用它画弧/标签/颜色。无官方数据（中转站）时 quota 为 null，
 * 一切保持花费/预算口径 —— 本组断言保证两条口径的代码都在。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');

test('sourceMeterItems 必须把官方窗口挂到 item.quota（仅 codex）', () => {
  assert.match(src, /if \(key === 'codex' && summary\.codexQuota\) \{/, '没有从 summary.codexQuota 取官方窗口');
  assert.match(src, /quota: officialQuota,/, 'item 上没有挂 quota 字段');
  // 只挑"最紧"窗口：已用比例最高
  assert.match(src, /w\.usedPercent > a\.usedPercent \? w : a/, '没有按已用比例挑最紧窗口');
});

test('markHtml 官方口径：弧长=已用比例、标签=剩余百分比、颜色分档', () => {
  assert.match(src, /const q = r\.quota \|\| null;/, 'markHtml 没读 item.quota');
  assert.match(src, /q\.usedPercent \/ 100/, '官方口径下弧长不是已用比例');
  assert.match(src, /剩 \$\{Math\.round\(qRemain\)\}%/, '金额标签位没有剩余百分比分支');
  // 颜色阈值与面板额度区一致（>=50 绿 / >=20 黄 / 更低红）
  assert.match(
    src,
    /qRemain >= 50 \? COLOR\.ok : qRemain >= 20 \? COLOR\.w : COLOR\.c/,
    '官方额度环色没有按剩余分档'
  );
});

test('官方口径只覆盖标签位，无官方数据时仍回退花费/预算', () => {
  // 花费/预算口径必须保留（中转站用户的现状）
  assert.match(src, /DAILY_BUDGET_CNY > 0 && todayCny != null && todayCny >= 0/, '花费/预算口径丢了');
  assert.match(src, /'&mdash;'/, '无数据横线兜底丢了');
});

test('官方窗口提示与面板额度区共用一套窗口名', () => {
  assert.match(src, /function quotaWindowName\(/, '缺少 quotaWindowName 助手');
  // 面板额度区不再内联一套窗口名
  assert.doesNotMatch(src, /w\.windowMinutes === 300\s*\?\s*'5 小时窗口'/, '面板额度区还在内联窗口名');
  assert.match(src, /quotaWindowName\(w\.windowMinutes\)/, '面板额度区没有换用 quotaWindowName');
});

test('官方额度提示必须带数据时刻与重置时刻（防旧值冒充当前额度）', () => {
  assert.match(src, /function officialQuotaTip\(/);
  const body = src.match(/function officialQuotaTip\([\s\S]*?\n\}/);
  assert.ok(body, '找不到 officialQuotaTip 函数体');
  assert.match(body[0], /q\.fetchedAt/, '提示里没有数据时刻');
  assert.match(body[0], /q\.resetsAt/, '提示里没有重置时刻');
  assert.match(body[0], /重置时刻未知/, 'resetsAt 缺失时没有如实说明');
});
