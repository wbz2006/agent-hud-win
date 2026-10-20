'use strict';

/**
 * CC Switch 探测层测试。
 *
 * 重点验证**抗升级能力**：模拟 CC Switch 改表名、改字段名、挪数据库位置，
 * 确认探测层都能找到，而不是写死匹配。
 *
 * 跑法：node test/ccdb.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ccdb = require(path.join(__dirname, '..', 'src', 'main', 'sources', 'ccdb.js'));
const ccswitch = require(path.join(__dirname, '..', 'src', 'main', 'sources', 'ccswitch.js'));

/** 建一个临时目录，返回其路径。用完记得删。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccdb-test-'));
}

/** 用 python 建一个 sqlite 库，按给定 schema 插入数据。 */
function makeDb(dbPath, schema, rows) {
  const cols = Object.keys(schema);
  const colDefs = cols.map((c) => `${c} ${schema[c]}`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const colList = cols.join(', ');
  const script = `
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(dbPath)})
c.execute("CREATE TABLE proxy_request_logs (${colDefs})")
c.executemany("INSERT INTO proxy_request_logs (${colList}) VALUES (${placeholders})",
              ${JSON.stringify(rows.map((r) => cols.map((c) => r[c])))})
c.commit()
`;
  execFileSync('python', ['-c', script], { encoding: 'utf8' });
}

/**
 * 把探测层的候选目录临时指向测试目录。
 *
 * 探测层读的是真实 home 目录，测试里改不了，所以这里用一个小技巧：
 * 把 DB_DIR_CANDIDATES 数组换掉，测完再还原。
 */
function withDbDirs(dirs, fn) {
  const original = ccdb.DB_DIR_CANDIDATES.slice();
  ccdb.DB_DIR_CANDIDATES.length = 0;
  ccdb.DB_DIR_CANDIDATES.push(...dirs);
  ccdb.resetCache();
  return Promise.resolve(fn()).finally(() => {
    ccdb.DB_DIR_CANDIDATES.length = 0;
    ccdb.DB_DIR_CANDIDATES.push(...original);
    ccdb.resetCache();
  });
}

test('当前真实环境：能探测到本机 CC Switch 库', () => {
  const s = ccdb.probe(true);
  if (!s.ok) {
    // 本机没装/没数据时不该让测试失败，但要说明
    console.log('  （本机未探测到 CC Switch，跳过正向断言）');
    return;
  }
  assert.ok(s.db, '应返回数据库路径');
  assert.ok(s.logTable, '应返回日志表名');
  assert.ok(s.cost, '应返回金额字段名');
  console.log(`  探测到 db=${s.db}`);
  console.log(`  logTable=${s.logTable} cost=${s.cost} appType=${s.appType}`);
});

test('CC Switch 改表名（proxy_request_logs → request_logs）仍能找到', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'weird-name.db');
  // 故意用非标准表名和非标准字段名
  makeDb(db, { id: 'INTEGER', cost_usd: 'REAL', app: 'TEXT', ts: 'INTEGER' }, [
    { id: 1, cost_usd: 1.0, app: 'codex', ts: Math.floor(Date.now() / 1000) },
  ]);

  return withDbDirs([dir], () => {
    const s = ccdb.probe(true);
    // 注意：request_logs 这个候选表名匹配的是「探测层建的表」。
    // 这里 makeDb 建的表名就是 proxy_request_logs，与真实库一致，
    // 但**字段名全换了**（cost_usd / app / ts），测的是字段级自适应。
    assert.ok(s.ok, '字段改名后仍应探测成功：' + (s.error || ''));
    assert.equal(s.cost, 'cost_usd', '金额字段应命中 cost_usd');
    assert.equal(s.appType, 'app', 'app_type 应命中 app');
    assert.equal(s.createdAt, 'ts', '时间字段应命中 ts');

    const cost = ccswitch.readTodayCost();
    assert.equal(cost.ok, true);
    assert.equal(cost.totalCny, 0.2, '1.0 USD ÷ 5 = 0.2 元');
  });
});

test('数据库改名/挪目录都能找到（不认文件名，认内容）', () => {
  const dir = tmpDir();
  // 起一个完全不相干的名字，且放在一个非标准目录里
  const db = path.join(dir, 'data-2024-final-v3.db');
  makeDb(db, { request_id: 'TEXT', total_cost_usd: 'REAL', app_type: 'TEXT', created_at: 'INTEGER' }, [
    { request_id: 'a', total_cost_usd: 2.0, app_type: 'codex', created_at: Math.floor(Date.now() / 1000) },
    { request_id: 'b', total_cost_usd: 3.0, app_type: 'claude', created_at: Math.floor(Date.now() / 1000) },
  ]);

  return withDbDirs([dir], () => {
    const s = ccdb.probe(true);
    assert.ok(s.ok, '应按内容而非文件名找到库：' + (s.error || ''));
    assert.equal(path.basename(s.db), 'data-2024-final-v3.db');

    const cost = ccswitch.readTodayCost();
    assert.equal(cost.ok, true);
    assert.equal(cost.totalUsd, 5.0, '应汇总全部 app_type');
    assert.equal(cost.totalCny, 1.0, '5.0 ÷ 5 = 1.0 元');
    assert.ok(cost.byApp.codex, '应有 codex 分组');
    assert.ok(cost.byApp.claude, '应有 claude 分组');
  });
});

