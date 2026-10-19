'use strict';

/**
 * 上游限流状态（soft_rate）模块 —— 按**模型**粒度聚合。
 *
 * ## 为什么是"限流状态"而不是"剩余额度百分比"
 *
 * 免费模型的额度由上游服务端掌握，**没有查询接口**：
 *   - 插件只注册了一个 status 路由，返回的是积分余额（对免费模型无意义）
 *   - soft_rate 的配额模型无法从日志反推：实测两个同样 24 小时的窗口，
 *     一个 973 次调用才触发限流，另一个仅 123 次就触发 —— 不是简单计次。
 *     因此不做"剩余百分比"，不编造公式。
 *
 * ## 能精确拿到什么
 *
 * 上游在 429 报错文本里**明确给出了下次重置时刻**，例如：
 *   "workbuddy upstream soft_rate (http 429): 您的使用量已超出频率限制，
 *    将在 2026-10-15 15:18:20 UTC+8 重置，您也可以切换其他模型继续使用。"
 *
 * ## 模型归属怎么定
 *
 * `llm/retry` 记录本身**不带 model 字段**，且它自带的 provider 字段不可靠
 * （实测仍写 workbuddy-vision，但当时模型已切到 workbuddy-ai 的 deepseek-v4.1-flash）。
 * 因此 dsh-source.js 在按序解析时维护"当前模型"，限流事件就近归属。
 * 归属依据是 model/selection、request/header、assistant/message 三种记录的
 * 可信 model 字段，实测覆盖 472/472 = 100%。
 *
 * 注意：同一个 provider 下的不同模型**各有独立配额**，所以按模型分组才能
 * 反映真实情况（例如 workbuddy 下 hy4-preview-f 与 step-5-preview 分别受限）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** provider 到显示名。 */
const PROVIDER_LABELS = {
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy AI',
  'workbuddy-vision': 'WorkBuddy Vision',
  'workbuddy-ai-vision': 'WorkBuddy AI Vision',
  'deepseek-account': 'DeepSeek 官方',
  'deepseek-account-vision': 'DeepSeek 官方 Vision',
  opencode2dsh: 'OpenCode',
  'opencode2dsh-vision': 'OpenCode Vision',
  jy: 'Jy',
  qingshu: '轻书',
};

/** 模型名到友好显示名（数据来自上游 catalog 的 name 字段）。 */
const MODEL_LABELS = {
  'hy4-preview-f': 'Hy4 preview',
  hy3: 'Hy3',
  'step-5-preview': 'Step-5 preview',
  'step-5-preview-free': 'Step-5 preview (免费)',
  'space-bunny': 'Space Bunny',
  'space-bunny-free': 'Space Bunny (免费)',
  'space-bunny-free-vision': 'Space Bunny (免费)',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4.1-flash-sg': 'DeepSeek V4.1 Flash SG',
  'deepseek-flash': 'DeepSeek Flash',
  'tr-alpha-channel': 'TR Alpha Channel',
  tierflow_pro: 'TierFlow Pro',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3 Flash',
};

/** 失败类型 -> 显示名。 */
const KIND_LABELS = {
  soft_rate: '限流',
  free_tier: '渠道禁止',
  timeout: '超时',
  auth: '鉴权失败',
  other: '其它错误',
};

