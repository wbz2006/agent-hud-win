'use strict';

/**
 * DeepSeek 官方账户余额。
 *
 * 三条取数通道，按"离线可用性"排优先级（不是按新旧）：
 *   ① 鲸鱼账本（whale-ledger）：`~/.dsh/.dshw-usage.json`
 *      小鲸鱼插件把每次取到的余额落盘（同时覆盖 API Key 与 DSH 账号登录态两条取数路径）。
 *      优点：DSH 没在跑也能读到上次的值；缺点：字段是"别人写的"，会随插件升级变。
 *   ② 鲸鱼 HTTP 路由（whale-http）：`GET http://127.0.0.1:<port>/dsh-whale/balance.json`
 *      插件在 DSH web server 上注册的只读路由，返回
 *      `{ok, totalBalance, currency, todayUsage, version, ...}`。
 *      它是插件 README 明文记载的对外接口，且自带插件版本号 ——
 *      账本字段改名/挪位时的第二顺位。
 *      代价：必须 DSH 正在运行（端口由 quota.findDshPort() 探测，与额度区共用缓存）；
 *      **且当前 DSH 版本上该路由被浏览器会话栅栏挡住（实测 401）**，见 readWhaleHttp 的注释。
 *   ③ 官方余额接口（api）：`GET https://api.deepseek.com/user/balance`（Bearer <sk-...>）
 *      需要用户自备 API Key；只在①②都拿不到时用。
 *
 * 三条都失败就如实返回 ok:false + 两条原因，界面显示"不可用"，**绝不显示 0**。
 *
 * 账本文件结构（实测 2026-10-23，插件 dsh-whale-widget 0.4.2）：
 *   {
 *     "date": "2026-10-23",
 *     "lastBalance": 3.025124,        // 当前余额（元）——上游 accounting.mjs 注释为"兼容字段"
 *     "todayUsage": 2.467841,         // 当天已用（元，余额观测法）
 *     "history": { "2026-10-23": 2.467841, ... },
 *     "accounting": { "version": 1, "active": "<key指纹>-CNY", "books": { ... } }
 *   }
 *
 * 三条必须守住的边界：
 *   1) 账本是**别人写的**：文件缺失/JSON 损坏/字段缺失 → ok:false + 原因，不编数字。
 *   2) 账本会**变旧**：DSH 或鲸鱼没在跑时不会刷新。超过 FRESH_MS 标 stale，
 *      界面据此提示"数据可能不是最新"，而不是把旧余额当实时值。
 *   3) `date` 不是今天 → 说明账本停了跨天没更新，todayUsage 不可信，置 null。
 *
 * 字段容错（2026-10-24 加固）：上游把这些字段标注为兼容字段、无稳定性承诺，
 * 所以按别名取值（见 BALANCE_KEYS / TODAY_KEYS），但仍必须能解析成有限数字；
 * 别名全落空才判失败 —— 容错只放宽"名字"，不放宽"必须有数"。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/** 与鲸鱼插件同序的候选路径（桌面端只认 $DSH_HOME，profiles/web 是旧版兜底）。 */
const LEDGER_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
];

/** 账本超过这个时间没更新就标记 stale（鲸鱼每轮对话/每次取余额都会写）。 */
const FRESH_MS = 15 * 60 * 1000;

const API_ENDPOINT = 'https://api.deepseek.com/user/balance';

/** 鲸鱼插件的只读余额路由（相对 DSH web server 的根）。 */
const WHALE_HTTP_PATH = '/dsh-whale/balance.json';

/** 余额字段别名：账本用 lastBalance，HTTP 路由用 totalBalance，其余为可疑的将来命名。 */
const BALANCE_KEYS = ['lastBalance', 'balance', 'totalBalance'];
/** 今日已用别名。 */
const TODAY_KEYS = ['todayUsage', 'todayUsed'];

function todayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 只接受"确实是个数"的值。
 *
 * null / undefined / '' 一律返回 null —— 上游新建账本时写的是
 * `lastBalance: null`（还没取到过余额），而 `Number(null)` 是 0，
 * 直接转 Number 会让界面显示 "余额 ¥0.00"，把一个"还没数据"渲染成"钱花光了"。
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 按别名顺序取第一个能解析成有限数字的字段。
 * 返回 null 表示"没有可用的数"—— 调用方必须据此判失败，不许回落到 0。
 */
