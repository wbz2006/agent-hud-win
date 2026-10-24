'use strict';

/**
 * 积分消耗账本（余额差值法）单元测试。
 *
 * 这套逻辑最容易出的三个错都必须被钉住：
 *   1) 首次读数被当成"消耗"（应记 0）
 *   2) 充值被当成"负消耗"（应只更新基线）
 *   3) 跨日不归零（应把今日已用清零，但保留余额基线）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { track, dayKey } = require(path.join(__dirname, '..', 'src', 'main', 'sources', 'dsh-spend.js'));

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spend-'));
  return path.join(dir, name || 'state.json');
}

const credit = (total) => [{ key: 'workbuddy', ok: true, total }];

test('首次读数不产生消耗，只建立基线', () => {
  const file = tmpFile();
  const now = new Date(2026, 9, 23, 10, 0, 0).getTime();
  const r = track(credit(1000), { now, file });
  assert.equal(r.ok, true);
  assert.equal(r.todayCredits, 0, '第一次只建立基线，不能把余额算成消耗');
  assert.equal(r.balance, 1000);
});

test('余额下降累计为已用积分', () => {
  const file = tmpFile();
  const t0 = new Date(2026, 9, 23, 10, 0, 0).getTime();
  track(credit(1000), { now: t0, file });
  const r = track(credit(985), { now: t0 + 60000, file });
  assert.equal(r.todayCredits, 15);
  const r2 = track(credit(980), { now: t0 + 120000, file });
  assert.equal(r2.todayCredits, 20, '多次采集应累计，而不是只取最后一次差值');
});

test('充值/套餐变更只更新基线，不记负消耗', () => {
  const file = tmpFile();
  const t0 = new Date(2026, 9, 23, 11, 0, 0).getTime();
  track(credit(500), { now: t0, file });
  const r1 = track(credit(490), { now: t0 + 60000, file });
  assert.equal(r1.todayCredits, 10);
  // 充值 +200 → 690
  const r2 = track(credit(690), { now: t0 + 120000, file });
  assert.equal(r2.todayCredits, 10, '余额上升是充值，不能把消耗冲成负数');
  // 充值后继续用掉 5 → 685
  const r3 = track(credit(685), { now: t0 + 180000, file });
  assert.equal(r3.todayCredits, 15, '充值后的新消耗要能继续累计');
});

test('跨日把今日消耗归零，但保留余额基线', () => {
  const file = tmpFile();
  const day1 = new Date(2026, 9, 23, 23, 50, 0).getTime();
  track(credit(800), { now: day1, file });
  const r1 = track(credit(760), { now: day1 + 60000, file });
  assert.equal(r1.todayCredits, 40);

  const day2 = new Date(2026, 9, 24, 0, 10, 0).getTime();
  const r2 = track(credit(750), { now: day2, file });
  assert.equal(dayKey(day2), '2026-10-24');
  assert.equal(r2.todayCredits, 10, '跨日后只算新一天下降的 10 积分');
  assert.equal(r2.balance, 750);
});

test('余额不可用时返回 ok:false，不编造 0', () => {
  const file = tmpFile();
  const r = track([{ key: 'workbuddy', ok: false, error: 'DSH 未运行或路由不可达' }], { now: Date.now(), file });
  assert.equal(r.ok, false);
  assert.equal(r.todayCredits, null, '拿不到余额时必须是 null，显示 0 会被误读成"没花钱"');
  assert.match(r.reason, /不可用/);
});

test('两个账号的消耗合并统计', () => {
  const file = tmpFile();
  const t0 = new Date(2026, 9, 23, 9, 0, 0).getTime();
  track(
    [
      { key: 'workbuddy', ok: true, total: 500 },
      { key: 'workbuddy-ai', ok: true, total: 200 },
    ],
    { now: t0, file }
  );
  const r = track(
    [
      { key: 'workbuddy', ok: true, total: 495 },
      { key: 'workbuddy-ai', ok: true, total: 199 },
    ],
    { now: t0 + 30000, file }
  );
  assert.equal(r.todayCredits, 6, '5 + 1 应合并成 6');
  assert.equal(r.balance, 694);
});