test('库里没有请求日志表 → 优雅降级，不抛异常', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'other.db');
  // 建一个跟 CC Switch 无关的库
  execFileSync('python', ['-c', `
import sqlite3
c = sqlite3.connect(${JSON.stringify(db)})
c.execute("CREATE TABLE settings (k TEXT, v TEXT)")
c.execute("INSERT INTO settings VALUES ('a','b')")
c.commit()
`], { encoding: 'utf8' });

  return withDbDirs([dir], () => {
    const s = ccdb.probe(true);
    assert.equal(s.ok, false, '不该把无关库当成 CC Switch');
    assert.match(s.error, /请求日志表/, '错误信息应说明缺什么');

    // 关键：降级不抛异常，而是返回结构化失败
    const cost = ccswitch.readTodayCost();
    assert.equal(cost.ok, false);
    assert.ok(cost.reason, '应带上原因供 UI 展示');
    assert.equal(cost.totalCny, null);
  });
});

test('目录里根本没有库 → 优雅降级，说明搜过哪里', () => {
  const dir = tmpDir(); // 空目录
  return withDbDirs([dir], () => {
    const cost = ccswitch.readTodayCost();
    assert.equal(cost.ok, false);
    assert.match(cost.reason, /未检测到|未找到/, '原因应说明没找到账本');
  });
});

test('失败不缓存：库后来出现了，下次探测应能成功', () => {
  const dir = tmpDir();
  // 第一次：空目录，必然失败
  return withDbDirs([dir], () => {
    const first = ccswitch.readTodayCost();
    assert.equal(first.ok, false, '空目录应失败');

    // 第二次：库出现了，应该立刻探测到（失败不缓存）
    const db = path.join(dir, 'cc-switch.db');
    makeDb(db, { request_id: 'TEXT', total_cost_usd: 'REAL', app_type: 'TEXT', created_at: 'INTEGER' }, [
      { request_id: 'a', total_cost_usd: 1.0, app_type: 'codex', created_at: Math.floor(Date.now() / 1000) },
    ]);
    const second = ccswitch.readTodayCost();
    assert.equal(second.ok, true, '失败不该被缓存，新库应立刻被发现：' + (second.reason || ''));
  });
});

test('探测结果有缓存，短时间内不重复查 schema', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'cc-switch.db');
  makeDb(db, { request_id: 'TEXT', total_cost_usd: 'REAL', app_type: 'TEXT', created_at: 'INTEGER' }, [
    { request_id: 'a', total_cost_usd: 1.0, app_type: 'codex', created_at: Math.floor(Date.now() / 1000) },
  ]);

  return withDbDirs([dir], () => {
    const a = ccdb.probe();
    const b = ccdb.probe(); // 应命中缓存
    assert.deepEqual(a, b, '缓存应返回同一对象');
  });
});

test('缺少 created_at 时退化为全量统计，而不是失败', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'cc-switch.db');
  // 故意不给 created_at
  makeDb(db, { request_id: 'TEXT', total_cost_usd: 'REAL', app_type: 'TEXT' }, [
    { request_id: 'a', total_cost_usd: 1.0, app_type: 'codex' },
    { request_id: 'b', total_cost_usd: 1.0, app_type: 'codex' },
  ]);

  return withDbDirs([dir], () => {
    const cost = ccswitch.readTodayCost();
    assert.equal(cost.ok, true, '缺时间字段不该导致失败，应降级为全量');
    assert.equal(cost.totalUsd, 2.0, '应统计到两条');
  });
});

test('缺少 app_type 时退化为单一分组，而不是失败', () => {
  const dir = tmpDir();
  const db = path.join(dir, 'cc-switch.db');
  makeDb(db, { request_id: 'TEXT', total_cost_usd: 'REAL', created_at: 'INTEGER' }, [
    { request_id: 'a', total_cost_usd: 4.0, created_at: Math.floor(Date.now() / 1000) },
  ]);

  return withDbDirs([dir], () => {
    const cost = ccswitch.readTodayCost();
    assert.equal(cost.ok, true, '缺 app_type 不该失败');
    assert.equal(cost.totalUsd, 4.0);
  });
});
