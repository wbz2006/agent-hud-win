'use strict';

/**
 * 采集 worker。
 *
 * 采集本身是同步重活（冷启动实测 2.7 秒：读 264 MB Codex 文本、启动 23 次
 * 外部 zstd 进程）。若放在主进程里，会冻结窗口消息循环，表现为悬停卡顿、
 * 按钮无响应。这里把它放进 worker_threads：主线程只收结果，永不阻塞。
 *
 * 首次采集（冷启动）仍然要 2.7 秒，但那 2.7 秒发生在 worker 线程里，
 * 主进程照常响应鼠标与绘制。
 */

const { parentPort } = require('worker_threads');
const sources = require('./index');
const quota = require('./quota');
const relay = require('./relay');
const ccswitch = require('./ccswitch');
const deepseekBalanceMod = require('./deepseek-balance');
const config = require('../config');

/**
 * 执行一次采集并把结果发回主线程。
 *
 * @param {object} cfg 主进程传来的最新配置。**必须由调用方传入** ——
 *   worker 里不缓存配置，否则设置页改完（如「金额计价」切换）要等重启才生效。
 *   调用方是 main.js 的 pushData()，它每次都 config.load() 后一起发过来。
 */
async function runOnce(cfg) {
  const started = Date.now();
  try {
    const agents = sources.collectAll();

    // 真实剩余额度走 HTTP（插件在 DSH 宿主内注册的只读路由）。
    // 失败不致命：DSH 没开时返回错误项，UI 降级展示本地消耗量。
    let credits = [];
    try {
      credits = await quota.fetchCredits();
    } catch (err) {
      credits = [{ key: 'workbuddy', label: 'WorkBuddy', ok: false, error: String((err && err.message) || err) }];
    }

    /*
     * 注意：cfg 来自 runOnce(cfg) 形参（主进程每次触发采集时带上最新配置），
     * **不要**在这里再写 const cfg = config.load() ——
     *   1) 它会遮蔽形参，让主进程传入的新配置失效
     *   2) config.load() 有缓存，worker 进程内首次加载后不再重读文件，
     *      于是设置页保存的新值在这个 worker 里永远看不到
     * 曾经踩过这个坑：设置里切换「金额计价」完全不生效，排查半天
     * 才发现是形参被同名 const 遮蔽 + 模块级缓存双重导致。
     */

    // 中转站余额（Codex 走中转站时，官方额度接口拿不到）。
    // 未配置或拉取失败都返回 { ok:false }，UI 不显示余额环——不用估算值顶替。
    let relayBalance = null;
    try {
      relayBalance = await relay.fetchRelayBalance(cfg.relay);
    } catch (err) {
      relayBalance = { ok: false, error: String((err && err.message) || err) };
    }

    /*
     * DSH 的 DeepSeek **官方账户余额**。
     *
     * DSH 走官方账号，消耗既不在 CC Switch 账本（只有 claude-desktop / codex），
     * 也不是 WorkBuddy 积分。官方口径能拿到的只有余额：
     *   GET https://api.deepseek.com/user/balance（Bearer <sk-...>）
     * 未配置 Key 时返回 ok:false + 原因，UI 显示"未配置"，绝不显示 0。
     */
    let deepseekBalance = null;
    try {
      deepseekBalance = await deepseekBalanceMod.fetchBalance({ apiKey: cfg.deepseekApiKey });
    } catch (err) {
      deepseekBalance = { ok: false, reason: String((err && err.message) || err) };
    }

    // 今日实际花费（CC Switch 账本，金额是真实计费值而非估算）。
    // 读 CC Switch 的 SQLite 会启动 python 子进程（约 100ms），失败不影响其它数据。
    // 计价方式由 cfg.costMode 决定（内部折算 / 真实汇率 / 原始值）。
    let todayCost = null;
    try {
      todayCost = ccswitch.readTodayCost(cfg.costMode);
      /*
       * 冷启动常见一次性失败：CC Switch 正在写库（SQLite 被占用），
       * 或 python 子进程首启慢于探测超时。失败结果不缓存，但用户会先看到
       * 两个环的 "—" 直到下一轮采集（30 秒）。
       * 这里补一次间隔重试，把"刚开机看着像坏了"的观感消掉。
       */
      if (!todayCost || !todayCost.ok) {
        await new Promise((r) => setTimeout(r, 1500));
        const again = ccswitch.readTodayCost(cfg.costMode);
        if (again && again.ok) todayCost = again;
      }
    } catch (err) {
      todayCost = { ok: false, error: String((err && err.message) || err) };
    }

    /*
     * 可用性统计（近 24h 请求成功率与延迟）。
     *
     * 和 todayCost 分开算：花费读金额列，可用性读 status_code / latency_ms，
     * 两者各自的失败互不影响。失败时 UI 不显示可用性条，不改环的颜色。
     */
    let availability = null;
    try {
      availability = ccswitch.readAvailability({ hours: 24 });
    } catch (err) {
      availability = { ok: false, reason: String((err && err.message) || err), byApp: {} };
    }

    const summary = sources.summarizeAll(agents, Date.now());
    summary.credits = credits;
    summary.deepseekBalance = deepseekBalance;
    summary.relayBalance = relayBalance;
    summary.todayCost = todayCost;
    summary.availability = availability;

    parentPort.postMessage({
      ok: true,
      summary,
      elapsedMs: Date.now() - started,
      cache: sources.cacheStats(),
    });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: String((err && err.message) || err),
      // 带上堆栈：悬浮条上的红框只显示一行且会被裁掉，
      // 主进程会把 error + stack 一起写进 error.log 便于定位。
      stack: String((err && err.stack) || ''),
      elapsedMs: Date.now() - started,
    });
  }
}

parentPort.on('message', (msg) => {
  // msg.config 由主进程在触发采集时带上（见 main.js 的 pushData）。
  // 兜底：万一没带（旧调用路径），worker 自己读一次 —— 配置在 asar 外，
  // worker 有权限 require（见 resolveSourcesDir 的解包说明）。
  if (msg && msg.type === 'collect') runOnce(msg.config || config.load());
});

// 启动即采集一次，避免主线程还要发首个请求
runOnce(config.load());
