'use strict';

/**
 * 额度（quota）模块。
 *
 * 数据来源有两条，互补而非替代：
 *
 * 1. **真实剩余额度**（推荐主数据）
 *    插件在 DSH 的 web server（GUI 端口）上注册了只读路由：
 *      GET /plugins/dsh-connect-workbuddy/usage?region=cn      (国内版 WorkBuddy)
 *      GET /plugins/dsh-connect-workbuddy/usage?region=global  (国际版 WorkBuddy AI)
 *    遗留插件 dsh-workbuddy-connect（0.7.x，部分机器仍装着）对应：
 *      GET /plugins/dsh-workbuddy-connect/status      /  .../ai/status
 *    返回 credits.total（剩余积分）与 packages/accounts（各包的 remain/size）。
 *    这是上游计费接口的实时结果，不是估算。
 *
 *    注意三点：
 *      - 路由由插件在 DSH 宿主内注册，**DSH 必须正在运行**；否则连接被拒。
 *      - 余额是实时计算的，从不落盘，所以只能走 HTTP，不能在文件里找。
 *      - 插件对请求有回环来源校验：默认 fetch（127.0.0.1）即可通过，
 *        不要伪造 Host/Origin 头，伪造会被 403。
 *
 * 2. **本地实测消耗量**（辅助）
 *    按 provider 聚合 token 与调用次数，用于判断"今天烧得快不快"。
 *    模型倍率来自 .workbuddy-catalog.json 的 billing.credits —— 那是**单价倍率，
 *    不是剩余积分**，只用来换算消耗，绝不能当额度显示。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DSH_HOME = path.join(os.homedir(), '.dsh');

/** 与额度无关的系统端口（盲扫兜底时跳过，减少探测噪音）。 */
const SKIP_PORTS = new Set([135, 139, 445, 5353, 5357, 49152, 49664, 49665, 49666, 49667, 49668, 49669]);

/**
 * 插件写下的宿主心跳（pid = 跑着插件的 DSH 主进程）。
 *
 * 这是**唯一可靠的身份链**：netstat 能给出「哪个 pid 监听哪个端口」，
 * 心跳给出「哪个 pid 是 DSH」，两者相交就把候选端口收敛到 DSH 自己的
 * 端口 —— 别的程序（VS Code 的 Cortex-Debug、各种本地服务）根本进不了候选。
 * 见 findDshPort()。
 */
const HEARTBEAT_FILE = path.join(DSH_HOME, '.workbuddy-host-heartbeat.json');

/**
 * 额度路由候选（按优先级排：现役插件在前，遗留插件兜底）。
 *
 * 为什么一个 key 要挂多条 path：插件换过一次包名（dsh-workbuddy-connect →
 * dsh-connect-workbuddy，路由也随之改名），而不同机器上装着哪一版不由 HUD 决定。
 * 同一 key 的多条 path 依次尝试，**404 就换下一条**，全都失败才报错。
 */
const ENDPOINTS = [
  {
    key: 'workbuddy',
    label: 'WorkBuddy',
    paths: [
      { path: '/plugins/dsh-connect-workbuddy/usage?region=cn', shape: 'usage' },
      { path: '/plugins/dsh-workbuddy-connect/status', shape: 'legacy' },
    ],
  },
  {
    key: 'workbuddy-ai',
    label: 'WorkBuddy AI',
    paths: [
      { path: '/plugins/dsh-connect-workbuddy/usage?region=global', shape: 'usage' },
      { path: '/plugins/dsh-workbuddy-connect/ai/status', shape: 'legacy' },
    ],
  },
];

/** 探测时用来确认「这个端口上确实有那个插件」的路由（只用 1 条，够识别身份）。 */
const PROBE_ROUTES = [
  '/plugins/dsh-connect-workbuddy/usage',
  '/plugins/dsh-workbuddy-connect/status',
];

/** WorkBuddy 的模型目录文件（含单价倍率与免费标记）。 */
const CATALOG_FILES = [
  { file: path.join(DSH_HOME, '.workbuddy-catalog.json'), label: 'WorkBuddy' },
  { file: path.join(DSH_HOME, '.workbuddy-ai-catalog.json'), label: 'WorkBuddy AI' },
];

