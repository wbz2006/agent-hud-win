'use strict';

/**
 * 渲染进程：把主进程推送的多源汇总数据画到悬浮条上。
 *
 * 数据形状（来自 sources/index.js 的 summarizeAll）：
 *   { generatedAt, totals, buckets, bucketsBySource, byModel, bySource,
 *     providers, credits, sessions }
 *   bySource[key] = { label, ok, error, totals, sessionCount, providers, lastAt }
 *   providers[]   = 各 provider 的今日消耗（见 sources/quota.js）
 *   credits[]     = 各账号的真实剩余积分（HTTP 取，DSH 未运行时为错误项）
 *
 * 对应原项目：
 *   AgentHUDDesktop/Notch/Simple/SimpleMeterView.swift
 *   AgentHUDDesktop/Notch/Panel/HoverPanelView.swift
 */

/**
 * 余额货币符号：账本 / 鲸鱼路由给的是 ISO 码（CNY、USD…），不是符号。
 *
 * 为什么不能写死 ¥：DeepSeek 国际站账户的余额本币是 USD，账本 `accounting.active`
 * 会变成 "<key指纹>-USD"。写死 ¥ 会把 3.02 美元显示成 3.02 人民币 —— 数字对、
 * 单位错，属"看起来正常"的错值。未知币种退回 "CODE " 前缀，宁可难看也不误导。
 */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', HKD: 'HK$', JPY: 'JP¥' };
function currencySymbol(code) {
  const c = String(code || 'CNY').toUpperCase();
  return CURRENCY_SYMBOLS[c] || `${c} `;
}

/**
 * 积分格式化：整数粒度，只有带小数时才保留一位。
 * 当前仅用于 WorkBuddy 额度区（余额差值法的显示已停用，保留以备恢复）。
 */