function firstNum(doc, keys) {
  if (!doc || typeof doc !== 'object') return null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(doc, k)) continue;
    const n = num(doc[k]);
    if (n !== null) return n;
  }
  return null;
}

/** 币种：账本从 accounting.active 尾部取（形如 "<id>-CNY"），路由直接给 currency。 */
function currencyOf(doc) {
  try {
    const active = doc && doc.accounting && doc.accounting.active;
    const m = typeof active === 'string' ? /-([A-Z]{3})$/.exec(active) : null;
    if (m) return m[1];
  } catch {
    /* 拿不到就看下一条 */
  }
  return typeof (doc && doc.currency) === 'string' && doc.currency ? doc.currency : 'CNY';
}

/** 读鲸鱼账本；成功返回 {ok:true,...}，失败返回 {ok:false, reason}。 */
function readWhaleLedger({ now = Date.now() } = {}) {
  for (const file of LEDGER_CANDIDATES) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      return { ok: false, reason: '鲸鱼账本不是合法 JSON' };
    }
    const total = firstNum(doc, BALANCE_KEYS);
    if (total === null) {
      return { ok: false, reason: `鲸鱼账本缺少余额字段（${BALANCE_KEYS.join('/')}）` };
    }

    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      /* 拿不到 mtime 时按"不知道"处理 */
    }
    const day = typeof doc.date === 'string' ? doc.date : null;
    const isToday = day === todayKey(now);
    // 账本停在过去某天时，今日已用不可信 —— 宁可 null，不显示过期的 0
    const todayUsage = isToday ? firstNum(doc, TODAY_KEYS) : null;

    return {
      ok: true,
      source: 'whale-ledger',
      file,
      total,
      currency: currencyOf(doc),
      todayUsage,
      day,
      updatedAt: mtime || null,
      stale: mtime ? now - mtime > FRESH_MS : null,
      pluginVersion: null,
    };
  }
  return { ok: false, reason: '未找到鲸鱼账本（~/.dsh/.dshw-usage.json）' };
}

/**
 * 读鲸鱼插件的只读 HTTP 路由（尽力而为，别当可靠兜底）。
 *
 * 为什么值得留这一条：账本文件里的 lastBalance/todayUsage 在上游被注释为
 * "Compatibility fields for the existing UI and old settings writers" ——
 * 插件升级时这几个字段最可能被改/被删；而 /dsh-whale/balance.json 是 README
 * 明文记载的自检项，属于插件自己承诺的对外接口，响应还带 version，
 * 能直接看出"当前装的是哪一版"。
 *
 * 现实约束（2026-10-24 本机实测）：
 *   · 端口必须探测（DSH 每次启动随机分配），复用 quota.findDshPort() 与其 60s 缓存，
 *     所以每轮采集不会额外跑 netstat。
 *   · **当前 DSH 把该路由挡在浏览器会话栅栏后面**：本机 GUI 端口返回 401 空响应。
 *     HUD 是独立进程、没有 DSH 的 browser-session secret，也不该去翻用户的
 *     ~/.dsh/.credentials.yaml 冒充浏览器。所以这条路只在"插件路由未走宿主鉴权"
 *     或"宿主栅栏不可用（插件只做回环/同源校验）"的 DSH 上才拿得到数。
 *   · findDshPort 选中的端口**可能不是 DSH**：本机 28317 上有个对任意路径都回
 *     `{"ret":1,"version":"3"}` 的服务，probePort 见到 200 就当命中。
 *     ⇒ 必须**校验响应形状**（ok:true + 数字余额），不能见 200 就信，
 *       否则余额区会被无关服务喂假数据。
 */