const PROVIDER_LABELS = {
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy AI',
  'workbuddy-vision': 'WorkBuddy Vision',
  opencode2dsh: 'OpenCode2DSH',
  'opencode2dsh-vision': 'OpenCode2DSH Vision',
  'deepseek-account': 'DeepSeek 官方',
  jy: 'Jy',
  qingshu: '轻书',
};

/**
 * DSH 本地 HTTP 服务端口 —— **不能写死**。
 *
 * 踩过的坑（2026-10-21）：早先这里固定 19387，当时 DSH 恰好跑在该端口上，
 * 一切正常；后来 DSH 每次启动随机分配端口，19387 已无人监听，于是额度区永远
 * 显示「DSH 未运行或路由不可达」—— **DSH 明明开着**。
 *
 * 踩过的坑（2026-10-24，本次修的就是它）：为了不再写死端口，改成
 * 「把本机所有监听端口都试一遍，谁返回 200 就选谁」。这条判据错得彻底：
 *   · 本机 127.0.0.1:4310 上有个**二进制协议**的服务，对任意路径都回 200 + 乱码
 *     —— probePort 见 200 就认定它是 DSH，于是选中它，拿回来的 JSON 解析直接失败。
 *   · VS Code 的 **Cortex-Debug** 在 127.0.0.1:55878 开着 GDB/OCD 端口，
 *     盲扫会把 HTTP 请求字节写进一个调试用的 socket —— 既探测不出结果（挂起到超时），
 *     又可能干扰正在进行的调试会话。**扫描别人的端口本身就是错的**。
 *   · 而真正的 DSH 端口此时回的是 404：插件早已改名（dsh-workbuddy-connect →
 *     dsh-connect-workbuddy），路由跟着变了，探测用的还是旧路径，
 *     于是「正确端口」永远不可能命中，只剩噪音端口互相竞争。
 *
 * 现在的做法（两条一起，缺一不可）：
 *   1. **先用身份链收敛候选**：插件写下的 ~/.dsh/.workbuddy-host-heartbeat.json
 *      里有 DSH 主进程的 pid；netstat 给出「哪个 pid 监听哪些端口」；两者相交，
 *      只探 DSH 自己的端口。环境变量 DSH_WEB_PORT 仍可强制指定（最高优先级）。
 *      只有在身份链彻底断裂时，才退到全端口盲扫（第 3 级判据会把假命中挡住）。
 *   2. **判据是响应形状，不是状态码**：必须 200 + 能解析成 JSON + 形状符合插件契约
 *      （见 looksLikeWorkBuddyDoc）。200 乱码 = 不可达，绝不选它。
 */
const DSH_WEB_PORT_CANDIDATES = [19387, 8734];

/** 探测用的超时：身份链收敛后候选只剩几个端口，可以给足时间。 */
const PROBE_TIMEOUT_MS = 1200;
/** 盲扫兜底时的超时：几十个端口并行，但仍要短，别拖慢整轮采集。 */
const BLIND_PROBE_TIMEOUT_MS = 700;
const PROBE_CACHE_MS = 60000;   // 探测成功后缓存 1 分钟，避免每轮都扫

/** DSH 宿主的进程名特征（心跳丢失时的兜底身份判据）。 */
const DSH_PROCESS_PATTERN = /deepseek\s*harness|^dsh(\.exe)?$/i;

let probeCache = null; // { port, at }

/**
 * 这个 JSON 文档是不是 WorkBuddy 插件的状态文档？
 *
 * 只按「形状」判断，不按状态码 —— 见上面 4310 的教训。判据取自插件契约：
 *   · 现役 dsh-connect-workbuddy 的 /usage（含 detail=fast 快文档）：
 *     status: signed-in|signed-out，配 accountId/accountName/accounts[]/domain
 *   · 遗留 dsh-workbuddy-connect 的 /status：credits.total + credits.accounts
 * 无关服务（`{"ret":1,"version":"3"}`、`{"ok":true}`、二进制乱码、HTML）全部落空。
 */
function looksLikeWorkBuddyDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  // signed-in / signed-out 是插件对外的登录态枚举，再配上这条插件专属路径就够了。
  // 遗留插件的未登录文档只有这一个字段，所以不能强求 credits/accounts 同时在场。
  if (typeof doc.status === 'string' && /^signed-(in|out)$/.test(doc.status)) return true;
  const creditBlock = doc.credits && typeof doc.credits === 'object';
  if (creditBlock && typeof doc.credits.total === 'number') return true;
  return false;
}

