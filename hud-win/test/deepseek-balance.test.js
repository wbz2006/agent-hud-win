'use strict';

/**
 * DeepSeek 官方余额（鲸鱼账本 → 鲸鱼 HTTP 路由 → 官方 API Key）测试。
 *
 * 关键是"不许编数字"的边界：
 *   1) 账本日期不是今天 → todayUsage 置 null（过期数据不能冒充今日）
 *   2) 账本缺失/损坏/字段不是数 → ok:false + 原因，不显示 0
 *      （尤其 lastBalance:null：Number(null)=0，曾经会把"还没取到余额"显示成 ¥0.00）
 *   3) 字段改名时先试别名，别名全落空才失败；失败后继续走下一级通道
 *   4) 鲸鱼路由的响应形状与账本不同（totalBalance/currency/version），单独覆盖
 *
 * 用 DSH_HOME 指向临时目录，保证不读用户真实账本（否则测试结果随本机状态变）。
 * 需要跑 HTTP 兜底的用例显式传 http:false，或临时替换 quota.findDshPort ——
 * 本机 DSH 若在跑，不打桩会读到真实余额，断言就失去意义。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modPath = path.join(__dirname, '..', 'src', 'main', 'sources', 'deepseek-balance.js');
const quotaPath = path.join(__dirname, '..', 'src', 'main', 'sources', 'quota.js');

function withHome(ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-bal-'));
  if (ledger !== undefined) {
    fs.writeFileSync(path.join(dir, '.dshw-usage.json'), typeof ledger === 'string' ? ledger : JSON.stringify(ledger), 'utf8');
  }
  process.env.DSH_HOME = dir;
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function todayKey() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 临时把 quota.findDshPort 换成固定端口（避免测试里真跑 netstat）。 */
function withPort(port, fn) {
  const quota = require(quotaPath);
  const real = quota.findDshPort;
  quota.findDshPort = async () => port;
  return Promise.resolve(fn()).finally(() => {
    quota.findDshPort = real;
  });
}

/** 按 URL 分派的 fetch 桩：鲸鱼路由 / 官方余额接口各给一份数据（值或函数）。 */
function stubFetch(handlers) {
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (handlers.route !== undefined && u.includes('/dsh-whale/balance.json')) {
      const payload = typeof handlers.route === 'function' ? handlers.route() : handlers.route;
      return { ok: true, status: 200, json: async () => payload };
    }
    if (handlers.api !== undefined && u.includes('api.deepseek.com')) {
      const payload = typeof handlers.api === 'function' ? handlers.api() : handlers.api;
      return { ok: true, status: 200, json: async () => payload };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return () => {
    global.fetch = real;
  };
}

test('账本可用时解析余额与今日已用', async () => {
  const m = withHome({
    date: todayKey(),
    lastBalance: 3.025124,
    todayUsage: 2.467841,
    accounting: { active: 'abc-CNY' },
  });
  const r = await m.fetchBalance({ http: false });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'whale-ledger');
  assert.ok(Math.abs(r.total - 3.025124) < 1e-9);
  assert.ok(Math.abs(r.todayUsage - 2.467841) < 1e-9);
  assert.equal(r.currency, 'CNY');
});

test('账本日期不是今天时，今日已用置 null（不拿过期数据充数）', async () => {
  const m = withHome({ date: '2026-01-01', lastBalance: 10, todayUsage: 5 });
  const r = await m.fetchBalance({ http: false });
  assert.equal(r.ok, true);
  assert.equal(r.total, 10);
  assert.equal(r.todayUsage, null);
});

