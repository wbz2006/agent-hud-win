'use strict';

/**
 * DSH 端口探测的判据测试（2026-10-24 的真实故障）。
 *
 * 症状：WorkBuddy 额度区连的不是 DSH，而是 VS Code Cortex-Debug 的
 * 127.0.0.1:55878（一个非 HTTP 的调试端口，请求会把字节写进别人的 socket 然后挂死）。
 *
 * 三个根因，本文件逐个钉住：
 *   1. 判据是「HTTP 200」而不是「响应形状符合插件契约」——
 *      本机 4310 的二进制服务对任意路径都回 200 + 乱码，被当成 DSH；
 *      `{"ret":1,"version":"3"}` 这类无关 JSON 同理。
 *   2. 候选是本机**所有**监听端口 —— 别人的调试/服务端口被拉进来当候选。
 *      正解：用插件心跳里的 pid 把候选收敛到 DSH 自己的端口。
 *   3. 探测路径过期（旧插件 id），正确端口回 404 → 永远不可能命中，
 *      只剩噪音端口互相竞争。
 *
 * 这样测是因为：这些判据全是纯函数，喂假数据就能复现"假命中"，
 * 不必真去扫端口（扫端口既慢又不稳定，还会碰到别人的服务）。
 *
 * 跑法：node --test test/port-probe.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const quota = require('../src/main/sources/quota');
const { __test } = quota;
const { looksLikeWorkBuddyDoc, docToRecord, parseNetstatListening, pickProbe, readHeartbeatPid } = __test;

/* ------------------------------------------------------------------ *
 * 1. 身份判据：形状，不是状态码
 * ------------------------------------------------------------------ */

test('现役插件的 usage 文档（含 detail=fast 快文档）算命中', () => {
  const full = {
    status: 'signed-in',
    accountId: '2d1257b19f43258065b1af43',
    accountName: 'wbzher',
    domain: 'www.workbuddy.cn',
    credits: { total: 2112.94, packages: [{ packageName: 'p', remain: 1, size: 2 }] },
    accounts: [],
  };
  assert.equal(looksLikeWorkBuddyDoc(full), true, '完整 usage 文档必须命中');

  // fast 文档整块省略 credits（插件文档承诺：零上游调用），只剩本地状态
  const fast = {
    status: 'signed-in',
    accountId: '2d1257b19f43258065b1af43',
    accountName: 'wbzher',
    domain: 'www.workbuddy.cn',
    accounts: [{ id: 'x' }],
  };
  assert.equal(looksLikeWorkBuddyDoc(fast), true, 'detail=fast 文档必须命中，否则探测会把它漏掉');
});

test('遗留插件的 status 文档算命中（有些机器还装着旧包名）', () => {
  assert.equal(looksLikeWorkBuddyDoc({ status: 'signed-out' }), true);
  assert.equal(looksLikeWorkBuddyDoc({ credits: { total: 10, accounts: [] } }), true);
});

test('未登录文档也算命中（端口对、只是账号掉了）', () => {
  assert.equal(looksLikeWorkBuddyDoc({ status: 'signed-out', accountId: 'x' }), true);
});

test('200 但不是插件文档 —— 一律不算命中（4310 的教训）', () => {
  const noise = [
    null,
    undefined,
    'ok',
    42,
    [],
    { ret: 1, version: '3' },                 // 本机 28317 那个无关服务
    { ok: true },                             // 鲸鱼/其它插件路由
    { status: 'ok' },                         // 状态字段存在但不是 signed-in/out
    { credits: { total: 'many' } },           // total 不是数字
    { accounts: [] },
    { hello: 'world' },
  ];
  for (const doc of noise) {
    assert.equal(looksLikeWorkBuddyDoc(doc), false, `不该把 ${JSON.stringify(doc)} 当成 DSH 额度文档`);
  }
});