function fmtCredit(n) {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/* ============================================================
 * 卡片内容 = 原版四段（概况行 / 模型用量条 / 最近会话 / 额度区），
 * 视觉风格沿用 2026-10-25 改版：panel-top（Tab + 右上角 ⚙/✕）、
 * 深色卡片、金额亮色。Beta 限流区不恢复（功能已整体删除）。
 * ============================================================ */

const AGENT_COLORS = ['#c084fc', '#60a5fa', '#2dd4bf', '#fb923c', '#f472b6', '#a3e635'];

/** 数据源 key → 短标签（用于会话列表的来源徽标）。 */
function sourceLabel(key) {
  const labels = { claude: 'CC', codex: 'CX', dsh: 'DSH' };
  return labels[key] || String(key || '?').slice(0, 4).toUpperCase();
}

function modelShortName(m) {
  return String(m).replace(/^<|>$/g, '');
}

/**
 * 模型名对不上时的模糊匹配。
 *
 * CC Switch 记的 model 名与 agent 会话里的可能差在大小写/后缀
 * （如 gpt-6.1-sol vs gpt-6.1-sol-2024）。退化匹配避免整列显示"—"。
 */
function findCostModelFallback(costModels, name) {
  const keys = Object.keys(costModels || {});
  const base = String(name || '')
    .toLowerCase()
    .replace(/[-_ ]?\d{6,8}$/, ''); // 去掉结尾日期
  const hit = keys.find((k) => {
    const kk = k.toLowerCase().replace(/[-_ ]?\d{6,8}$/, '');
    return kk === base || kk.startsWith(base) || base.startsWith(kk);
  });
  return hit ? costModels[hit] : null;
}

function pickView(summary) {
  if (activeSource === 'all') {
    return {
      label: '全部 Agent',
      sub: `${Object.values(summary.bySource).filter((s) => s.ok).length} 个数据源`,
      totals: summary.totals,
      sessionCount: Object.values(summary.bySource).reduce((a, s) => a + (s.sessionCount || 0), 0),
      byModel: summary.byModel,
      sessions: summary.sessions,
    };
  }
  const s = summary.bySource[activeSource];
  if (!s) return null;
  return {
    label: s.label,
    sub: s.error
      ? '采集失败'
      : sourceSubtitle(s),
    totals: s.totals,
    sessionCount: s.sessionCount || 0,
    byModel: byModelOf(summary, activeSource),
    sessions: summary.sessions.filter((x) => x.source === activeSource),
    error: s.error,
  };
}

/** 副标题：provider 列表可能很长（DSH 有 7 个），只展示前两个 + 计数。 */
function sourceSubtitle(s) {
  const ps = s.providers || [];
  if (!ps.length) return '本地数据';
  if (ps.length <= 2) return ps.join(' · ');
  return `${ps.slice(0, 2).join(' · ')} +${ps.length - 2}`;
}

/** 单源视图下的模型分布：按会话的模型归属累加 token。 */
function byModelOf(summary, sourceKey) {
  const out = {};
  for (const x of summary.sessions) {
    if (x.source !== sourceKey) continue;
    const m = x.model || 'unknown';
    if (!out[m]) out[m] = { inputTokens: 0, outputTokens: 0, calls: 0, _tokens: 0 };
    out[m].calls += x.calls || 0;
    out[m]._tokens += x.tokens || 0;
  }
  return out;
}

function renderAllGrid(summary) {
  const el = $('allModels');
  if (!el) return;

  const tc = summary.todayCost;
  const byApp = (tc && tc.ok && tc.byApp) || {};
  const costUnit = (tc && tc.ok && tc.unit) || '￥';

  if (activeSource === 'all') {
    // 全部 Tab：只给一行概览，不画卡片墙
    const models = Object.keys(summary.byModel || {}).length;
    const activeSrc = Object.values(summary.bySource || {}).filter((s) => s && s.ok).length;
    el.innerHTML = `<div class="overview-row">
      <span class="ov-item"><b>${activeSrc}</b> 个工具在采集</span>
      <span class="ov-sep">·</span>
      <span class="ov-item"><b>${models}</b> 个模型用过</span>
    </div>`;

    const note = $('allModelsNote');
    if (note) {
      if (tc && tc.ok === false) {
        note.innerHTML =
          `<span class="cost-degrade">今日花费不可用：${esc(tc.reason || '未知原因')}` +
          `<span class="cost-degrade-sub">（来自 CC Switch 账本，其余数据不受影响）</span></span>`;
      } else if (tc && tc.ok) {
        note.textContent = `今日 ${costUnit}${fmtMoney(tc.totalCny)}`;
      } else {
        note.textContent = '';
      }
    }
    return;
  }

  // 具体工具 Tab：显示这个工具自己的三个数字
  const src = (summary.bySource || {})[activeSource] || {};
  const srcModels = Object.keys(byModelOf(summary, activeSource) || {}).length;
  const appCost = byApp[activeSource];

  el.innerHTML = `<div class="overview-row">
    <span class="ov-item"><b>${srcModels}</b> 个模型</span>
    <span class="ov-sep">·</span>
    <span class="ov-item"><b>${src.sessionCount || 0}</b> 个会话</span>
    ${
      appCost
        ? `<span class="ov-sep">·</span><span class="ov-item ov-cost">今日 <b>${costUnit}${fmtMoney(appCost.cny)}</b></span>`
        : ''
    }
  </div>`;

  const note = $('allModelsNote');
  if (note) {
    // 降级提示只在有花费概念（codex）时才有意义
    if (activeSource === 'codex' && tc && tc.ok === false) {
      note.innerHTML =
        `<span class="cost-degrade">今日花费不可用：${esc(tc.reason || '未知原因')}` +
        `<span class="cost-degrade-sub">（来自 CC Switch 账本）</span></span>`;
    } else {
      note.textContent = '';
    }
  }
}

/**
 * 积分额度区（付费模型用，与免费模型的限流区分开）。
 *
 * 真实值来自插件注册的只读路由（见 sources/quota.js），是上游计费接口的
 * 实时结果；DSH 未运行时降级为只显示本地消耗量，不会假装有额度数字。
 *
 * @param {object} summary 采集结果
 * @param {object} [opts]
 * @param {boolean} [opts.credits=true]  是否渲染 WorkBuddy 积分段
 * @param {boolean} [opts.relay=false]   是否渲染中转站余额段（Codex 用）
 * @param {boolean} [opts.official=false] 是否渲染 GPT 官方百分比段（官方登录的 5h/周窗口）
 */
function renderQuotas(summary, opts = {}) {
  const el = $('quotas');
  const wantCredits = opts.credits !== false;
  const wantRelay = !!opts.relay;
  const wantOfficial = !!opts.official;
  const credits = wantCredits ? summary.credits || [] : [];
  const providers = summary.providers || [];
  const parts = [];

  // 0) GPT 官方百分比额度（ChatGPT 订阅版的 5 小时 / 周窗口）。
  //
  //    数据来自本地 rollout（codex-source.js 解析 token_count 的 rate_limits），
  //    与官方登录态绑定；走中转站时全库无值，wantOfficial 为 false 或
  //    codexQuota 为 null，这里一个字都不渲染 —— 绝不编造百分比。
  //
  //    used_percent 是"该窗口已用百分比"，显示"剩余 = 100 - used"。
  //    resets_at 实测可为 null（上游窗口刚开始时不返回），此时只说
  //    「重置时刻未知」，不算倒计时。
  let officialShown = false;
  const official = wantOfficial ? summary.codexQuota : null;
  if (official) {
    const windows = [];
    if (official.primary) windows.push(official.primary);
    if (official.secondary) windows.push(official.secondary);
    if (windows.length) {
      officialShown = true;
      const srcTag = official.planType ? `（${esc(official.planType)}）` : '';
      parts.push(`<div class="quota-sep">GPT 官方额度${srcTag}</div>`);
      for (const w of windows) {
        const remain = 100 - w.usedPercent;
        // 剩余越少越红，阈值与积分区一致（>=50 绿 / >=20 黄 / 更低红）
        const color = remain >= 50 ? COLOR.ok : remain >= 20 ? COLOR.w : COLOR.c;
        const winName =
          w.windowMinutes === 300
            ? '5 小时窗口'
            : w.windowMinutes === 10080
              ? '7 天窗口'
              : w.windowMinutes
                ? `${Math.round(w.windowMinutes / 60)} 小时窗口`
                : '窗口';
        const resetTip = w.resetsAt
          ? `重置 ${new Date(w.resetsAt).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}`
          : '重置时刻未知（上游未返回）';
        // 数据时刻必须露出：窗口内的 used_percent 只增不减，但离上次官方
        // 会话越久越"陈旧"，用户要知道这个数是几点采的。
        const tipBits = [
          `已用 ${Math.round(w.usedPercent)}%`,
          official.fetchedAt
            ? `数据 ${new Date(official.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : '',
          resetTip,
        ].filter(Boolean);
        parts.push(`<div class="quota-row">
          <div class="quota-top">
            <span class="quota-name">GPT 官方 ${esc(winName)}</span>
            <span class="quota-credit" style="color:${color}">剩余 ${Math.round(remain)}%</span>
          </div>
          <span class="quota-track"><span class="quota-fill" style="width:${Math.max(2, Math.round(remain))}%;background:${color}"></span></span>
          <div class="quota-packs">
            <span class="quota-pack">${esc(tipBits.join(' · '))}</span>
          </div>
        </div>`);
      }
    }
  }

  // 1) 中转站余额（Codex 走中转站时唯一能拿到的真实余额）
  let relayShown = false;
  const relay = summary.relayBalance;
  if (wantRelay && relay && relay.ok) {
    relayShown = true;
    const remain = relay.remain ?? 0;
    const used = relay.used ?? 0;
    const total = relay.total ?? remain + used;
    // ratio 是「剩余/总额」，null 时（中转站没给已用量）画满但用中性色
    const ratio = relay.ratio == null ? null : relay.ratio;
    const color = ratio === null ? COLOR.ok : ratio >= 0.5 ? COLOR.ok : ratio >= 0.2 ? COLOR.w : COLOR.c;
    parts.push(`<div class="quota-row">
      <div class="quota-top">
        <span class="quota-name">Codex 中转站 剩余</span>
        <span class="quota-credit" style="color:${color}">$${fmtMoney(remain)}</span>
      </div>
      <span class="quota-track"><span class="quota-fill" style="width:${ratio === null ? 100 : Math.max(2, Math.round(ratio * 100))}%;background:${color}"></span></span>
      <div class="quota-packs">
        <span class="quota-pack">已用 $${fmtMoney(used)}${total ? ' / 共 $' + fmtMoney(total) : ''}</span>
      </div>
    </div>`);
  }

  // 2) 真实剩余额度（可能有两个账号：国内版 / 国际版）
  let creditShown = 0;
  for (const c of credits) {
    if (!c.ok) continue;
    creditShown++;
    const total = c.total ?? 0;
    const packs = (c.accounts || []).filter((a) => a.remain > 0 || a.unlimited);
    // 用"剩余占总额比例"着色：有 size 的包加权，没有则按总额给中性色
    const sizeSum = packs.reduce((s, a) => s + (a.size || 0), 0);
    const remainSum = packs.reduce((s, a) => s + (a.remain || 0), 0);
    const ratio = sizeSum > 0 ? remainSum / sizeSum : null;
    const color = ratio === null ? COLOR.ok : ratio >= 0.5 ? COLOR.ok : ratio >= 0.2 ? COLOR.w : COLOR.c;

    parts.push(`<div class="quota-row">
      <div class="quota-top">
        <span class="quota-name">${c.label} 剩余</span>
        <span class="quota-credit" style="color:${color}">${fmtNum(total)} 积分</span>
      </div>
      <span class="quota-track"><span class="quota-fill" style="width:${ratio === null ? 100 : Math.max(2, Math.round(ratio * 100))}%;background:${color}"></span></span>
      ${
        packs.length
          ? `<div class="quota-packs">${packs
              .map(
                (a) =>
                  `<span class="quota-pack">${esc(a.packageName)} ${fmtNum(a.remain)}${
                    a.size ? '/' + fmtNum(a.size) : ''
                  }</span>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`);
  }

  // 3) 取不到的账号：如实说明原因
  for (const c of credits) {
    if (c.ok) continue;
    parts.push(`<div class="quota-row">
      <div class="quota-top">
        <span class="quota-name">${c.label}</span>
        <span class="quota-credit unknown">${esc(c.error || '不可用')}</span>
      </div>
    </div>`);
  }

  // 4) 本地消耗量（判断今天烧得快不快）
  const top = providers.slice(0, 4);
  if (top.length) {
    const maxCalls = top[0].calls || 1;
    parts.push('<div class="quota-sep">今日本地消耗</div>');
    for (const p of top) {
      const w = Math.max(3, Math.round((p.calls / maxCalls) * 100));
      const known = p.credits !== null && p.coverage >= 50;
      const creditHtml = known
        ? `<span class="quota-credit">${p.credits} 积分</span>`
        : '<span class="quota-credit unknown">倍率未知</span>';
      parts.push(`<div class="quota-row">
        <div class="quota-top">
          <span class="quota-name" title="${esc(p.provider)}">${esc(p.label)}</span>
          <span class="quota-calls">${p.calls} 次</span>
          ${creditHtml}
        </div>
        <span class="quota-track"><span class="quota-fill" style="width:${w}%;background:rgba(255,255,255,0.35)"></span></span>
      </div>`);
    }
  }

  el.innerHTML = parts.join('') || '<div class="quota-hint">暂无数据</div>';
  /*
   * 右上角时间戳 —— 失败时显示「离线」这一状态**已按用户要求删除**。
   * 现在只有拿到数据才写采集时间，拿不到就留空。
   */
  $('quotaNote').textContent =
    creditShown || relayShown || officialShown
      ? new Date(summary.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })
      : '';
}

/** 中转站金额格式化：最多 2 位小数，避免一长串浮点尾巴。 */
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(2);
}

/**
 * 状态色，取值与原项目 StatusPalette.swift 一致：
 *   ok #3ddc84 · warning #ffd23f · critical #ff453a · idle #9a9aa0
 */
const COLOR = {
  ok: '#3ddc84',
  w: '#ffd23f',
  c: '#ff453a',
  idle: '#9a9aa0',
};

const $ = (id) => document.getElementById(id);

/** token 数格式化，对齐原项目 Formatting/TokenFormat.swift 的紧凑风格。 */
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

/** 普通数值千分位。 */
function fmtNum(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '--';
  return n.toLocaleString('zh-CN');
}

/**
 * 把各账号的剩余积分合成一个"剩余比例"，用于悬浮条圆环。
 *
 * 取所有可用包求 (剩余 / 总额)。若没有任何包带 size（只有 remain），
 * 则无法算比例，返回 null —— 此时 UI 退回用活跃度表示，不编造百分比。
 */
function quotaRatio(credits) {
  if (!Array.isArray(credits)) return null;
  let remainSum = 0;
  let sizeSum = 0;
  let hasUnlimited = false;
  for (const c of credits) {
    if (!c.ok) continue;
    for (const a of c.accounts || []) {
      if (a.unlimited) {
        hasUnlimited = true;
        continue;
      }
      if (typeof a.remain === 'number') remainSum += a.remain;
      if (typeof a.size === 'number') sizeSum += a.size;
    }
  }
  if (hasUnlimited) return { ratio: 1, unlimited: true };
  if (sizeSum <= 0) return null;
  return { ratio: Math.max(0, Math.min(1, remainSum / sizeSum)) };
}

/** 转义，避免上游返回的包名破坏结构。 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 额度色段：<70% 绿 · >=70% 黄 · >=90% 红（原项目 README 明示的阈值）。 */
function levelFor(ratio) {
  if (ratio >= 0.9) return 'crit';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

let currentSummary = null;
let activeSource = 'all'; // 'all' 或具体源 key

/**
 * 面板顶部的工具切换 Tab。
 *
 * 为什么按工具分开而不是合并统计：三个 agent 的 token 口径不同
 * （Claude 按 message.usage、Codex 按 token_usage_record、DSH 按 data.usage），
 * 合并成一个数字既没意义也看不出是谁在烧。用户要的是「切到某个工具，
 * 只看它自己的模型用量与会话」。
 *
 * 只渲染有数据的源 —— 没装 Claude Code 的人不该看到一个空的 Claude Tab。
 */
function renderTabs(summary) {
  const el = $('panelTabs');
  if (!el) return;

  const bySrc = summary.bySource || {};
  const tabs = [{ key: 'all', label: '全部', icon: null }];

  /*
   * 顺序必须与胶囊里的圆环一致。
   *
   * 胶囊按 RING_LAYOUT（设置页排序）渲染，但 bySource 是采集层给的，
   * 键序是 claude → codex → dsh。直接遍历 bySource 会让 Tab 顺序和上面的
   * 圆环对不上，用户点的"第二个"和看到的"第二个环"是不同工具。
   * 所以先按 RING_LAYOUT 里数据源环的顺序来，再补上它没涵盖的源
   * （CC Switch app 型环没有会话数据，不出 Tab）。
   */
  const layoutSources = RING_LAYOUT.filter((k) => RING_DEFS[k] && RING_DEFS[k].kind === 'source');
  const ordered = [
    ...layoutSources.filter((k) => bySrc[k]),
    ...Object.keys(bySrc).filter((k) => !layoutSources.includes(k)),
  ];
  for (const key of ordered) {
    const s = bySrc[key];
    if (!s || !s.ok) continue; // 采集失败的源不占位置
    tabs.push({ key, label: s.label || key, logo: RING_DEFS[key] && RING_DEFS[key].logo });
  }

  // 当前选中的源如果消失了（比如关掉了数据源），退回「全部」
  if (activeSource !== 'all' && !tabs.some((t) => t.key === activeSource)) {
    activeSource = 'all';
  }

  el.innerHTML = tabs
    .map((t) => {
      const on = t.key === activeSource;
      const logo = t.logo
        ? `<img class="tab-logo" src="assets/${t.logo}" alt="" />`
        : '';
      return `<button class="tab${on ? ' on' : ''}" data-src="${esc(t.key)}">${logo}<span>${esc(t.label)}</span></button>`;
    })
    .join('');

  // 事件绑定（重新渲染后要重新绑）
  el.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.src;
      if (key === activeSource) return;
      activeSource = key;
      if (currentSummary) render(currentSummary);
    });
  });
}

/**
 * 每个 agent 一个 mark：圆环（自身 level 色）+ 品牌 logo + 百分比。
 *
 * 对齐原项目 SimpleMeterView.cell()：
 *   ZStack { 圆环(轨道 + trim) ; AgentLogo(vendor, size) } + Text(百分比, tabular, tint)
 * 圆环 trim = 该 agent 最紧窗口的 usedPct；没有窗口数据时退化为 idle 灰。
 * 品牌 logo 用原项目 bundled 的 PNG（assets/<vendor>.png），
 * 缺失的 vendor 退化为字母徽标。
 */
const VENDOR_LOGO = {
  claude: 'claude.png',
  codex: 'chatgpt.png',
  dsh: 'deepseek.png',
  workbuddy: 'workbuddy.png',
  'workbuddy-ai': 'codebuddy.png',
  opencode2dsh: 'opencode.png',
  'deepseek-account': 'deepseek.png',
  jy: 'glm.png',
  qingshu: 'qwen.png',
  glm: 'glm.png',
  kimi: 'kimi.png',
  grok: 'grok.png',
  copilot: 'copilot.png',
  cursor: 'cursor.png',
  openclaw: 'openclaw.png',
  hermes: 'hermes.png',
  antigravity: 'antigravity.png',
  qwen: 'qwen.png',
  qoder: 'qoder.png',
  zcode: 'zcode.png',
  pi: 'pi.png',
};

/** vendor → 字母兜底（原项目 lettered badge）。 */
function vendorInitial(vendor) {
  const v = String(vendor || '?');
  return v.replace(/[^a-z]/gi, '').slice(0, 1).toUpperCase() || '?';
}

/** 折叠时最多显示几个活跃模型（其余收进 +N，点开看全部）。 */
const MAX_VISIBLE_MARKS = 5;

/** 全部模型的展开态（点 +N 切换）。 */
let marksExpanded = false;

/**
 * 单个 mark 的 HTML（栏上与面板网格共用）。
 *
 * 严格复刻原项目 SimpleMeterView.cell()：
 *   HStack(spacing: labelSpacing) {
 *     ZStack { 圆环(轨道 + trim) ; AgentLogo(size: logo) }   ← 环内只有 logo
 *     Text(label).foregroundStyle(tint)                       ← 环右侧的数字
 *   }
 *
 * 语义与原版一致：
 *   - 环的填充 = usedPct（最紧窗口已用比例），颜色 = 该分组的 level 色
 *   - 右侧数字 = 已用百分比；无读数时是破折号「–」
 *   - 受限（不能用）时整环填满并标红
 *
 * 说明：今日花费（CC Switch 账本）暂不上环 —— 原版的环表达的是"配额用了多少"，
 * 不是"花了多少钱"，两者语义不同；花费在悬停面板里看。
 */
/**
 * 单个 mark 的 HTML —— 严格复刻原项目 SimpleMeterView.cell() 的环：
 *
 *   ZStack {
 *     Circle().strokeBorder(.white.opacity(0.14), lineWidth: ringWidth)   ← 灰色轨道（整圈）
 *     Circle().inset(by: ringWidth/2)
 *             .trim(from: 0, to: usedPct/100)                            ← 彩色进度弧
 *             .stroke(tint, lineWidth: ringWidth)                        ← tint = level 色
 *             .rotationEffect(-90°)
 *     AgentLogo(size: logo)
 *   }
 *
 * 关键：环是「灰轨道 + 彩色已用弧」，不是纯灰也不是纯色 ——
 * 这是原版 UI 的灵魂，之前做错成纯灰环，所以完全没有原版的感觉。
 *
 * 填充量 usedPct = min(100, 今日花费 / 日预算 × 100)。
 * 预算（人民币）可在设置中修改，默认 8 元 —— 通过 hud:get-config 拉取，
 * 拉取失败时用这里的兜底值。
 */
let DAILY_BUDGET_CNY = 8;

/** 从主进程拉配置，更新预算分母（启动时调用一次）。 */
async function loadBudget() {
  try {
    const cfg = await window.hud.getConfig();
    const n = Number(cfg && cfg.dailyBudgetCny);
    if (Number.isFinite(n) && n > 0) DAILY_BUDGET_CNY = n;
    // 圆环集合与顺序也来自配置（设置页「悬浮条圆环」里勾选 + 排序的结果）
    if (Array.isArray(cfg && cfg.ringLayout) && cfg.ringLayout.length) {
      RING_LAYOUT = cfg.ringLayout.filter((k) => RING_DEFS[k]);
    }
    // 配置拿到后立刻重绘一次，让环弧与行式用量按新预算计算
    if (currentSummary) render(currentSummary);
  } catch (_) {
    /* 拉不到就用默认值 */
  }
}

function markHtml(r, opts) {
  const { compact, todayUsd } = opts || {};
  /*
   * 金额用**人民币**值（todayCny）。
   *
   * 数据库字段名虽叫 total_cost_usd，但实测 CC Switch 界面显示的是 ÷5 后的数
   * （$4.2342 → 0.8498），且用户确认为人民币。直接显示 usd 会让人以为花了
   * 4 美元，属于误导。换算见 ccswitch.js 的 USD_TO_CNY。
   */
  const todayCny = r.todayCny != null ? r.todayCny : todayUsd != null ? todayUsd / 5 : null;
  const vendor = r.vendor || r.provider || r.model || 'unknown';
  // 数据源级别的条目自带 logo（见 SOURCE_VENDOR）；模型级别才查 VENDOR_LOGO
  const logo = r.logo || VENDOR_LOGO[vendor];
  // chatgpt.png 是纯黑图形，在黑色胶囊上看不见 —— 原项目也是把它染成 OpenAI 绿，
  // 这里用 data-tint 让 CSS 做等效染色。
  const tint = logo === 'chatgpt.png' ? ' data-tint="openai"' : '';
  const mark = logo
    ? `<img class="mark-logo" src="assets/${logo}" alt="${esc(vendor)}"${tint} />`
    : `<span class="mark-badge">${vendorInitial(vendor)}</span>`;

  // ---- 颜色：只看该分组的实时状态（可用绿 / 无数据灰）----
  const liveLevel = r.hitCount > 0 ? 'ok' : 'idle';
  const color = liveLevel === 'ok' ? COLOR.ok : COLOR.idle;
  const state = liveLevel === 'ok' ? '可用' : '无调用';

  // ---- 进度弧填充比例 ----
  // 用人民币口径：花费(CNY)/预算(CNY)。与显示的金额同一单位，弧长才对得上。
  // 预算 <= 0（设置里留空/填 0）= 禁用比例，弧只显示状态点。
  let usedPct;
  if (DAILY_BUDGET_CNY > 0 && todayCny != null && todayCny >= 0) {
    usedPct = Math.max(0, Math.min(1, todayCny / DAILY_BUDGET_CNY));
  } else {
    usedPct = 0;
  }
  /*
   * 弧长必须如实反映花费，不能为了"看得见"而放大。
   *
   * 之前给 MIN_ARC=0.18（18%），结果今天一分钱没花，环上却画了 18% 的绿弧 ——
   * 这是假数据，比看不见更糟。
   *
   * 现在的处理：
   *   有花费 → 弧长 = 花费/预算（真实值）
   *   零花费 → 只留一个圆点（约 1.5%），单纯标示"状态色 + 起点在 12 点"，
   *            只要能用肉眼分辨出"几乎没有"，就不会被误读成"用了很多"
   */
  const arc = usedPct > 0 ? usedPct : 0.015;
  // 周长 97.4（r=15.5）：dasharray 97.4，dashoffset = 97.4×(1-arc)
  const dash = +(97.4 * (1 - arc)).toFixed(2);

  const tip = compact
    ? ''
    : `<span class="grid-meta">${esc(r.providerLabel || vendor)} · ${state}${
        todayCny != null
          ? ` · 今日 ￥${todayCny.toFixed(2)}`
          : r.spendTip
            ? ` · ${r.spendTip}`
            : ''
      }${r.spendTip && todayCny != null ? ` · ${r.spendTip}` : ''}</span>`;

  /*
   * 金额标签：跟在环的右侧（原版是百分比数字的位置）。
   *
   * 只在**展开（悬停）态**显示 —— 收起态要严格保持原版「纯环 + logo」的形态，
   * 用户此前也明确要求「金额暂时不显示」。用 CSS 控制显隐（body.hovering），
   * 这样收起态宽度只包含环，不会把胶囊撑宽。
   *
   * 取不到花费时显示破折号而不留空，避免看起来像是"渲染失败"。
   */
  const costLabel =
    todayCny != null
      ? `￥${todayCny.toFixed(2)}`
      : r.spendLabel
        ? r.spendLabel
        : '&mdash;';

  /*
   * 可用性状态 → 只挂在 mark 上，**不再影响胶囊底色**。
   *
   * 2026-10-24 用户决定：胶囊底色完全不随可用性变化（绿底、暗红底及呼吸动画
   * 已全部删除，胶囊永远是纯黑）。状态语义改由这三处承担：
   *   · 本函数写出的 data-state / mark--<state>（CSS 悬停提示、图标变色）
   *   · 圆环颜色（正常绿 / 限流红 / 不可用灰）
   *   · body[data-avail]（renderMarks 汇总写出，供调试与将来扩展，无 CSS 消费）
   */
  const barState = r.degraded ? 'unavailable' : r.availability != null ? 'healthy' : 'unknown';

  // 悬停提示：不可用时明确说清"哪里不可用、失败率多少"
  const availTip =
    r.availability != null
      ? `；可用性 ${(r.availability * 100).toFixed(1)}%（近24h ${r.availRequests} 次，失败 ${r.availErrors} 次）${
          r.avgLatencyMs != null ? `，平均延迟 ${(r.avgLatencyMs / 1000).toFixed(1)}s` : ''
        }`
      : '；暂无可用性样本';

  return `<div class="mark${compact ? '' : ' grid-item'} mark--${barState}" data-state="${barState}" title="${esc(
    r.key
  )} — ${state}${availTip}${
    todayCny != null
      ? `；今日 ￥${todayCny.toFixed(2)} / 预算 ￥${DAILY_BUDGET_CNY}`
      : r.spendTip
        ? `；${r.spendTip}`
        : ''
  }${r.spendTip && todayCny != null ? `；${r.spendTip}` : ''}">
    <div class="mark-icon">
      <!-- 不能写死 width/height="22"：容器是 --mark(30px)，SVG 只占 22 就会贴在
           左上角，而 logo 按 30 居中，两者差 4px —— 视觉上就是"图标不在环心"。
           尺寸完全交给 CSS（.mark-icon svg { inset:0; width/height:100% }）。 -->
      <svg viewBox="0 0 36 36" preserveAspectRatio="xMidYMid meet">
        <!-- 灰色轨道：整圈，原版 strokeBorder(.white.opacity(0.14)) -->
        <circle class="ring-track" cx="18" cy="18" r="15.5" />
        <!-- 彩色进度弧：从 0 画到 usedPct，起点在顶部（CSS rotate -90deg） -->
        <circle class="ring-value" cx="18" cy="18" r="15.5"
                style="stroke-dashoffset:${dash};stroke:${color}" />
      </svg>
      ${mark}
    </div>
    ${
      compact
        ? `<span class="mark-cost" title="${
            todayCny != null
              ? `今日使用金额 ￥${todayCny.toFixed(2)} / 预算 ￥${DAILY_BUDGET_CNY}${r.spendTip ? `；${r.spendTip}` : ''}`
              : r.spendTip
                ? r.spendTip
                : '今日使用金额（无数据）'
          }">${costLabel}</span>`
        : ''
    }
    ${tip}
  </div>`;
}

/**
 * 从汇总数据里取出「按数据源」的圆环条目。
 *
 * 为什么不能直接用 rateLimits：那是 DSH 内部各 provider 的**模型级**限流表，
 * 里面根本没有 codex（Codex 走中转站，不进 DSH 的限流日志）。用它会显示成
 * workbuddy / opencode2dsh 一堆图标，而不是用户要的「Codex 圆环」。
 *
 * 原版语义是**每个 agent 一个环**（Claude / Codex / DeepSeek…），
 * 所以这里按 bySource 的三个数据源构造：
 *   claude → claude.png · codex → chatgpt.png（原版 canonical 里 Codex 用 ChatGPT 图）· dsh → deepseek.png
 *
 * 环的状态取该源下所有模型里最"严重"的一个：
 *   任一模型限流 → 该源整体标红（用户用到它就会撞墙）
 */
/*
 * 数据源 → 品牌元信息。
 *
 * 这个对象的**键序就是胶囊里圆环的渲染顺序**（codex → claude → dsh），
 * 面板 Tab 也沿用同一顺序（见 renderTabs），保证"第几个环"和"第几个 Tab"对应。
 *
 * Codex 用绿色版 logo（codex-green.png）：原版 chatgpt.png 是黑白的，
 * 放在深色胶囊里几乎看不出是 Codex，而绿色正好对应它圆环的状态色。
 */
const SOURCE_VENDOR = {
  codex: { vendor: 'codex', label: 'Codex', logo: 'codex-green.png' },
  claude: { vendor: 'claude', label: 'Claude Code', logo: 'claude.png' },
  dsh: { vendor: 'dsh', label: 'DeepSeek', logo: 'deepseek.png' },
};

/*
 * CC Switch app_type 环（无会话采集的纯账本环）。
 *
 * CC Switch 支持 13 个 app（AppType 枚举），其中 claude-desktop 在账本层
 * 已归一化进 claude 环，codex/claude/dsh 各有自己的环，剩下的都在这里。
 * 它们没有会话/模型数据，环上只有两样东西：
 *   · 金额与弧长 —— 来自 CC Switch 账本按 app_type 的今日花费
 *   · 颜色 —— 近 24h 有请求记录（账本里 status_code 样本）→ 绿，否则灰
 * 默认全部隐藏，在设置页按需勾选；枚举对齐 CC Switch 的 as_str()，
 * 以后它新增 app 时在这里补一行即可（config.js 的 RING_KEYS 同步加）。
 */
const CC_APP_RINGS = {
  gemini: { vendor: 'gemini', label: 'Gemini', logo: 'gemini.svg' },
  grokbuild: { vendor: 'grokbuild', label: 'Grok Build', logo: 'grok.svg' },
  opencode: { vendor: 'opencode', label: 'OpenCode', logo: 'opencode.png' },
  openclaw: { vendor: 'openclaw', label: 'OpenClaw', logo: 'openclaw.png' },
  hermes: { vendor: 'hermes', label: 'Hermes', logo: 'hermes.png' },
  pi: { vendor: 'pi', label: 'Pi', logo: 'pi.png' },
  mcode: { vendor: 'mcode', label: 'MiniMax Code', logo: 'minimax.svg' },
  kimi: { vendor: 'kimi', label: 'Kimi Code', logo: 'kimi.svg' },
  agy: { vendor: 'agy', label: 'Antigravity', logo: 'antigravity.svg' },
  omp: { vendor: 'omp', label: 'Oh My Pi', logo: null },
};

/*
 * 全部可展示圆环的元数据（键集与 config.js 的 RING_KEYS 一致）。
 * kind 区分取数路径：source 走 bySource（会话采集），app 走账本 byApp。
 */
const RING_DEFS = {
  ...Object.fromEntries(Object.entries(SOURCE_VENDOR).map(([k, v]) => [k, { ...v, kind: 'source' }])),
  ...Object.fromEntries(Object.entries(CC_APP_RINGS).map(([k, v]) => [k, { ...v, kind: 'app' }])),
};

/**
 * 当前展示的圆环集合与顺序（配置 ringLayout，设置页可改）。
 * 默认值 = 旧行为的三个环；配置未到达前先按它画，配置到了再重排。
 */
let RING_LAYOUT = ['codex', 'claude', 'dsh'];

function sourceMeterItems(summary) {
  const bySrc = summary.bySource || {};
  // 今日花费按 app_type 分组：{ claude: {usd,requests}, codex: {...}, ... }
  const byApp = (summary.todayCost && summary.todayCost.ok && summary.todayCost.byApp) || {};
  const availability = summary.availability || null;
  const items = [];

  /*
   * 按 RING_LAYOUT 的顺序渲染（设置页可勾选与排序），不按活跃度重排 ——
   * 位置固定，用户才能形成肌肉记忆，一眼找到要看的那个。
   * 状态已经用颜色区分，不需要靠排序来突出。
   */
  for (const key of RING_LAYOUT) {
    const def = RING_DEFS[key];
    if (!def) continue; // 未知键（配置比程序旧）直接跳过

    if (def.kind === 'app') {
      /*
       * CC Switch app_type 环：没有会话采集，只有账本。
       * 「可用」= 近 24h 账本里有它的请求记录（含今日花费里的请求），
       * 没有记录的 app 环显示灰色「无调用」—— 与 source 环的语义一致。
       */
      const appCost = byApp[key];
      const todayUsd = appCost && typeof appCost.usd === 'number' ? appCost.usd : null;
      let todayCny =
        appCost && typeof appCost.cny === 'number' ? appCost.cny : todayUsd != null ? todayUsd / 5 : null;
      // 与 source 环同一口径：账本能读而今天没有请求 → ￥0.00（读不到才是「—」）
      if (todayCny == null && summary.todayCost && summary.todayCost.ok) {
        todayCny = 0;
      }

      const avail = availability && availability.ok ? availability.byApp[key] : null;
      const MIN_SAMPLE = 3;
      const hasAvail = avail && avail.requests >= MIN_SAMPLE && avail.availability != null;
      const degraded = hasAvail && avail.availability < 1;
      const hasTraffic =
        (appCost && (appCost.requests || 0) > 0) || (avail && (avail.requests || 0) > 0);

      items.push({
        vendor: def.vendor,
        label: def.label,
        logo: def.logo,
        hitCount: hasTraffic ? 1 : 0,
        sessionCount: 0,
        todayUsd,
        todayCny,
        spendLabel: null,
        spendTip: null,
        key: def.label,
        providerLabel: def.label,
        availability: hasAvail ? avail.availability : null,
        availRequests: avail ? avail.requests : 0,
        availErrors: avail ? avail.errors : 0,
        avgLatencyMs: avail ? avail.avgLatencyMs : null,
        p95LatencyMs: avail ? avail.p95LatencyMs : null,
        degraded,
      });
      continue;
    }

    const src = bySrc[key];
    if (!src || src.error) continue;

    /*
     * 「可用」= 该源有会话或调用记录（有数据就说明这个 agent 在用）。
     * Beta 限流监控已删除（2026-10-25），环色只剩可用绿 / 无调用灰两态。
     */
    const hasData = (src.sessionCount || 0) > 0 || (src.totals && (src.totals.calls || 0) > 0);
    const usable = hasData;

    // 这一源今日花了多少（CC Switch 的 app_type 与我们的 key 同名：claude/codex）
    const appCost = byApp[key];
    const todayUsd = appCost && typeof appCost.usd === 'number' ? appCost.usd : null;
    // 人民币值（界面显示用）；ccswitch 已算好，取不到时按 1:5 兜底
    let todayCny =
      appCost && typeof appCost.cny === 'number' ? appCost.cny : todayUsd != null ? todayUsd / 5 : null;

    /*
     * 账本能读、但该 app 今天没有请求 → 花费就是 0，不是"未知"。
     * 之前显示破折号「—」，看起来像渲染失败；0 元是账本的真实结论
     * （GROUP BY 只返回有请求的 app，缺席 = 今天没花）。
     * 账本整个读不到（todayCost.ok=false）才是真正的未知，仍显示「—」，
     * 悬停提示里会给原因。DSH 不进账本，走下面自己的兜底。
     */
    if (key !== 'dsh' && todayCny == null && summary.todayCost && summary.todayCost.ok) {
      todayCny = 0;
    }

    /*
     * DSH 的金额显示（2026-10-25 用户决定）：**与 Claude / Codex 同一形态** ——
     * 主显示改成「今日已使用金额」（环弧 = 今日已用/预算，金额标签 = ￥今日已用），
     * 余额退到悬停提示里，不再占据标签位。
     *
     * 今日值来自小鲸鱼账本的「余额观测法」（账本自己记一天内的余额差值），
     * 单位已是账户本币，不用换算。三条兜底：
     *   · 官方接口通道没有今日值（todayUsage=null）→ 标签退回「余额 …」；
     *   · 账本跨天没刷新（date 不是今天）→ deepseek-balance 已把 todayUsage 置 null；
     *   · 本币不是 CNY → **不能**塞进 todayCny（那一路径的标签写死 ￥，
     *     会把美元金额标成人民币），仍按带符号的「余额 $…」显示。
     */
    const dsBal = summary.deepseekBalance;
    const dsOk = key === 'dsh' && dsBal && dsBal.ok === true && typeof dsBal.total === 'number';
    /*
     * 符号跟随 dsBal.currency（'¥' / '$' / 未知币种给 "CODE "），
     * 因为账本的 accounting.active 会随账户本币变成 "<指纹>-USD" ——
     * 写死 ¥ 会把美元余额标成人民币，数字对、单位错，比空着更坏。
     */
    const dsSym = dsOk ? currencySymbol(dsBal.currency) : '';
    const dsToday = dsOk && typeof dsBal.todayUsage === 'number' ? dsBal.todayUsage : null;
    /*
     * DSH 没打开（账本没今天的记录 / 压根读不到账本）→ 金额标签显示 ￥0.00，
     * 不再退回「余额 ￥x」占位 —— 侧置竖排宽度有限，"余额 ￥3.02" 会被裁成
     * 只剩"余额"两个字（用户反馈）。余额仍在悬停提示（spendTip）里。
     * 例外：账本可读且本币不是 CNY 时今日值进不了 todayCny（标签写死 ￥，
     * 会把美元标成人民币），仍按「今日/余额 $…」显示。
     */
    const dsCnyAccount =
      key === 'dsh' && (!dsOk || String(dsBal.currency || 'CNY').toUpperCase() === 'CNY');
    if (key === 'dsh' && dsCnyAccount) {
      todayCny = dsToday != null ? dsToday : 0;
    }

    const spendLabel = !dsOk
      ? null
      : dsToday != null
        ? `今日 ${dsSym}${fmtMoney(dsToday)}`
        : `余额 ${dsSym}${fmtMoney(dsBal.total)}`;
    let spendTip = null;
    if (dsOk) {
      const parts = [];
      if (dsToday != null) parts.push(`今日已用 ${dsSym}${fmtMoney(dsToday)}`);
      parts.push(`DeepSeek 余额 ${dsSym}${fmtMoney(dsBal.total)}`);
      if (dsBal.updatedAt) {
        const d = new Date(dsBal.updatedAt);
        parts.push(`更新于 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
      }
      if (dsBal.stale) parts.push('账本未刷新，数据可能偏旧');
      if (dsBal.source === 'whale-ledger') parts.push('来源：小鲸鱼账本');
      else if (dsBal.source === 'whale-http') parts.push(`来源：小鲸鱼路由${dsBal.pluginVersion ? ' v' + dsBal.pluginVersion : ''}`);
      else if (dsBal.source === 'api') parts.push('来源：官方余额接口');
      spendTip = parts.join(' · ');
    } else if (key === 'dsh' && dsBal && dsBal.ok === false && dsBal.reason) {
      spendTip = `DeepSeek 余额不可用：${dsBal.reason}`;
    }

    /*
     * 可用性（近 24h 请求成功率）—— 来自 CC Switch 的 status_code 统计。
     *
     * 这与 limited（上游限流）是**两个不同维度**：
     *   limited   = 撞到配额上限，请求被拒（DSH 日志信号）
     *   available = 中转站/官方接口返回 4xx/5xx 或超时（CC Switch 账本信号）
     * 二者任一异常都算"这个 agent 当前不可用"，但提示文案要区分开。
     */
    const avail = availability && availability.ok ? availability.byApp[key] : null;
    // 至少要有一定样本才判定，否则一两次偶发失败会造成闪烁
    const MIN_SAMPLE = 3;
    const hasAvail = avail && avail.requests >= MIN_SAMPLE && avail.availability != null;
    const degraded = hasAvail && avail.availability < 1;

    items.push({
      vendor: def.vendor,
      label: def.label,
      logo: def.logo,
      // 传 1 表示"有可用读数"，让 markHtml 的颜色判定给出绿而不是灰
      hitCount: usable ? 1 : 0,
      sessionCount: src.sessionCount || 0,
      todayUsd,
      todayCny,
      spendLabel,
      spendTip,
      key: def.label,
      providerLabel: def.label,
      // 可用性附加信息（供 mark 底色与悬停提示使用）
      availability: hasAvail ? avail.availability : null,
      availRequests: avail ? avail.requests : 0,
      availErrors: avail ? avail.errors : 0,
      avgLatencyMs: avail ? avail.avgLatencyMs : null,
      p95LatencyMs: avail ? avail.p95LatencyMs : null,
      degraded,
    });
  }
  return items;
}

function renderMarks(summary) {
  const el = $('marks');
  const items = sourceMeterItems(summary);

  // 顺序 = RING_LAYOUT（设置页「悬浮条圆环」里勾选并排序的结果），
  // 不按活跃度重排 —— 位置固定，用户才能形成肌肉记忆，一眼找到要看的那个。

  let html = items
    .map((r) => markHtml(r, { compact: true, todayUsd: r.todayUsd, todayCny: r.todayCny }))
    .join('');

  el.innerHTML = html || '<span class="mark-label" style="color:var(--text-dim)">暂无数据</span>';

  /*
   * 整体可用性聚合：只写到 body[data-avail] 与 mark 类名，**不再驱动胶囊底色**。
   *
   * 聚合规则（只看**有样本**的 mark）：
   *   任一有样本的 mark 不可用 → unavailable
   *   有样本的 mark 全部可用   → healthy
   *   没有任何样本             → unknown
   *
   * 2026-10-24：胶囊底色与可用性脱钩（绿/红底+呼吸动画全部移除），
   * 这个聚合值现在只用于调试观察与将来扩展；视觉状态靠圆环颜色与悬停提示。
   *
   * 为什么要排除 unknown：Claude / DSH 的请求不进 CC Switch 账本
   * （Claude 走官方账号、DSH 走 WorkBuddy 直连），它们永远没有可用性样本。
   * 若要求"所有 mark 都 healthy"才算，无样本项会永远把结论拖成 unknown，
   * 实测踩到过（body 的 data-avail 恒为 unknown）。所以只对"能判断的"下结论。
   */
  const states = items.map((r) => (r.degraded ? 'unavailable' : r.availability != null ? 'healthy' : 'unknown'));
  const known = states.filter((s) => s !== 'unknown');
  let barState = 'unknown';
  if (known.includes('unavailable')) barState = 'unavailable';
  else if (known.length > 0 && known.every((s) => s === 'healthy')) barState = 'healthy';
  document.body.dataset.avail = barState;

  /*
   * 胶囊流光（2026-10-27 用户要求）：金额数据健康度绕边流动。
   *   任一可见环没拿到正确金额（显示「—」）→ 红黑流动；
   *   全部拿到 → 黑绿流动；启动首帧 items 为空 → 不标注（流光不出现，不预判）。
   * dsh 非人民币账户显示「余额 $x」（spendLabel）也算拿到了金额。
   * 账本整体读不到时 claude/codex/app 环全部为 null → 自动落到 bad，无需单列。
   */
  const flowBad = items.some((r) => r.todayCny == null && !r.spendLabel);
  document.body.dataset.flow = items.length ? (flowBad ? 'bad' : 'ok') : '';

  // 回报内容宽度（环数变化与 hover 态都会影响栏宽）
  measureBar();
}

/**
 * 回报悬浮条的内容宽度，让窗口贴合实际内容。
 *
 * 注意：不能用 bar.scrollWidth —— 面板 .panel 是 position:absolute 但仍参与
 * scrollWidth 计算，会把面板里 21 个模型的网格宽度算进来（实测撑到 903px
 * 而栏本身只需 556px）。改为遍历 bar 的直接子元素累加宽度。
 *
 * display:none 的子元素宽度为 0，自动不计入 —— 收起态只量到环，悬停态
 * 量到「环 + 统计 + 按钮」，两个状态各自贴合。
 */
function measureBar() {
  if (!window.hud || !window.hud.measure) return;
  /*
   * 竖排：回报的不是宽度而是**收起态竖条高度**——主进程用它在 dockRect/
   * setExpanded 里动态定竖条长度（旧实现写死 SIDE_RUN=130，环多了被裁掉）。
   * 竖排悬停高度不经这里走（setHovering 直接传 verticalHoverHeight()）。
   */
  if (verticalLayout) {
    const h = verticalRunHeight();
    if (h > 0) window.hud.measure(h, document.body.classList.contains('hovering') || panelOpen);
    return;
  }
  /*
   * 拖动中不测量：拖动时窗口尺寸被冻结，主进程也不会按测量值重排；
   * 而横↔竖翻转的瞬间窗口先变窄、body.vertical 还没到（它走 IPC），
   * 这时按横排量出来的宽度只有几十像素，会把 contentWidth 污染成下限
   * （实测翻转一次，松手后胶囊变成 100px 的窄条）。
   */
  if (drag) return;
  requestAnimationFrame(() => {
    if (drag) return;
    const need = measureBarNeed();
    if (need) {
      /*
       * 必须告诉主进程这次量的是哪种状态：悬停态量到的是加宽值（露出统计与
       * 按钮），主进程只能把它当"当前宽度"，不能记成收起态宽度——否则拖动
       * 落回时用的是加宽值，用户就在拖一条"完全展开"的大胶囊。
       */
      const hovering = document.body.classList.contains('hovering') || panelOpen;
      window.hud.measure(need, hovering);
    }
  });
}

/**
 * 同步量出胶囊需要的内容宽度（不排队到下一帧）。
 * 测量期间临时关掉子元素的过渡（body.measuring）：悬停加宽/收窄是 width 过渡，
 * 过渡途中 getBoundingClientRect() 只会给出中间的宽度，量出来会偏大或偏小
 * （实测启动瞬间拿到过 420px 而不是 134px 的宽度）。关掉过渡后布局直接跳到终值，
 * 量到的就是稳态尺寸；同一任务内立刻移除 class，不会产生可见的重绘。
 */
function measureBarNeed() {
  const el = $('bar');
  if (!el) return 0;
  const wasMeasured = document.body.classList.contains('measuring');
  if (!wasMeasured) document.body.classList.add('measuring');
  try {
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    let sum = 0;
    let count = 0;
    for (const child of el.children) {
      if (child.classList.contains('panel')) continue; // 面板在栏下方，不占宽
      const r = child.getBoundingClientRect();
      if (r.width > 0) {
        sum += r.width;
        count++;
      }
    }
    // +8 余量：边框 1px×2 + 圆角抗锯齿 + 亚像素取整（+2 时实测仍差 2px 裁按钮）
    return Math.ceil(padL + padR + sum + gap * Math.max(0, count - 1)) + 8;
  } finally {
    if (!wasMeasured) document.body.classList.remove('measuring');
  }
}

function render(summary) {
  currentSummary = summary;
  // 采集成功：清零失败计数，避免旧的瞬时失败提示再次冒出来
  softFailStreak = 0;

  // 简约形态：每个 agent 一个 mark（圆环 + logo + 金额），无总览圆环、无光晕
  renderMarks(summary);
  // 顶部工具 Tab（数据到了才渲染，避免闪一下空 Tab）
  renderTabs(summary);
  // 概况行：随当前 Tab 变化（全部=全局概览，具体工具=该工具统计 + 今日花费）
  renderAllGrid(summary);

  const view = pickView(summary);
  if (!view) return;

  $('panelTime').textContent = new Date(summary.generatedAt).toLocaleTimeString('zh-CN', { hour12: false });
  $('filterNote').textContent = activeSource === 'all' ? '' : view.label;

  /*
   * 额度区：按工具分三部分，谁的数据谁显示。
   *
   *  - WorkBuddy 积分（DSH 源）：只有 DSH 有积分概念
   *  - 中转站余额（Codex 源）：Codex 走中转站时官方额度接口拿不到，
   *    改用中转站自己的余额接口（relay.js）
   *  - GPT 官方百分比（Codex 源）：官方登录态的 5h/周窗口，数据在本地
   *    rollout 里（codex-source.js 解析）；走中转站时无值，不显示。
   */
  const quotaSection = $('quotaSection');
  const showCredits = activeSource === 'all' || activeSource === 'dsh';
  const relay = summary.relayBalance || null;
  const showRelay = (activeSource === 'all' || activeSource === 'codex') && relay && relay.ok;
  /*
   * GPT 官方百分比：只在真拿到窗口数据时显示（primary/secondary 任一存在）。
   * 不按 provider 过滤 —— 中转站若转发官方窗口同样显示，按数据说话。
   */
  const official = summary.codexQuota || null;
  const showOfficial =
    (activeSource === 'all' || activeSource === 'codex') &&
    !!official &&
    !!(official.primary || official.secondary);
  const showQuota = showCredits || showRelay || showOfficial;

  if (quotaSection) quotaSection.hidden = !showQuota;

  if (showQuota) {
    // 标题随场景改名：多个数据段并存时叫「额度」，单一时叫具体名
    const title = quotaSection && quotaSection.querySelector('.panel-head > span');
    if (title) {
      const sections = [showCredits, showRelay, showOfficial].filter(Boolean).length;
      title.textContent =
        sections > 1
          ? '额度'
          : showOfficial
            ? 'GPT 官方额度'
            : showRelay
              ? '中转站余额'
              : '额度（积分）';
    }
    renderQuotas(summary, { credits: showCredits, relay: showRelay, official: showOfficial });
  } else {
    $('quotas').innerHTML = '';
    $('quotaNote').textContent = '';
  }

  /*
   * 模型用量条：按当前 Tab 过滤。
   *
   * Codex Tab 额外显示每个模型的今日花费（来自 CC Switch 按 model 聚合的
   * byAppModel）。这个数字是真的钱，比 token 更有用 —— 中转站按模型定价，
   * 光看 token 不知道哪个模型贵。
   */
  const costModels =
    summary.todayCost && summary.todayCost.ok && summary.todayCost.byAppModel
      ? summary.todayCost.byAppModel[activeSource] || null
      : null;
  const costUnit =
    summary.todayCost && summary.todayCost.ok ? summary.todayCost.unit || '￥' : '￥';
  const showCost = activeSource === 'codex' && !!costModels;

  const models = Object.entries(view.byModel || {})
    .map(([m, u]) => ({
      m,
      v: u._tokens != null ? u._tokens : (u.inputTokens || 0) + (u.outputTokens || 0),
      calls: u.calls || 0,
    }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 6);
  const max = models.length ? models[0].v || 1 : 1;

  $('bars').innerHTML =
    models
      .map((x, i) => {
        const w = Math.max(2, Math.round((x.v / max) * 100));
        const color = AGENT_COLORS[i % AGENT_COLORS.length];
        // 该模型今天花的钱（只对 codex 有）
        const c = showCost
          ? costModels[x.m] || findCostModelFallback(costModels, x.m)
          : null;
        const costHtml = showCost
          ? `<span class="bar-cost">${c ? costUnit + fmtMoney(c.cny) : '—'}</span>`
          : '';
        return `<div class="bar-row">
        <span class="bar-label" title="${x.m}">${modelShortName(x.m)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${color}"></span></span>
        <span class="bar-val">${fmtTokens(x.v)}</span>${costHtml}
      </div>`;
      })
      .join('') || '<div class="bar-row"><span class="bar-label">无数据</span></div>';

  // 会话列表
  const rows = view.sessions.slice(0, 5);
  $('sessions').innerHTML =
    rows
      .map((s) => {
        const name = s.project.length > 30 ? '…' + s.project.slice(-29) : s.project;
        const when = s.lastAt
          ? new Date(s.lastAt).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })
          : '--';
        const tag = activeSource === 'all' ? `<span class="sess-tag">${esc(sourceLabel(s.source))}</span>` : '';
        return `<div class="sess-row">
        <span class="sess-name" title="${s.project}">${tag}${name}</span>
        <span class="sess-tok">${fmtTokens(s.tokens)} · ${when}</span>
      </div>`;
      })
      .join('') || '<div class="sess-row"><span class="sess-name">无会话</span></div>';
}

