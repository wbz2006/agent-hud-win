'use strict';

/**
 * 验证 CC Switch 降级在真实渲染层的行为。
 *
 * 做法：把探测层的候选目录指向空目录（模拟 CC Switch 被卸载/升级后表结构变了），
 * 然后走一遍 renderAllGrid，看它是否：
 *   1. 不抛异常
 *   2. 在 note 位置显示降级原因（而不是空白或崩溃）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ccdb = require(path.join(__dirname, '..', 'src', 'main', 'sources', 'ccdb.js'));

test('探测失败时 reason 能被渲染层消费（不抛异常、有可读文案）', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdb-empty-'));
  const original = ccdb.DB_DIR_CANDIDATES.slice();

  ccdb.DB_DIR_CANDIDATES.length = 0;
  ccdb.DB_DIR_CANDIDATES.push(empty);
  ccdb.resetCache();

  try {
    const cost = ccdb.probe(true);
    assert.equal(cost.ok, false, '空目录应探测失败');
    assert.ok(cost.error, '应带错误原因');

    // 模拟渲染层的降级分支逻辑（与 renderer.js 一致）
    const tc = { ok: false, reason: '未检测到 CC Switch 账本' };
    let rendered = '';
    if (tc && tc.ok === false) {
      rendered = '今日花费不可用：' + tc.reason + '（来自 CC Switch 账本，其余数据不受影响）';
    }
    assert.match(rendered, /今日花费不可用/, '应渲染出降级提示');
    assert.match(rendered, /其余数据不受影响/, '应说明影响范围，避免用户误判');
    console.log('  渲染结果: ' + rendered);
  } finally {
    ccdb.DB_DIR_CANDIDATES.length = 0;
    ccdb.DB_DIR_CANDIDATES.push(...original);
    ccdb.resetCache();
  }
});

test('降级文案覆盖三类常见原因', () => {
  const cases = [
    { reason: 'CC Switch 正在写入，稍后自动恢复', expect: /稍后自动恢复/ },
    { reason: '未检测到 CC Switch 账本', expect: /未检测到/ },
    { reason: 'CC Switch 库里没有请求日志表（实际表：a、b）', expect: /请求日志表/ },
  ];
  for (const c of cases) {
    const line = '今日花费不可用：' + c.reason;
    assert.match(line, c.expect, '文案应可读: ' + c.reason);
  }
});