async function readWhaleHttp({ timeoutMs = 4000, now = Date.now(), port: portOverride } = {}) {
  let port = portOverride;
  if (!port) {
    try {
      // 延迟 require：测试期不必把 quota 的端口缓存/netstat 拉进来，也避免潜在循环依赖
      const quota = require('./quota');
      port = await quota.findDshPort();
    } catch {
      port = null;
    }
  }
  if (!port) return { ok: false, reason: 'DSH 未运行，鲸鱼路由不可达' };

  const url = `http://127.0.0.1:${port}${WHALE_HTTP_PATH}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: '鲸鱼路由要求 DSH 浏览器会话鉴权（HUD 无会话，此路不通）' };
    }
    if (!res.ok) return { ok: false, reason: `鲸鱼路由返回 HTTP ${res.status}` };
    const doc = await res.json().catch(() => null);
    if (!doc || typeof doc !== 'object' || !Object.prototype.hasOwnProperty.call(doc, 'ok')) {
      return { ok: false, reason: `鲸鱼路由端口 ${port} 返回的不是余额（形状不符，可能是端口选错）` };
    }
    if (doc.ok !== true) {
      const why = doc.error ? String(doc.error).slice(0, 120) : '鲸鱼路由返回 ok:false';
      return { ok: false, reason: `鲸鱼路由报错：${why}` };
    }
    const total = firstNum(doc, ['totalBalance', ...BALANCE_KEYS]);
    if (total === null) return { ok: false, reason: '鲸鱼路由缺少 totalBalance' };
    return {
      ok: true,
      source: 'whale-http',
      file: url,
      total,
      currency: currencyOf(doc),
      todayUsage: firstNum(doc, TODAY_KEYS),
      day: todayKey(now),
      updatedAt: now,
      stale: false,
      pluginVersion: typeof doc.version === 'string' ? doc.version : null,
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, reason: /abort|timeout/i.test(msg) ? '鲸鱼路由超时' : 'DSH 未运行或鲸鱼路由不可达' };
  }
}

/**
 * 可选兜底：直接查官方 /user/balance（需要 API Key）。
 * 只在账本与鲸鱼路由都拿不到时才用，避免重复请求。
 */
async function readApiBalance(apiKey, { timeoutMs = 6000 } = {}) {
  const key = String(apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return { ok: false, reason: '未配置 DeepSeek API Key' };
  try {
    const res = await fetch(API_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'DeepSeek API Key 无效或已失效' };
    if (!res.ok) return { ok: false, reason: `余额接口返回 HTTP ${res.status}` };
    const doc = await res.json();
    const infos = Array.isArray(doc.balance_infos) ? doc.balance_infos : [];
    const info = infos.find((i) => i && i.currency === 'CNY') || infos[0];
    if (!info) return { ok: false, reason: '余额接口没有返回 balance_infos' };
    const total = num(info.total_balance);
    // 与账本同理：接口给不出数字就判失败，别把 null 转成 0 显示成"没钱了"
    if (total === null) return { ok: false, reason: '余额接口的 total_balance 不是数字' };
    return {
      ok: true,
      source: 'api',
      total,
      currency: info.currency || 'CNY',
      todayUsage: null,
      day: todayKey(),
      updatedAt: Date.now(),
      stale: false,
      pluginVersion: null,
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, reason: /abort|timeout/i.test(msg) ? '余额接口超时' : msg };
  }
}

/**
 * 取 DeepSeek 官方余额：鲸鱼账本 → 鲸鱼 HTTP 路由 → 官方 API Key。
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey] 可选，最后兜底用
 * @param {number} [opts.now]
 * @param {boolean} [opts.http=true] 是否允许走鲸鱼 HTTP 路由（测试里关掉，避免读到本机真实 DSH）
 */
async function fetchBalance({ apiKey, now = Date.now(), http = true } = {}) {
  const led = readWhaleLedger({ now });
  if (led.ok) return led;

  const viaHttp = http ? await readWhaleHttp({ now }) : { ok: false, reason: '已禁用鲸鱼路由' };
  if (viaHttp.ok) return viaHttp;

  const api = await readApiBalance(apiKey);
  if (api.ok) return api;
  // 三条都失败：把原因都带上，便于判断是"没装鲸鱼""DSH 没开"还是"Key 不对"
  return { ok: false, reason: `${led.reason}；${viaHttp.reason}；${api.reason}` };
}

module.exports = {
  fetchBalance,
  readWhaleLedger,
  readWhaleHttp,
  readApiBalance,
  LEDGER_CANDIDATES,
  BALANCE_KEYS,
  TODAY_KEYS,
  FRESH_MS,
  API_ENDPOINT,
  WHALE_HTTP_PATH,
};