/**
 * 采集失败提示。
 *
 * 瞬时错误不该弹红框 —— CC Switch 写库时 SQLite 会短暂 "database is locked"，
 * 下一次采集（30 秒后）就恢复了。实测启动瞬间弹出一个大红色"采集失败"提示，
 * 把侧边悬浮条整个盖住，非常刺眼。
 *
 * 改成：可恢复类错误（数据库占用等）静默计数，连续失败 3 次才提示；
 * 真正不可恢复的错误（路径不存在、权限问题）立即提示。
 */
let softFailStreak = 0;

function showError(msg) {
  const text = String(msg || '');
  const recoverable = /locked|占用|busy|timeout|ETIMEDOUT|EPERM/i.test(text);

  if (recoverable) {
    softFailStreak += 1;
    // 还没到阈值就静默，等下一次采集自愈
    if (softFailStreak < 3) return;
  } else {
    softFailStreak = 0;
  }

  const el = document.createElement('div');
  el.className = 'err';
  el.textContent = '采集失败：' + msg + (recoverable ? '（将自动重试）' : '');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
  // 采集失败期间拿不到新金额：流光转红（下次成功渲染会按数据自动纠正）
  document.body.dataset.flow = 'bad';
}

/*
 * 胶囊上不再有任何按钮（2026-10-25 设计：悬停只显示环 + 金额）。
 * 刷新 / 隐藏 / 退出走系统托盘菜单与全局热键；设置入口在卡片右上角（⚙）。
 */