/**
 * 判断某端口上的 DSH 是否真的挂着那个插件的额度路由。
 *
 * 分级而不是布尔值，因为本机同时跑着多个 DSH 端口/实例：只有 GUI 那个端口
 * 回答插件路由，其余内部服务（2064/2067/2072/2073/8326）一律 401
 * 「Missing or invalid bearer」。两层都算"DSH 的端口"，但只有 level 3 拿得到余额。
 * 早先这里把 401 也当可用，于是选中一个 401 端口 —— 症状：余额永远不可用。
 *
 * 探测请求走 `?detail=fast`：插件文档明说快模式**只读本地状态、零上游调用**，
 * 所以每轮扫端口不会替用户去打计费接口。
 *
 * level：3 = 200 且形状相符（可用）｜1 = 401/403（是 DSH 端口但被鉴权挡住）｜
 *        0 = 不可达 / 404 / 非 JSON / **200 但形状不符**（那就是别人的服务）
 */
async function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  let fenced = null;
  for (const route of PROBE_ROUTES) {
    const url = `http://127.0.0.1:${port}${route}${route.includes('?') ? '&' : '?'}detail=fast`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 401 || res.status === 403) {
        // 记下"这端口像 DSH"，但继续试下一条路由：401 也可能是内部服务
        if (!fenced) fenced = { port, level: 1, reason: `HTTP ${res.status}（bearer 栅栏）` };
        continue;
      }
      if (!res.ok) continue;                       // 404 等：这条路由不在这个端口上
      const doc = await res.json().catch(() => null);
      if (looksLikeWorkBuddyDoc(doc)) return { port, level: 3, reason: null };
      // 200 但不是插件的状态文档 —— 别人的服务，明确不给命中
      continue;
    } catch {
      /* 超时 / 连接被拒 / socket 挂起：换下一条路由 */
    }
  }
  return fenced || { port, level: 0, reason: '插件路由不可达' };
}

/** 从一批探测结果里挑最优：先要 level=3（能取数），其次才退 401/403。 */
function pickProbe(results) {
  const ok = results.find((r) => r && r.level === 3);
  if (ok) return ok;
  return results.find((r) => r && r.level === 1) || null;
}

/**
 * 找到当前 DSH 的端口。
 *
 * **必须有第二轮长超时探测**：DSH 一个进程会监听一串端口，其中只有 GUI 那个
 * 返回真实数据，其余全是 401。首轮短超时下它可能因冷启动/忙碌被判不可达，
 * 于是选中一个 401 端口。第二轮只对首轮给出 401/403 的端口长超时重探，命中就升级。
 *
 * @param {number} [timeoutMs] 指定则跳过缓存、并作为首轮超时（重试用）
 * @returns {Promise<number|null>} 找不到返回 null（调用方降级展示，不编造数据）
 */
