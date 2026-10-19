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
const config = require('../config');

/** 执行一次采集并把结果发回主线程。 */
async function runOnce() {
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

    // 中转站余额（Codex 走中转站时，官方额度接口拿不到）。
    // 未配置或拉取失败都返回 { ok:false }，UI 不显示余额环——不用估算值顶替。
    let relayBalance = null;
    try {
      relayBalance = await relay.fetchRelayBalance(config.load().relay);
    } catch (err) {
      relayBalance = { ok: false, error: String((err && err.message) || err) };
    }

    // 今日实际花费（CC Switch 账本，金额是真实计费值而非估算）。
    // 读 CC Switch 的 SQLite 会启动 python 子进程（约 100ms），失败不影响其它数据。
    let todayCost = null;
    try {
      todayCost = ccswitch.readTodayCost();
    } catch (err) {
      todayCost = { ok: false, error: String((err && err.message) || err) };
    }

    // 限流监控的四个开关（设置页「限流监控」分组）：
    //   总开关 rateEnabled / OpenCode rateOpenCode / 宽限 rateGraceMinutes
    //   【Beta】免费模型 betaRateFreeModel（默认关闭）
    const cfg = config.load();
    const summary = sources.summarizeAll(agents, Date.now(), {
      includeFreeModel: !!cfg.betaRateFreeModel,
      rateEnabled: cfg.rateEnabled !== false,
      rateOpenCode: cfg.rateOpenCode !== false,
      rateGraceMinutes: Number(cfg.rateGraceMinutes),
    });
    summary.credits = credits;
    summary.relayBalance = relayBalance;
    summary.todayCost = todayCost;

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
  if (msg && msg.type === 'collect') runOnce();
});

// 启动即采集一次，避免主线程还要发首个请求
runOnce();