$('settingsBtn').addEventListener('click', () => window.hud.openSettings());

// 悬停展开 / 收回。窗口高度必须同步调整，否则面板会被窗口裁掉。
const bar = $('bar');
const panel = $('panel');
let expandTimer = null;
/** 展开/收起是两段时序（淡入↔改窗口），各用一个定时器，互不干扰。 */
let expandTimer2 = null;

/** 当前布局朝向：竖排（侧边停靠）时面板横向展开。 */
let verticalLayout = false;
/** 竖排展开时，竖条宽度之外还要给面板留的内边距（与 CSS 的 --side-thickness 对应）。 */
const SIDE_PAD = 60;

/**
 * 主进程在停靠位置变化时推送布局朝向。
 * 竖排下 body 加 .vertical，CSS 会把悬浮条改写成竖排、面板改为向侧边展开。
 *
 * 另外启动时主动查一次：主进程在 did-finish-load 后才发 layout，但万一时序
 * 变化（或消息在监听器注册前丢失），主动查一次可保证首次渲染就是正确朝向。
 */
function applyLayout(layout) {
  verticalLayout = !!(layout && layout.vertical);
  document.body.classList.toggle('vertical', verticalLayout);
  /*
   * 面板展开方向（由停靠边决定，主进程算好推过来）：
   *   down  → 顶部横条，面板在下方
   *   right → 左侧竖条，面板在竖条右侧（朝屏幕内）
   *   left  → 右侧竖条，面板在竖条左侧
   * 拖动中途翻转朝向时也走这条路径，所以拖到左右边时期望形状与实际落定一致。
   */
  const anchor = (layout && layout.anchor) || 'down';
  document.body.classList.toggle('panel-left', anchor === 'left');
}