test('探测分级：只有能取数的 level 3 才优先，其次才退 401', () => {
  const results = [
    { port: 4310, level: 1 },
    { port: 2061, level: 3 },
    { port: 2064, level: 1 },
  ];
  assert.equal(pickProbe(results).port, 2061);

  // 全是 401 时退到 401（端口是 DSH 的，只是被 bearer 栅栏挡住）
  const fenced = [
    { port: 8326, level: 1 },
    { port: 55878, level: 0 },
  ];
  assert.equal(pickProbe(fenced).port, 8326);

  // 只有不可达端口 → 没有命中，返回 null（宁可显示不可用，也不选错端口）
  assert.equal(pickProbe([{ port: 55878, level: 0 }]), null);
  assert.equal(pickProbe([]), null);
});

/* ------------------------------------------------------------------ *
 * 2. 候选收敛：只探 DSH 自己的端口
 * ------------------------------------------------------------------ */

const NETSTAT = `
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2704
  TCP    127.0.0.1:2061         0.0.0.0:0              LISTENING       39128
  TCP    127.0.0.1:2064         0.0.0.0:0              LISTENING       39128
  TCP    127.0.0.1:55878        0.0.0.0:0              LISTENING       51988
  TCP    127.0.0.1:4310         0.0.0.0:0              LISTENING       42380
  TCP    0.0.0.0:8082           0.0.0.0:0              LISTENING       42380
  TCP    [::1]:8326            [::]:0                 LISTENING       39128
  TCP    192.168.31.9:139       0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:2061         0.0.0.0:0              ESTABLISHED     39128
`;

test('netstat 解析要带 pid 归属：同一 pid 的端口归一组', () => {
  const byPid = parseNetstatListening(NETSTAT);
  assert.deepEqual([...byPid.get(39128)].sort((a, b) => a - b), [2061, 2064, 8326], 'DSH 主进程的端口');
  assert.deepEqual([...byPid.get(51988)], [55878], 'Cortex-Debug 的端口必须能识别出来（以便排除）');
  assert.deepEqual([...byPid.get(42380)].sort((a, b) => a - b), [4310, 8082]);
  assert.equal(byPid.has(4), false, '非回环/非任意地址（LAN IP）不收');
  assert.equal(byPid.has(2704), false, '1024 以下的系统端口不收');
  assert.equal(byPid.get(39128).has(2061) && byPid.get(39128).size, 3, 'ESTABLISHED 行不算监听');
});

test('心跳里的 pid 能读出来；文件坏了返回 null 而不是抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-heartbeat-'));
  const good = path.join(dir, 'hb.json');
  fs.writeFileSync(good, JSON.stringify({ version: 1, pid: 39128 }));
  assert.equal(readHeartbeatPid(good), 39128);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(readHeartbeatPid(bad), null);

  const noPid = path.join(dir, 'nopid.json');
  fs.writeFileSync(noPid, JSON.stringify({ version: 1 }));
  assert.equal(readHeartbeatPid(noPid), null);

  assert.equal(readHeartbeatPid(path.join(dir, 'missing.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('候选端口必须来自 DSH 进程，而不是「所有监听端口」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'sources', 'quota.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.match(code, /async function findDshPort/, '必须有端口探测函数');
  assert.match(code, /function dshOwnedPorts/, '必须有「DSH 自己的端口」收敛函数');
  assert.match(code, /readHeartbeatPid/, '必须读插件心跳拿 pid');
  assert.match(code, /const owned = dshOwnedPorts\(\)/, 'findDshPort 必须先取身份链端口');
  assert.match(
    code,
    /const candidates = owned\.length\s*\n?\s*\? owned\s*\n?\s*:/,
    '有身份链端口时只用它们，身份链断裂才允许盲扫'
  );
  assert.ok(
    !/probePort\([^)]*\)\.then|listLocalListeningPorts/.test(code),
    '不该再有「全端口列表直接当候选」的老路径'
  );
  assert.match(code, /looksLikeWorkBuddyDoc\(doc\)/, '探测必须以响应形状为命中判据');
  assert.match(code, /detail=fast/, '探测走快文档，别每轮替用户打上游计费接口');
});