async function findDshPort(timeoutMs) {
  const now = Date.now();
  if (!timeoutMs && probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.port;

  // 1) 用户手动指定
  const explicit = Number(process.env.DSH_WEB_PORT || 0);
  if (explicit > 0) {
    const r = await probePort(explicit, timeoutMs || PROBE_TIMEOUT_MS);
    if (r.level >= 1) return remember(explicit);
  }

  // 2) 身份链优先：心跳 pid（或 DSH 进程名）名下的监听端口
  const owned = dshOwnedPorts();
  const candidates = owned.length
    ? owned
    : [...new Set([...DSH_WEB_PORT_CANDIDATES, ...allListeningPorts()])];
  const firstTimeout = timeoutMs || (owned.length ? PROBE_TIMEOUT_MS : BLIND_PROBE_TIMEOUT_MS);

  const first = await Promise.all(candidates.map((p) => probePort(p, firstTimeout)));
  const best = pickProbe(first);
  if (best && best.level === 3) return remember(best.port);

  // 3) 首轮只拿到 401/403：用长超时重探这些端口，优先升级到能取数的 200
  if (best && best.level === 1) {
    const retryPorts = first.filter((r) => r.level === 1).map((r) => r.port);
    const retry = await Promise.all(retryPorts.map((p) => probePort(p, timeoutMs || 2500)));
    const better = pickProbe(retry);
    if (better && better.level === 3) return remember(better.port);
    return remember(best.port);
  }

  // 4) 身份链断裂且盲扫也没有形状命中 → 如实返回 null。
  //    这里**不退而求其次选"最像的端口"**：选错端口比选不到更糟（拿别人的服务喂假数据）。
  return best ? remember(best.port) : null;
}

function remember(port) {
  probeCache = { port, at: Date.now() };
  return port;
}

/**
 * DSH 主进程名下的监听端口。
 *
 * 两条身份来源，任一可用即可（顺序即优先级）：
 *   · 插件心跳文件里的 pid（最准：它就是"跑着这个插件的那个进程"）
 *   · 进程名匹配 DeepSeek Harness / dsh.exe（心跳缺失或进程已换 pid 时兜底）
 * 返回空数组表示身份链断裂，调用方才允许退到盲扫。
 */
function dshOwnedPorts() {
  let byPid;
  try {
    byPid = listeningPortsByPid();
  } catch {
    return [];
  }
  if (!byPid.size) return [];

  const pids = new Set();
  const hbPid = readHeartbeatPid();
  if (hbPid && isPidAlive(hbPid)) pids.add(hbPid);
  if (!pids.size) {
    for (const pid of byPid.keys()) {
      if (DSH_PROCESS_PATTERN.test(processNameByPid(pid))) pids.add(pid);
    }
  }

  const ports = new Set();
  for (const pid of pids) {
    for (const p of byPid.get(pid) || []) ports.add(p);
  }
  return [...ports].sort((a, b) => a - b);
}

/** 读插件心跳里的 DSH 主进程 pid（文件不存在/格式不符返回 null）。 */
function readHeartbeatPid(file = HEARTBEAT_FILE) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(doc && doc.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 进程是否还活着（pid 存在即活；EPERM 也说明它存在，只是没权限看）。 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

/** 本机回环/全网卡上的监听端口（盲扫兜底用；仅 Windows 可用，失败返回空数组）。 */
function allListeningPorts() {
  const ports = new Set();
  try {
    for (const set of listeningPortsByPid().values()) for (const p of set) ports.add(p);
  } catch {
    return [];
  }
  return [...ports];
}

/**
 * 解析 netstat 输出为 Map<pid, Set<port>>（纯函数，便于单测）。
 * 只收回环/任意地址（127.0.0.1 / 0.0.0.0 / ::1 / ::）上的 LISTENING 行。
 */
function parseNetstatListening(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\[?::\]?)$/.test(m[1])) continue;
    const port = Number(m[2]);
    const pid = Number(m[3]);
    // 排除明显无关的系统端口，减少探测噪音
    if (port <= 1024 || SKIP_PORTS.has(port)) continue;
    if (!map.has(pid)) map.set(pid, new Set());
    map.get(pid).add(port);
  }
  return map;
}

/** netstat -ano（含 pid 归属）→ Map<pid, Set<port>>（仅 Windows 可用）。 */
function listeningPortsByPid() {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  return parseNetstatListening(out);
}

/** 进程名（tasklist 一次查询；拿不到返回空串，交给调用方判不匹配）。 */
function processNameByPid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const m = String(out).match(/^"([^"]+)"/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 端口缓存失效（设置变更后可调用，让下一轮重新探测）。 */
function resetPortCache() {
  probeCache = null;
}

/**
 * 把一条额度路由的响应文档映射成 UI 消费的记录。
 *
 * 两种插件文档形状都要吃下（现役 usage / 遗留 status）：
 *   · 现役：{ status, credits: { total, packages[] }, accounts[], domain }
 *   · 遗留：{ status, credits: { total, accounts[] }, expiresAt, domain }
 * 三态必须分清 —— 正常、未登录、文档 200 但计费查询失败（creditsError）：
 * 后者若当成 0 显示，用户会以为积分花光了。
 *
 * @param {object} ep  ENDPOINTS 里的一条（key/label）
 * @param {object} doc 解析后的 JSON
 * @param {number} port 取数的端口（写进错误信息，下次排查能直接看到选错了哪个端口）
 */