if (window.hud && window.hud.onLayout) {
  window.hud.onLayout(applyLayout);
  window.hud.getLayout().then(applyLayout).catch(() => {});
}

/*
 * 展开 / 收起。
 *
 * 动画时序必须和窗口尺寸变化配合，否则"动画"看起来就是跳一下然后被裁掉：
 *
 *   展开：窗口先变大 → 等一帧让新空间可用 → 再加 .open 让面板淡入。
 *         之前是立即加 .open，但窗口 20ms 后才变高，面板在窗口外的部分
 *         被直接裁掉，淡入动画只看到最后一点点。
 *
 *   收起：先移除 .open 让面板淡出（180ms）→ 等淡出结束再缩窗口。
 *         之前是窗口先缩、180ms 后才移除 .open，面板还没淡出就被硬切，
 *         视觉上是"啪"一下消失。
 */
const FADE_MS = 180;

/** 面板是否处于展开态（由 ☰ 按钮点击切换，不是悬停）。 */
let panelOpen = false;

/**
 * 正在进行的拖动（null = 没在按）。
 * 声明放在这里而不是拖动代码旁边：setHovering / applyLayout 更早被调用，
 * `let` 的暂时性死区会让它们撞 ReferenceError。
 */
let drag = null;

/**
 * 悬停：只让胶囊"活起来"——露出统计与按钮（并让环靠左让位）。
 * 不再自动展开面板，避免鼠标扫过就弹出一大块内容（用户明确要求）。
 */