test('账本缺失时返回 ok:false，不显示 0', async () => {
  const m = withHome(undefined);
  const r = await m.fetchBalance({ http: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未找到鲸鱼账本/);
  assert.equal(r.total, undefined, '失败结果里不得带 total');
});

test('账本损坏时报 JSON 错误而不是抛异常', async () => {
  const m = withHome('{not json');
  const r = await m.fetchBalance({ http: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /合法 JSON/);
});

test('lastBalance:null（新建账本还没取到过余额）不得显示成 0', async () => {
  const m = withHome({ date: todayKey(), lastBalance: null, todayUsage: 0 });
  const r = await m.fetchBalance({ http: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /缺少余额字段/);
});

test('字段别名容错：balance / totalBalance 也认，字符串数字也认', async () => {
  const a = withHome({ date: todayKey(), balance: 7.5 });
  assert.equal((await a.fetchBalance({ http: false })).total, 7.5);

  const b = withHome({ date: todayKey(), totalBalance: '2.50' });
  const rb = await b.fetchBalance({ http: false });
  assert.equal(rb.ok, true);
  assert.equal(rb.total, 2.5);

  const c = withHome({ date: todayKey(), lastBalance: 1, todayUsed: 0.5 });
  assert.equal((await c.fetchBalance({ http: false })).todayUsage, 0.5);
});

test('币种跟着 accounting.active（USD 本币不再被当成人民币）', async () => {
  const m = withHome({ date: todayKey(), lastBalance: 3.02, accounting: { active: 'bd52-CNY' } });
  assert.equal((await m.fetchBalance({ http: false })).currency, 'CNY');

  const m2 = withHome({ date: todayKey(), lastBalance: 3.02, accounting: { active: 'bd52-USD' } });
  assert.equal((await m2.fetchBalance({ http: false })).currency, 'USD');
});

test('账本可用时优先账本，不打 HTTP 路由', async () => {
  const m = withHome({ date: todayKey(), lastBalance: 1.11 });
  let calls = 0;
  const restore = stubFetch({
    route: () => {
      calls += 1;
      return { ok: true, totalBalance: 9.99, currency: 'CNY', todayUsage: 0 };
    },
  });
  try {
    const r = await withPort(8734, () => m.fetchBalance({}));
    assert.equal(r.source, 'whale-ledger');
    assert.equal(r.total, 1.11);
    assert.equal(calls, 0, '账本可用时不该请求路由');
  } finally {
    restore();
  }
});

test('账本余额字段缺失时自动落到鲸鱼路由（升级后的自愈路径）', async () => {
  // 模拟上游把 lastBalance 改名成别的、别名也认不出的情形
  const m = withHome({ date: todayKey(), newBalanceField: 5 });
  const restore = stubFetch({
    route: { ok: true, totalBalance: 2.42, currency: 'USD', todayUsage: 0.05, version: '0.5.0' },
  });
  try {
    const r = await withPort(8734, () => m.fetchBalance({}));
    assert.equal(r.ok, true);
    assert.equal(r.source, 'whale-http');
    assert.equal(r.total, 2.42);
    assert.equal(r.currency, 'USD');
    assert.equal(r.pluginVersion, '0.5.0');
    assert.equal(r.todayUsage, 0.05);
    assert.equal(r.stale, false);
  } finally {
    restore();
  }
});

test('鲸鱼路由返回 ok:false 时继续降级，不编数字', async () => {
  const m = withHome(undefined);
  const restore = stubFetch({ route: { ok: false, code: 'ERROR', error: '账本不可用' } });
  try {
    const r = await withPort(8734, () => m.fetchBalance({}));
    assert.equal(r.ok, false);
    assert.match(r.reason, /鲸鱼路由报错：账本不可用/);
    assert.match(r.reason, /未配置 DeepSeek API Key/);
  } finally {
    restore();
  }
});

test('DSH 未运行（探不到端口）时路由那条给明确原因', async () => {
  const m = withHome(undefined);
  const quota = require(quotaPath);
  const real = quota.findDshPort;
  quota.findDshPort = async () => null;
  try {
    const r = await m.fetchBalance({});
    assert.equal(r.ok, false);
    assert.match(r.reason, /DSH 未运行，鲸鱼路由不可达/);
  } finally {
    quota.findDshPort = real;
  }
});

test('鲸鱼路由 401：说明是宿主会话鉴权栅栏，不冒充"没有数据"', async () => {
  // 实测本机 GUI 端口就是这种：路由存在但要求浏览器会话（HUD 没有）
  const m = withHome(undefined);
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    const r = await m.readWhaleHttp({ port: 2061 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /浏览器会话鉴权/);
    assert.equal(r.total, undefined);
  } finally {
    global.fetch = real;
  }
});

test('端口选错（无关服务对任意路径回 200）不会被当成余额', async () => {
  // 本机 28317 上有个对任意路径都回 {"ret":1,"version":"3"} 的服务
  const m = withHome(undefined);
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ret: 1, version: '3' }) });
  try {
    const r = await m.readWhaleHttp({ port: 28317 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /形状不符|不是余额/);
    assert.equal(r.total, undefined);
  } finally {
    global.fetch = real;
  }
});

test('readApiBalance：401 给出明确原因', async () => {
  const m = withHome(undefined);
  const real = global.fetch;
  global.fetch = async () => ({ status: 401, ok: false, json: async () => ({}) });
  try {
    const r = await m.readApiBalance('sk-bad');
    assert.equal(r.ok, false);
    assert.match(r.reason, /无效|失效/);
  } finally {
    global.fetch = real;
  }
});

test('readApiBalance：正常响应优先取 CNY 账户', async () => {
  const m = withHome(undefined);
  const real = global.fetch;
  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '1.00' },
        { currency: 'CNY', total_balance: '110.00' },
      ],
    }),
  });
  try {
    const r = await m.readApiBalance('sk-good');
    assert.equal(r.ok, true);
    assert.equal(r.total, 110);
    assert.equal(r.currency, 'CNY');
  } finally {
    global.fetch = real;
  }
});

test('readApiBalance：total_balance 为 null 判失败而不是 0', async () => {
  const m = withHome(undefined);
  const real = global.fetch;
  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: null }] }),
  });
  try {
    const r = await m.readApiBalance('sk-good');
    assert.equal(r.ok, false);
    assert.match(r.reason, /不是数字/);
  } finally {
    global.fetch = real;
  }
});