function docToRecord(ep, doc, port) {
  const rec = { key: ep.key, label: ep.label, ok: false, error: null, total: null, accounts: [], expiresAt: null, port };
  if (!doc || typeof doc !== 'object') {
    rec.error = `端口 ${port} 返回的不是 JSON（端口选错或路由已变更）`;
    return rec;
  }
  if (doc.status === 'signed-out') {
    rec.error = '未登录';
    return rec;
  }
  if (doc.creditsError) {
    // 文档仍 200，但计费查询失败：如实上报，不显示 0
    rec.error = String(doc.creditsError).slice(0, 120);
    return rec;
  }
  if (!looksLikeWorkBuddyDoc(doc)) {
    // 200 + JSON 但形状不符 = 连到了别人的服务（4310 那次就是这么坏的），必须说清端口
    rec.error = `端口 ${port} 返回的不是额度文档（端口选错或路由已变更）`;
    return rec;
  }
  const credits = doc.credits;
  if (!credits || typeof credits.total !== 'number') {
    rec.error = `端口 ${port} 响应缺少 credits.total`;
    return rec;
  }
  rec.ok = true;
  rec.total = credits.total;
  const packs = Array.isArray(credits.packages)
    ? credits.packages
    : Array.isArray(credits.accounts)
      ? credits.accounts
      : [];
  rec.accounts = packs.map((a) => ({
    packageName: a.packageName,
    remain: a.remain,
    size: a.size,
    unlimited: !!a.unlimited,
  }));
  rec.expiresAt =
    typeof credits.nearestExpiryMs === 'number'
      ? credits.nearestExpiryMs
      : typeof doc.expiresAt === 'number'
        ? doc.expiresAt
        : null;
  rec.domain = doc.domain || null;
  return rec;
}

/**
 * 拉取真实剩余额度。
 * 单个端点失败不影响另一个；DSH 未运行时整体返回空数组（调用方降级展示）。
 *
 * 失败时会**清端口缓存、用长超时重探一次**：本机 DSH 同时监听多个端口，
 * 只有 GUI 那个能取数；首轮短超时探测把它漏掉就会选中 401 端口。
 * 不重探的话，一次误判要让余额区错上整整一分钟（端口缓存 60s）。
 *
 * @returns {Promise<Array>} 每个账号一条 { key, label, ok, error, total, accounts, expiresAt }
 */
async function fetchCredits({ timeoutMs = 4000 } = {}) {
  const unreachable = () =>
    ENDPOINTS.map((ep) => ({
      key: ep.key,
      label: ep.label,
      ok: false,
      error: 'DSH 未运行或路由不可达',
      total: null,
      accounts: [],
      expiresAt: null,
    }));

  const readFrom = async (port) => {
    const out = [];
    for (const ep of ENDPOINTS) {
      let rec = null;
      let lastError = null;   // 别让后面候选的 404 覆盖掉前面候选的真实原因
      for (const route of ep.paths) {
        rec = { key: ep.key, label: ep.label, ok: false, error: null, total: null, accounts: [], expiresAt: null, port };
        try {
          const res = await fetch(`http://127.0.0.1:${port}${route.path}`, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.status === 404) {
            // 这一版插件没有这条路由（包名/路径变过）→ 换下一条候选
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          rec = docToRecord(ep, await res.json(), port);
        } catch (err) {
          const msg = String((err && err.message) || err);
          rec.error = /fetch failed|ECONNREFUSED|abort/i.test(msg) ? 'DSH 未运行或路由不可达' : msg;
        }
        if (rec.ok) break;
        lastError = rec.error;
      }
      if (rec && !rec.ok) {
        rec.error = lastError || '插件路由未注册（该端口上没有额度路由）';
      }
      out.push(rec || { key: ep.key, label: ep.label, ok: false, error: '插件路由未注册', total: null, accounts: [], expiresAt: null, port });
    }
    return out;
  };

  const port = await findDshPort();
  if (!port) return unreachable();

  const first = await readFrom(port);
  if (first.some((r) => r.ok)) return first;

  // 全部失败：可能是选错端口（401）或首轮探测超时。清缓存、长超时重探一次。
  resetPortCache();
  const retryPort = await findDshPort(3000);
  if (retryPort && retryPort !== port) {
    const again = await readFrom(retryPort);
    if (again.some((r) => r.ok)) return again;
  }
  return first;
}

/** 读取 WorkBuddy 模型目录的单价倍率（仅用于换算本地消耗）。 */
function loadRates() {
  const map = new Map();
  for (const { file, label } of CATALOG_FILES) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const entry of Object.values(doc.entries || {})) {
      for (const m of entry.models || []) {
        const b = m.billing || {};
        let rate = null;
        if (typeof b.credits === 'string') {
          const n = parseFloat(b.credits.replace(/[^0-9.]/g, ''));
          if (!Number.isNaN(n)) rate = n;
        }
        if (!map.has(m.id)) {
          map.set(m.id, { rate, free: !!b.free, badges: (b.badges || []).slice(), catalog: label });
        }
      }
    }
  }
  return map;
}