/** 竖条的厚度（与 CSS 的 --side-thickness / 主进程 SIDE_THICKNESS 一致）。 */
const SIDE_THICKNESS = 52;

/**
 * 竖排时的两个高度都随环数走（主进程 SIDE_RUN=130 只够 3 个环，环多了会被裁）。
 *
 * 收起态：上下 padding 8×2 + 边框 1×2 + n×环(30) + (n-1)×间距(10) = 40n + 8。
 * 悬停态：每个 mark 再露出金额行（10px 字 + 3px 间距）→ 40n + 8 + 13n，
 * 外加一点呼吸空间（旧常量 190 = 3 环实算 167 + 23，这里保持同裕量）。
 * 数字必须与 styles.css 的 body.vertical .bar（padding 8 / gap 10 / gap 3）同步改。
 */
function verticalMarkCount() {
  return document.querySelectorAll('#marks .mark').length || 3;
}
function verticalRunHeight() {
  return 40 * verticalMarkCount() + 8;
}
function verticalHoverHeight() {
  const waH = (window.screen && window.screen.availHeight) || 680;
  return Math.min(waH - 16, Math.round(53 * verticalMarkCount() + 30));
}

/**
 * 关闭卡片后的" settle 窗口"：这段时间内忽略 mouseenter 的加宽请求。
 *
 * 为什么需要：点 ✕（或再点胶囊）收起时，主进程 setBounds 把窗口从卡片尺寸
 * 收拢成胶囊，几何一变 Chromium 会重算光标下的元素并**合成 mouseenter**——
 * 实测轨迹（真光标采样）：窗口 500 → 135（收起态，仅 1 帧）→ 264（悬停加宽）。
 * 用户看到的就是"关掉了胶囊却又一瞬间展开"，环多了以后悬停宽度 ≈ 卡片宽度，
 * 更像"关闭没生效"。
 *
 * 只压 true（加宽）：真正的移出（mouseleave → false）不受影响，几何抖动
 * 平息后光标若真在胶囊上，用户轻微移出再移回即可恢复悬停态。
 */