/** 从会话集合提取全部限流事件。 */
function collectRateLimitEvents(sessions) {
  const out = [];
  for (const s of sessions || []) {
    for (const r of s.rateLimits || []) {
      out.push(r);
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * 是否属于 DSH 的免费模型。
 *
 * 判据是 `-free` 后缀（上游 catalog 的命名约定，见 MODEL_LABELS 里的
 * `step-5-preview-free` / `space-bunny-free` / `space-bunny-free-vision`）。
 *
 * 这类模型的限流语义与付费模型不同（免费额度更激进、文案也不统一），
 * 判定未经验证，因此默认不计入监控 —— 由 `betaRateFreeModel` 开关控制。
 */
function isFreeModel(model) {
  return typeof model === 'string' && /-free(-|$)/.test(model);
}

/**
 * 归一化 provider：去掉 `-vision` 后缀。
 *
 * `X-vision` 不是独立服务，而是插件 `dsh-vision-router` 为**支持图片的模型**
 * 创建的"孪生路由"（代码里叫 twinRoute = `${provider}-vision`）：同一上游账号、
 * 同一套模型元数据，只是该路由能接收图片输入。
 *
 * 因此 `workbuddy` 与 `workbuddy-vision` 必须合并显示——否则同一个模型会
 * 出现两行，而它们实际共用同一份配额（实测两者共享同一重置时刻）。
 *
 * 注意：国内版 `workbuddy` 与国际版 `workbuddy-ai` 是**真正不同的服务**
 * （插件 README：两版的模型、账号和积分互不混用），不合并。
 */
function baseProvider(provider) {
  if (typeof provider !== 'string') return provider;
  return provider.endsWith('-vision') ? provider.slice(0, -'-vision'.length) : provider;
}

/** 模型键：有 provider 时用 "provider / model"，否则只用 model。 */
function modelKey(provider, model) {
  const base = baseProvider(provider);
  if (!model || model === 'unknown') return base ? base + ' / (未知模型)' : '(未知)';
  return base ? base + ' / ' + model : model;
}

/**
 * 按模型聚合限流状态。
 *
 * @param {Array} sessions DSH 会话（含 rateLimits / modelCalls / modelProviders）
 * @param {object} opts
 * @param {number} opts.now 当前时间戳
 * @param {boolean} [opts.includeFreeModel=false] 【Beta】是否纳入免费模型（`-free`）
 * @param {boolean} [opts.enabled=true] 限流监控总开关；false 时返回空数组
 * @param {boolean} [opts.includeOpenCode=true] 是否纳入 OpenCode（多为 403 渠道禁止）
 * @param {number} [opts.graceMinutes] 覆盖内置的宽限判定分钟数
 * @returns {Array} 每个模型一条，限流中的排前面
 */
function summarizeRateLimits(
  sessions,
  {
    now = Date.now(),
    includeFreeModel = false,
    enabled = true,
    includeOpenCode = true,
    graceMinutes = null,
  } = {}
) {
  /*
   * 总开关关闭 → 直接返回空。设置页的「启用限流监控」此前只写配置、
   * 没有任何代码消费它（用户关掉后卡片照样显示「已限流」）。
   */
  if (!enabled) return [];

  const list = sessions || [];
  let events = collectRateLimitEvents(list);

  // Beta 开关：默认剔除免费模型（免费额度限流语义未经验证，避免误报）
  if (!includeFreeModel) {
    events = events.filter((e) => !isFreeModel(e.model));
  }

  // OpenCode 开关：该渠道多为 403「渠道禁止」，关掉可减少噪音
  if (!includeOpenCode) {
    events = events.filter((e) => baseProvider(e.provider) !== 'opencode2dsh');
  }

  /** @type {Map<string, any>} */
  const acc = new Map();

  const ensure = (key, provider, model) => {
    if (!acc.has(key)) {
      const base = baseProvider(provider);
      acc.set(key, {
        key,
        // provider 已归一化（去掉 -vision），便于展示与后续匹配
        provider: base || null,
        providerLabel: PROVIDER_LABELS[base] || base || '未知来源',
        model: model || null,
        modelLabel: MODEL_LABELS[model] || model || '未知模型',
        limited: false,
        resetAt: null,
        resetInMs: null,
        lastHitAt: null,
        /** soft_rate（真限流）命中次数。 */
        hitCount: 0,
        /** 非限流类失败统计：kind -> 次数（free_tier / timeout / auth / other）。 */
        errorCounts: {},
        lastErrorAt: null,
        windowStart: null,
        windowCalls: 0,
        /** 是否曾通过 vision 孪生路由被限流（图片轮次）。 */
        viaVision: false,
      });
    }
    return acc.get(key);
  };

  // 1) 错误事件按模型归集（provider 归一化后，孪生路由与主路由合并）
  for (const e of events) {
    const key = modelKey(e.provider, e.model);
    const a = ensure(key, e.provider, e.model);
    if (typeof e.provider === 'string' && e.provider.endsWith('-vision')) a.viaVision = true;

    const kind = e.kind || 'other';
    if (kind === 'soft_rate') {
      a.hitCount++;
      // lastHitAt 只跟踪限流命中：非限流错误（timeout 等）不该延长限流判定
      if (!a.lastHitAt || e.time > a.lastHitAt) a.lastHitAt = e.time;
      // 取最远的重置时刻（同一模型多次触发时，以最后一次为准）
      if (e.resetAt && (!a.resetAt || e.resetAt > a.resetAt)) a.resetAt = e.resetAt;
    } else {
      // 非限流错误（OpenCode FreeTier 禁止 / 超时 / 鉴权等）：只记计数，没有重置时间
      a.errorCounts[kind] = (a.errorCounts[kind] || 0) + 1;
      if (!a.lastErrorAt || e.time > a.lastErrorAt) a.lastErrorAt = e.time;
    }
  }

  // 2) 判定当前是否处于限流中
  //
  //    有两种情况：
  //    a) 报错给了重置时刻（中/英文报文都带）→ resetAt > now 即为限流中
  //    b) 没给重置时刻 → 无法断定已恢复。
  //       实测上游会返回不带重置时间的 soft_rate（除文案变动外，某些上游
  //       路径本身不含该字段）。此时若判"已恢复"会漏报真实限流，
  //       因此按"最近一次命中距今多久"保守判定：5 分钟内有 soft_rate
  //       就仍视为限流中（重置文案可能缺失，但限流是事实）。
  // 宽限判定：优先用设置里的值（分钟），未传时退回内置 5 分钟
  const SOFT_LIMIT_GRACE_MS =
    Number.isFinite(graceMinutes) && graceMinutes >= 0 ? graceMinutes * 60 * 1000 : 5 * 60 * 1000;
  for (const a of acc.values()) {
    if (a.resetAt && a.resetAt > now) {
      a.limited = true;
      a.resetInMs = a.resetAt - now;
    } else if (!a.resetAt && a.lastHitAt && now - a.lastHitAt <= SOFT_LIMIT_GRACE_MS) {
      a.limited = true;
      a.resetInMs = null; // 没有重置时刻，只显示"限流中"
    } else {
      a.limited = false;
      a.resetInMs = null;
    }
    a.windowStart = a.resetAt ? a.resetAt - DAY_MS : now - DAY_MS;
  }

  // 3) 统计各模型在窗口内的调用次数（用会话里记下的调用时刻）
  for (const s of list) {
    const modelCalls = s.modelCalls || {};
    const modelProviders = s.modelProviders || {};
    for (const [model, times] of Object.entries(modelCalls)) {
      const provider = modelProviders[model] || s.provider || null;
      let a = acc.get(modelKey(provider, model));
      if (!a) {
        // 回退：modelProviders 记的是"最后一次出现"的 provider，可能与限流时
        // 不同（例如中途切换过路由）。此时按模型名匹配已有条目。
        for (const cand of acc.values()) {
          if (cand.model === model) {
            a = cand;
            break;
          }
        }
      }
      if (!a) continue; // 该模型从未受限，不计
      for (const t of times) {
        if (t >= a.windowStart && t <= now) a.windowCalls++;
      }
    }
  }

  const out = [...acc.values()];
  // 排序：限流中 > 有错误（含已恢复/FreeTier 禁止/超时）> 正常
  const errorTotal = (a) => Object.values(a.errorCounts || {}).reduce((s, n) => s + n, 0);
  out.sort((x, y) => {
    if (x.limited !== y.limited) return x.limited ? -1 : 1;
    const ex = errorTotal(x);
    const ey = errorTotal(y);
    if ((ex > 0) !== (ey > 0)) return ey > 0 ? 1 : -1;
    return (y.hitCount + ey) - (x.hitCount + ex);
  });
  return out;
}

/** 把毫秒格式化为 "19h32m" 形式。 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return '';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24) + 'h';
  }
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm';
}

module.exports = {
  summarizeRateLimits,
  collectRateLimitEvents,
  isFreeModel,
  formatDuration,
  modelKey,
  baseProvider,
  PROVIDER_LABELS,
  MODEL_LABELS,
  KIND_LABELS,
  DAY_MS,
};