/** 归到本地时区当天 0 点。 */
function startOfDayLocal(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 按 provider 聚合今日消耗量。
 *
 * @param {Array} sessions 各采集器返回的会话（含 provider / model / usage / lastAt）
 * @param {object} opts
 * @param {'today'|'7d'|'all'} opts.period
 * @param {number} opts.now
 */
function aggregateByProvider(sessions, { period = 'today', now = Date.now() } = {}) {
  const rates = loadRates();
  const dayStart = startOfDayLocal(now);
  const cutoff = period === 'today' ? dayStart : period === '7d' ? dayStart - 6 * 86400000 : 0;

  const acc = new Map();

  for (const s of sessions) {
    const provider = s.provider || '(unknown)';
    const t = s.lastAt ? Date.parse(s.lastAt) : now;
    if (cutoff > 0 && t < cutoff) continue;

    if (!acc.has(provider)) {
      acc.set(provider, {
        provider,
        label: PROVIDER_LABELS[provider] || provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: new Map(),
        lastAt: null,
        freeCalls: 0,
        ratedCalls: 0,
      });
    }
    const a = acc.get(provider);
    a.calls += s.usage.calls || 0;
    a.inputTokens += s.usage.inputTokens || 0;
    a.outputTokens += s.usage.outputTokens || 0;
    if (s.lastAt && (!a.lastAt || s.lastAt > a.lastAt)) a.lastAt = s.lastAt;

    for (const [model, u] of Object.entries(s.byModel || {})) {
      const info = rates.get(model);
      const prev = a.models.get(model) || { model, calls: 0, outputTokens: 0, rate: null, free: false };
      prev.calls += u.calls || 0;
      prev.outputTokens += u.outputTokens || 0;
      if (info) {
        prev.rate = info.rate;
        prev.free = info.free;
        prev.badges = info.badges;
      }
      a.models.set(model, prev);

      const calls = u.calls || 0;
      if (info) {
        a.ratedCalls += calls;
        if (info.rate === 0 || info.free) a.freeCalls += calls;
      }
    }
  }

  const out = [];
  for (const a of acc.values()) {
    const models = [...a.models.values()].map((m) => ({
      model: m.model,
      calls: m.calls,
      outputTokens: m.outputTokens,
      rate: m.rate,
      free: m.free,
      badges: m.badges || [],
      // 倍率未知时给 null，不编造积分
      creditCost: m.rate === null || m.rate === undefined ? null : +(m.rate * m.calls).toFixed(2),
    }));
    models.sort((x, y) => y.calls - x.calls);

    const allRated = models.length > 0 && models.every((m) => m.creditCost !== null);
    const credits = allRated ? +models.reduce((s2, m) => s2 + (m.creditCost || 0), 0).toFixed(2) : null;

    out.push({
      provider: a.provider,
      label: a.label,
      calls: a.calls,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      tokens: a.inputTokens + a.outputTokens,
      models,
      lastAt: a.lastAt,
      freeCalls: a.freeCalls,
      ratedCalls: a.ratedCalls,
      coverage: a.calls ? Math.round((a.ratedCalls / a.calls) * 100) : 0,
      credits,
    });
  }

  out.sort((x, y) => y.calls - x.calls);
  return out;
}

module.exports = {
  fetchCredits,
  aggregateByProvider,
  loadRates,
  PROVIDER_LABELS,
  findDshPort,
  resetPortCache,
  ENDPOINTS,
  /**
   * 端口探测的纯判据部分，导出只为让单测能喂假数据（netstat 文本、异常文档）。
   * 业务代码不要从这里取东西。
   */
  __test: {
    looksLikeWorkBuddyDoc,
    docToRecord,
    parseNetstatListening,
    pickProbe,
    readHeartbeatPid,
    dshOwnedPorts,
    PROBE_ROUTES,
    HEARTBEAT_FILE,
  },
};