let closeSettleUntil = 0;

function setHovering(next) {
  // 拖动中不响应 hover：主进程此时也不发 hud:hover，这里是 DOM mouseenter 的兜底
  if (drag && drag.armed) return;
  if (next && Date.now() < closeSettleUntil) return;
  /*
   * 展开态（panelOpen）期间**完全不响应 hover** ——
   * 卡片是用 ☰ 点开的，展开后就应该整体维持展开：按钮保持可见（否则
   * 没法点 ✕ 收起）、卡片不收、bar 宽度不动。鼠标移开不应改变任何东西，
   * 一切等用户再点一次 ☰/✕（见 wantExpand）。
   * 之前移开鼠标会移除 hovering → 按钮消失、卡片还在却无法收起，
   * 宽度也停在半吊子状态（用户反馈："hub 自动收起来了但 bar 长度没变"）。
   */
  if (panelOpen) return;

  /*
   * 竖排的关键时序：**先让窗口变尺寸，再让内容变高**。
   *
   * hovering class 一加上，金额行与 ☰/⚙ 立刻出现，内容瞬间长到 213px；
   * 而主进程 win.setBounds 把窗口从 130 拉到 245 是异步的、还晚一帧。
   * 那一帧里内容是 213 而窗口只有 130 —— 实测每轮都能撞到
   * 「越界 41.5px」（用户看到的"显示不全 / 圆环整体上移"）。
   *
   * 所以竖排悬停进入时：先 expand 加高，等窗口到位再加 class；
   * 离开时反过来，先撤 class 让内容变矮，再收窗口。
   */
  if (verticalLayout && window.hud) {
    if (next) {
      window.hud
        .expand(true, SIDE_THICKNESS, verticalHoverHeight(), true)
        .then(() => document.body.classList.add('hovering'))
        .catch(() => document.body.classList.add('hovering'));
    } else {
      document.body.classList.remove('hovering');
      window.hud.expand(false, SIDE_THICKNESS, 130, true).catch(() => {});
    }
    return;
  }

  // 横排：宽度由 measureBar 自适应，没有高度竞态
  document.body.classList.toggle('hovering', !!next);
  measureBar();
}

/** 点击 ☰：真正展开 / 收起详情面板。 */
function wantExpand(next) {
  if (expandTimer) clearTimeout(expandTimer);
  if (expandTimer2) clearTimeout(expandTimer2);

  // 展开面板时必然是悬停态（否则按钮看不见）
  document.body.classList.toggle('hovering', !!next);
  // 面板打开时给 body 打标记：CSS 据此让竖条只占内容高（不撑满 664）
  document.body.classList.toggle('panel-open', !!next);
  if (next) clearPinnedBarWidth();
  panelOpen = !!next;

  if (next) {
    measureBar();
    const dpr = window.devicePixelRatio || 1;
    const screenHDip =
      window.screen && window.screen.availHeight ? window.screen.availHeight / dpr : 680;

    if (verticalLayout) {
      /*
       * 窗口高度按卡片内容收缩（2026-10-25 改版后卡片只有几行 + 图表，
       * 不再撑满整屏留大片空黑）。上限为工作区高度，内容超出才滚动。
       * +16 = 面板上下各 8px 边距（与 CSS 的 top:8 / max-height 配对）。
       */
      const maxH = Math.max(240, screenHDip - 16);
      const panelH = Math.min(maxH, Math.ceil(panel.scrollHeight) + 16);
      window.hud.expand(true, panel.scrollWidth + SIDE_PAD, panelH);
    } else {
      const barH = bar.getBoundingClientRect().height;
      const maxPanelH = Math.max(240, screenHDip - barH - 8 - 24);
      const need = Math.min(maxPanelH, barH + 8 + panel.scrollHeight + 8);
      window.hud.expand(true, need);
    }

    expandTimer = setTimeout(() => {
      panel.classList.add('open');
    }, 32);
    return;
  }

  panel.classList.remove('open');
  // 立刻把胶囊钉在收起宽上：panel-open 已摘、窗口还要淡出 180ms 才收拢，
  // 不钉的话 .bar 退回 width:auto 铺满卡片宽的窗口（见 pinBarToCollapsedWidth 注释）
  pinBarToCollapsedWidth();
  expandTimer = setTimeout(() => {
    /*
     * 先量后收，顺序不能反。
     *
     * measureBar() 只是把测量排队到下一帧（rAF），而 expand(false,0) 是立刻
     * 发出的 —— 主进程处理 expand 时 contentWidth 还停在展开期记下的加宽值
     * （= 卡片宽），窗口就会先按"卡片宽"收一帧，等下一帧测量到了才缩回
     * 胶囊宽，肉眼可见地闪一下（用户反馈："关闭后胶囊一瞬间和卡片一样宽"）。
     *
     * 这里改为同步量出收起态宽度并把 measure IPC 发在 expand 之前：
     * 同一渲染进程的 IPC 保序，主进程先记账 contentWidth=胶囊宽，再收窗口
     * 就一步到位。measureBarNeed 是同步的（内部临时关过渡），量的是终值。
     * 竖排不用这套路（宽度是固定的 SIDE_THICKNESS，measureBar 在竖排本就跳过）。
     */
    if (!drag && !verticalLayout) {
      const need = measureBarNeed();
      if (need && window.hud && window.hud.measure) window.hud.measure(need, false);
    }
    window.hud.expand(false, 0);
    // 收拢几何会合成一次 mouseenter（见 closeSettleUntil 注释），短窗内不许它加宽
    closeSettleUntil = Date.now() + 300;
    // 内联宽度在窗口收拢后清除（一帧余量）：此时窗口=收起宽，width:auto
    // 与钉住值相同，清除不会有任何可见变化
    setTimeout(clearPinnedBarWidth, 80);
  }, FADE_MS);
}

/**
 * 关闭卡片期间把胶囊宽度**钉在收起态内容宽**上。
 *
 * 根因（2026-10-27，真光标 + DOM 采样确认）：点 ✕ 后 panel-open 先摘、
 * 窗口要等 FADE_MS 淡出才收拢，这 180ms 里 .bar 退回 width:auto —— 而
 * 窗口还是卡片宽，胶囊就铺满整个窗口（用户看到的"一瞬间展开和卡片一样宽"）。
 * 不能用 fit-content 兜：收起态的 .marks 是绝对定位（悬停态才回文档流），
 * fit-content 量不到它，会把胶囊底板缩成 18px 的一条。
 * 所以用内联样式显式钉宽 + margin auto 居中，等窗口收拢后清除。
 */
function pinBarToCollapsedWidth() {
  if (verticalLayout) return; // 竖条宽度由 CSS 锁死，无此问题
  const need = measureBarNeed(); // hovering 已摘 → 收起态内容宽
  if (!need) return;
  bar.style.width = need + 'px';
  bar.style.margin = '0 auto';
}

function clearPinnedBarWidth() {
  if (bar.style.width) bar.style.width = '';
  if (bar.style.margin) bar.style.margin = '';
}

/*
 * 只保留 mouseenter 的即时展开，**不再用 DOM 的 mouseleave 收起**。
 *
 * 原因：从胶囊滑到面板时，光标一定会先离开 bar → bar 的 mouseleave 立刻触发
 * → 面板还没滑到就被收起了（用户反馈："准备滑动到详情页时直接又收回去"）。
 * 即使给 mouseleave 加延迟，DOM 事件在窗口失焦后也不再派发，不可靠。
 *
 * 收起统一交给主进程的轮询（见下方 onHover）—— 它按窗口矩形判断，
 * 胶囊和面板都在同一个矩形内，滑过去不会中断。
 */
/*
 * 悬停只切换"悬停态"（露出金额），不再自动展开卡片。
 * 卡片的展开/收起由**左键点击胶囊**控制（见下方 bar click）。
 *
 * mouseleave 必须保留：主进程轮询的 `hovering` 标志初始为 false，
 * 光标从未进入过时它永远不发 hover:false（代码里 `if (!hovering) return`），
 * 只靠轮询会出现「常态卡在悬停态」——启动时 DOM 进了悬停就再也没人取消它。
 * DOM mouseleave 与主进程轮询都调 setHovering，幂等无冲突；
 * 轮询仍然保留，作为窗口失焦后 DOM 事件不再派发时的兜底。
 */
bar.addEventListener('mouseenter', () => setHovering(true));
panel.addEventListener('mouseenter', () => setHovering(true));
bar.addEventListener('mouseleave', () => setHovering(false));
panel.addEventListener('mouseleave', () => setHovering(false));

/*
 * 卡片的开关入口在**胶囊本身**：左键点击展开 / 再点收起。
 *
 * 拖动已改为右键按住（2026-10-25），左键整个腾了出来；胶囊上的按钮组
 * （☰ ⟳ ⚙ ⊖ ✕）也已移除，左键单击不会再与任何按钮冲突。
 * 收起按钮（✕）固定在卡片右上角，与 ⚙ 并排。
 * 拖动中（drag 非空）忽略 click —— 拖动期间任何左键点击都不得把卡片拽出来。
 */
const closeBtn = $('closeBtn');
if (closeBtn) {
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    wantExpand(false);
  });
}
bar.addEventListener('click', () => {
  if (drag) return;
  wantExpand(!panelOpen);
});