/* ------------------------------------------------------------------ *
 * 3. 路由与响应映射
 * ------------------------------------------------------------------ */

test('现役插件优先、遗留插件兜底：每个 key 至少两条候选路由', () => {
  const byKey = new Map(quota.ENDPOINTS.map((ep) => [ep.key, ep]));
  assert.ok(byKey.has('workbuddy') && byKey.has('workbuddy-ai'), '两个账号形态都要有');

  for (const [key, ep] of byKey) {
    const paths = ep.paths.map((p) => p.path);
    assert.ok(
      paths.some((p) => p.startsWith('/plugins/dsh-connect-workbuddy/usage')),
      `${key} 必须先试现役插件路由`
    );
    assert.ok(
      paths.some((p) => p.startsWith('/plugins/dsh-workbuddy-connect/')),
      `${key} 必须保留遗留插件路由兜底`
    );
  }

  // 区域必须显式带上：不带 region 会落到"当前选中账号"，两个 key 就分不开了
  assert.match(byKey.get('workbuddy').paths[0].path, /region=cn/);
  assert.match(byKey.get('workbuddy-ai').paths[0].path, /region=global/);
});

test('现役 usage 文档映射成 UI 记录（packages → accounts）', () => {
  const ep = { key: 'workbuddy', label: 'WorkBuddy' };
  const doc = {
    status: 'signed-in',
    domain: 'www.workbuddy.cn',
    credits: {
      total: 2112.94000082,
      packages: [
        { packageName: '个人版', remain: 712.94, size: 1500 },
        { packageName: '体验版', remain: 0, size: 500, monthly: true, cycleRefreshMs: 1793462400000 },
      ],
      nearestExpiryMs: 1794222239000,
    },
  };
  const rec = docToRecord(ep, doc, 2061);
  assert.equal(rec.ok, true);
  assert.equal(rec.total, 2112.94000082);
  assert.equal(rec.accounts.length, 2);
  assert.deepEqual(rec.accounts[0], { packageName: '个人版', remain: 712.94, size: 1500, unlimited: false });
  assert.equal(rec.expiresAt, 1794222239000, '取最近的到期时间');
  assert.equal(rec.domain, 'www.workbuddy.cn');
  assert.equal(rec.port, 2061, '记录端口，排查时能直接看出连的是哪个');
});

test('遗留 status 文档也映射（accounts 而不是 packages）', () => {
  const rec = docToRecord({ key: 'workbuddy', label: 'WorkBuddy' }, {
    credits: { total: 10, accounts: [{ packageName: 'old', remain: 3, size: 5, unlimited: false }] },
    expiresAt: 1700000000000,
  }, 19387);
  assert.equal(rec.ok, true);
  assert.equal(rec.total, 10);
  assert.equal(rec.accounts[0].packageName, 'old');
  assert.equal(rec.expiresAt, 1700000000000);
});

test('三种降级路径都不许把失败写成 0', () => {
  const ep = { key: 'workbuddy', label: 'WorkBuddy' };

  const signedOut = docToRecord(ep, { status: 'signed-out' }, 2061);
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.total, null, '未登录不能显示 0');
  assert.equal(signedOut.error, '未登录');

  const creditsError = docToRecord(ep, { status: 'signed-in', creditsError: 'upstream 429' }, 2061);
  assert.equal(creditsError.ok, false);
  assert.equal(creditsError.total, null);
  assert.match(creditsError.error, /429/);

  const wrongShape = docToRecord(ep, { ret: 1, version: '3' }, 4310);
  assert.equal(wrongShape.ok, false);
  assert.equal(wrongShape.total, null);
  assert.match(wrongShape.error, /4310/, '错误信息要带端口，方便下次直接定位');
});