/* ============================================================
 * 拖动胶囊改变位置（**右键**按住 → 虚线边框 → 跟手移动 → 松手落盘）
 *
 * 手感对齐原 macOS 项目的 HUDDragWindowController（Notch/Island/），
 * 按键在 2026-10-25 按用户要求从左键改成右键：左键留给普通点击/按钮，
 * 右键只用来搬胶囊，误拖的概率大幅降低。
 *   · 右键按住胶囊，位移 ≥ 6px **或**按住 ≥ 300ms 才算"拿起"——
 *     拿起之前只是普通按下，松开什么也不发生（点按钮照旧）
 *   · 拿起瞬间 body 加 .dragging：胶囊出现虚线边框，光标变抓手
 *   · 移动按增量驱动主进程 setBounds；松手才写盘
 *     （hud:drag-end → config: dock + dockPos[落点]），不逐帧写盘
 *   · 全窗口屏蔽 contextmenu：右键手势不能弹出系统菜单，否则捕获被抢、
 *     pointerup 丢失，dragging 会卡住
 * ============================================================ */
const DRAG_TRAVEL = 6;    // 与原项目 HUDDragView.travel 一致
const DRAG_HOLD_MS = 300; // 与原项目 holdDelay 一致

/** 拖动开始前先收起面板与悬停态：拿起的是胶囊，不是整张卡片。 */
function collapseForDrag() {
  if (expandTimer) clearTimeout(expandTimer);
  if (expandTimer2) clearTimeout(expandTimer2);
  panel.classList.remove('open');
  document.body.classList.remove('panel-open');
  document.body.classList.remove('hovering');
  clearPinnedBarWidth();
  panelOpen = false;
  /*
   * 这里不再重测宽度：收起态宽度由主进程的 collapsedWidth 记着
   * （每次非悬停测量更新），拿起时它直接按那个宽度收窗口。
   * 在拖动路径上现量不可靠——悬停态会量到加宽值，启动初期 .marks
   * 还没渲染会量到 24px（详见 armDrag 注释）。
   */
}

/**
 * 拿起：虚线边框出现，冻结悬停/测量重排，主进程落回收起态胶囊。
 *
 * 收起宽度不用这里量、也不传给主进程：主进程记着 collapsedWidth
 * （最近一次非悬停测量），拖动落回时用它。在这儿现量踩过两次坑——
 * 悬停态量到加宽值（拖着"完全展开"的大胶囊），启动初期 .marks 还没渲染
 * 量到 24px（胶囊被夹成 100px 窄条）。
 */
function armDrag() {
  if (!drag || drag.armed) return;
  drag.armed = true;
  if (drag.timer) {
    clearTimeout(drag.timer);
    drag.timer = null;
  }
  collapseForDrag();
  document.body.classList.add('dragging');
  if (window.hud && window.hud.dragStart) {
    // 带上当前光标绝对位置：主进程记录抓取偏移，此后逐帧"窗口 = 光标 - 偏移"
    window.hud.dragStart(drag.lx, drag.ly).catch(() => {});
  }
}

/** 每帧合并一次增量再发主进程：mousemove 频率高于刷新率，逐事件发会抖。 */
function dragMoveFrame() {
  if (!drag) return;
  const dx = drag.dx;
  const dy = drag.dy;
  drag.dx = 0;
  drag.dy = 0;
  drag.raf = 0;
  if (!drag.armed || (!dx && !dy)) return;
  if (window.hud && window.hud.dragMove) window.hud.dragMove(dx, dy, drag.lx, drag.ly);
}

function onBarPointerDown(e) {
  // 只认右键（2026-10-25 用户要求：左键按住改为右键按住移动）；
  // 按钮（☰ ⟳ ⚙ ⊖ ✕）归按钮，不参与拖动
  if (e.button !== 2) return;
  if (!window.hud || !window.hud.dragStart) return;
  if (e.target && e.target.closest && e.target.closest('.icon-btn')) return;
  // 阻止右键按下可能带出的选区/拖拽默认行为（contextmenu 另在下面统一挡掉）
  if (e.cancelable) e.preventDefault();
  drag = {
    id: e.pointerId,
    sx: e.screenX,
    sy: e.screenY,
    lx: e.screenX,
    ly: e.screenY,
    dx: 0,
    dy: 0,
    armed: false,
    raf: 0,
    timer: null,
  };
  drag.timer = setTimeout(armDrag, DRAG_HOLD_MS);
  // 指针捕获：拖出胶囊（甚至拖出窗口）也持续收到 move/up
  try {
    bar.setPointerCapture(e.pointerId);
  } catch (_) {
    /* 捕获失败时事件照常，只是拖出胶囊边框会断流 */
  }
}

function onBarPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  /*
   * 右键在外面松开时 pointerup 可能收不到（窗口失焦/捕获丢失），
   * 而 dragging 一旦残留就会永久冻结悬停与窗口自适应 —— 用 buttons
   * 位掩码自愈：只要右键已经不在按下状态，就当场收尾。
   */
  if (typeof e.buttons === 'number' && (e.buttons & 2) === 0) {
    endDrag();
    return;
  }
  const dx = e.screenX - drag.lx;
  const dy = e.screenY - drag.ly;
  if (!drag.armed) {
    // 位移不足阈值还是普通按下，不给主进程发任何东西
    if (Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) < DRAG_TRAVEL) return;
    armDrag();
  }
  drag.lx = e.screenX;
  drag.ly = e.screenY;
  drag.dx += dx;
  drag.dy += dy;
  /*
   * 拿起后位移真正超过阈值才算"拖过"：原项目 mouseUp 只在 isDragging 时提交
   * （按住 300ms 拿起但没动就松手 = 仍然是一次点击，不写落点）。
   * 没有这个判断，一次 300ms 以上的慢速单击也会把 dock 改成 free。
   */
  if (Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) >= DRAG_TRAVEL) {
    drag.moved = true;
  }
  if (!drag.raf) drag.raf = requestAnimationFrame(dragMoveFrame);
}

function endDrag(e) {
  if (!drag) {
    // 兜底：拖动对象已销毁时残留的 dragging 类会隐藏面板、锁住 grab 光标
    document.body.classList.remove('dragging');
    return;
  }
  if (e && e.pointerId !== drag.id) return;
  /*
   * 鼠标只有一个 pointerId，所以松开**左**键也会走到这里（拖动期间用户
   * 完全可能顺手点一下左键）。只认右键（button=2）的抬起作为手势结束，
   * pointercancel / blur 例外（它们没有按键语义，必须无条件收尾）。
   */
  if (e && e.type === 'pointerup' && e.button !== 2) return;
  const armed = drag.armed;
  const moved = !!drag.moved;
  if (drag.timer) clearTimeout(drag.timer);
  if (drag.raf) cancelAnimationFrame(drag.raf);
  drag = null;
  document.body.classList.remove('dragging');
  // 没拿起、或拿起后没拖动（慢速单击）都不提交落点；
  // 但拿起过就**必须**通知主进程结束拖动（commit=false 不写盘）——
  // 否则主进程的 dragging 永远是 true，悬停与窗口自适应从此失效（实测）。
  if (armed && window.hud && window.hud.dragEnd) {
    window.hud
      .dragEnd(moved)
      .catch(() => {})
      .then(() => measureBar());
  }
  /*
   * 松手后要重新量宽度（拖动期间禁了测量，朝向也可能刚翻转），但**必须等
   * dragEnd 的回复到达之后再量**：主进程的 hud:measure 有 `if (dragging)
   * return contentWidth` 门禁，而 dragEnd 与 measure 是两条并发 IPC——
   * measure 抢在前面的那一次会被静默丢弃、不会补投。正常时下一次鼠标进出
   * 会重测所以看不出来，可用户松手后把鼠标停在胶囊外就没有任何重测了，
   * 宽度永久停在翻转瞬间的值上（实测症状：拖完变成一条空宽 bar，只有三个环）。
   * 下面这条延时补测兜住"没拿起"与 IPC 异常两种情况。
   */
  setTimeout(() => {
    if (!drag) measureBar();
  }, 320);
}

bar.addEventListener('pointerdown', onBarPointerDown);
bar.addEventListener('pointermove', onBarPointerMove);
bar.addEventListener('pointerup', endDrag);
bar.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => endDrag());
/*
 * 右键是拖动键，所以整个 HUD 窗口都不该弹系统菜单：
 * 菜单一弹就会抢走指针捕获，pointerup 收不到 → dragging 永久残留
 * （悬停轮询与窗口自适应会一起失效）。HUD 里本来也没有需要右键菜单的东西。
 */
document.addEventListener('contextmenu', (e) => e.preventDefault());

/**
 * 主进程轮询光标得出的 hover 通知（唯一可信的"是否还在窗口内"依据）。
 *
 * 主进程用 screen.getCursorScreenPoint() 判断，不受前台焦点影响，
 * 且把胶囊 + 间隙 + 面板当作一个整体区域，鼠标可自由移动。
 *
 * 注意：光标离开时**不直接收起面板** —— 面板是用按钮点开的，应该由用户
 * 再点一次按钮（或光标长时间离开）才收。这里只负责取消悬停态。
 * 若此时面板还开着，保持窗口尺寸不变，等用户主动收起。
 */
if (window.hud && window.hud.onHover) {
  window.hud.onHover((over) => {
    if (over === document.body.classList.contains('hovering')) return;
    setHovering(!!over);
    // 面板开着时不收窗口（用户还在看详情，光标移开只是取消悬停态）
    if (!over && !panelOpen) {
      measureBar();
      window.hud.expand(false, 0);
    }
  });
}

// 启动先拉一次预算（可能在首帧数据到达之前/之后，都无妨：下次渲染就生效）
loadBudget();

// 设置保存后立即刷新预算与圆环布局，不用等重启
if (window.hud && window.hud.onConfigChanged) {
  window.hud.onConfigChanged((cfg) => {
    const n = Number(cfg && cfg.dailyBudgetCny);
    if (Number.isFinite(n) && n > 0) {
      DAILY_BUDGET_CNY = n;
    } else {
      DAILY_BUDGET_CNY = 0; // 0 = 禁用比例弧
    }
    // 圆环集合/顺序变了要立刻重画（主进程随后也会推新数据，但布局是纯展示层状态）
    let ringsChanged = false;
    if (Array.isArray(cfg && cfg.ringLayout) && cfg.ringLayout.length) {
      const next = cfg.ringLayout.filter((k) => RING_DEFS[k]);
      ringsChanged = next.join(',') !== RING_LAYOUT.join(',');
      RING_LAYOUT = next;
    }
    if (ringsChanged && currentSummary) render(currentSummary);
  });
}

window.hud.onData(render);
window.hud.onError(showError);
