'use strict';

/**
 * 设置窗口渲染进程。
 *
 * 配置由主进程持有并持久化（hud-win/config.json，electron-store 之外的自研
 * 极简实现见 main.js 的 loadConfig/saveConfig），这里只负责：
 *   ① 打开时拉取当前配置并回填控件
 *   ② 保存时把值交给主进程，由主进程决定是否立即生效
 *
 * 之所以不让渲染进程直接写文件：配置影响窗口位置、置顶、采集间隔等
 * 主进程状态，集中在主进程落地可避免两端状态不一致。
 */

const $ = (id) => document.getElementById(id);

/** 从预加载桥拿到的配置读写接口。 */
const store = window.hudSettings;

let current = null;

/** 数据源的中文名（与主进程 SOURCES 的 label 一致）。 */
const SOURCE_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 把配置对象回填到控件。 */
function fill(cfg) {
  current = cfg || {};

  $('autostart').checked = !!current.autostart;
  $('alwaysOnTop').checked = !!current.alwaysOnTop;
  $('toggleHotkey').value = current.toggleHotkey || '';

  $('interval').value = String(current.collectIntervalMs || 30000);
  $('dock').value = current.dock || 'top';
  $('ringMode').value = current.ringMode || 'auto';
  // 今日预算（圆环分母），空值显示占位提示
  $('dailyBudget').value =
    current.dailyBudgetCny != null && current.dailyBudgetCny > 0 ? String(current.dailyBudgetCny) : '';

  $('rateEnabled').checked = !!current.rateEnabled;
  $('rateGrace').value = String(current.rateGraceMinutes != null ? current.rateGraceMinutes : 5);
  $('rateOpenCode').checked = !!current.rateOpenCode;
  // 【Beta】免费模型限流监控，默认关闭
  $('betaRateFreeModel').checked = !!current.betaRateFreeModel;

  // 中转站余额
  const relay = current.relay || {};
  $('relayBaseUrl').value = relay.baseUrl || '';
  $('relayQuotaPath').value = relay.quotaPath || '/api/user/self';
  $('relayToken').value = relay.token || '';
  $('relayBalanceField').value = relay.balanceField || 'quota';
  $('relayUsedField').value = relay.usedField || 'used_quota';

  // 数据源开关（含每源的会话数，便于判断该源是否真的有用）
  const enabled = current.enabledSources || { claude: true, codex: true, dsh: true };
  const counts = current.sourceCounts || {};
  $('sourceList').innerHTML = Object.keys(SOURCE_LABELS)
    .map((k) => {
      const n = counts[k];
      const cnt = typeof n === 'number' ? `${n} 个会话` : '未采集';
      return `<label class="src-row">
      <input type="checkbox" data-src="${k}" ${enabled[k] ? 'checked' : ''} />
      <span class="src-name">${esc(SOURCE_LABELS[k])}</span>
      <span class="src-count">${cnt}</span>
    </label>`;
    })
    .join('');
}

/** 从控件读出配置对象。 */
function read() {
  const enabled = {};
  document.querySelectorAll('#sourceList input[type="checkbox"]').forEach((el) => {
    enabled[el.dataset.src] = el.checked;
  });
  return {
    autostart: $('autostart').checked,
    alwaysOnTop: $('alwaysOnTop').checked,
    toggleHotkey: $('toggleHotkey').value.trim(),
    collectIntervalMs: Number($('interval').value) || 30000,
    dock: $('dock').value,
    ringMode: $('ringMode').value,
    // 预算：留空/0 表示禁用比例弧，存 0
    dailyBudgetCny: (() => {
      const n = Number($('dailyBudget').value);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })(),
    rateEnabled: $('rateEnabled').checked,
    rateGraceMinutes: Number($('rateGrace').value),
    rateOpenCode: $('rateOpenCode').checked,
    // 【Beta】免费模型限流监控（默认关闭，用户显式开启才存 true）
    betaRateFreeModel: $('betaRateFreeModel').checked,
    enabledSources: enabled,
    relay: {
      baseUrl: $('relayBaseUrl').value.trim(),
      quotaPath: $('relayQuotaPath').value.trim() || '/api/user/self',
      token: $('relayToken').value.trim(),
      cookie: '',
      balanceField: $('relayBalanceField').value.trim() || 'quota',
      usedField: $('relayUsedField').value.trim() || 'used_quota',
    },
  };
}

/** 展示中转站余额接口的测试结果。 */
function showRelayStatus(res) {
  const el = $('relayStatus');
  if (!el) return;
  if (!res) {
    el.textContent = '';
    el.className = 'hint';
    return;
  }
  if (res.ok) {
    const pct = res.ratio != null ? Math.round(res.ratio * 100) + '%' : '—';
    el.textContent = `连接成功：剩余 ${res.remain != null ? res.remain.toFixed(2) : '?'}（${pct}）`;
    el.className = 'hint ok';
  } else {
    el.textContent = `失败：${res.error || '未知错误'}`;
    el.className = 'hint bad';
  }
}

/** 测试中转站余额接口（用当前输入框里的值，不落盘）。 */
async function testRelay() {
  const el = $('relayStatus');
  if (el) {
    el.textContent = '测试中…';
    el.className = 'hint';
  }
  try {
    const res = await store.testRelay({
      baseUrl: $('relayBaseUrl').value.trim(),
      quotaPath: $('relayQuotaPath').value.trim() || '/api/user/self',
      token: $('relayToken').value.trim(),
      cookie: '',
      balanceField: $('relayBalanceField').value.trim() || 'quota',
      usedField: $('relayUsedField').value.trim() || 'used_quota',
    });
    showRelayStatus(res);
  } catch (err) {
    showRelayStatus({ ok: false, error: String((err && err.message) || err) });
  }
}

/** 展示热键注册状态（被其他程序占用时明确告知，避免"按了没反应"）。 */
function showHotkeyStatus(status) {
  const el = $('hotkeyStatus');
  if (!el) return;
  if (!status || !status.hotkey) {
    el.textContent = '';
    el.className = 'hint';
    return;
  }
  if (status.registered) {
    el.textContent = `已注册：${status.hotkey}`;
    el.className = 'hint ok';
  } else {
    el.textContent = `注册失败：${status.hotkey} —— ${status.error || '该快捷键已被其他程序占用'}`;
    el.className = 'hint bad';
  }
}

function setStatus(msg) {
  $('status').textContent = msg || '';
  if (msg) setTimeout(() => {
    if ($('status').textContent === msg) $('status').textContent = '';
  }, 3000);
}

/*
 * 保存。
 *
 * 保存成功后**自动关闭窗口**（留 400ms 让"已保存"一闪而过再关，
 * 否则用户会怀疑"到底存上没有"）。失败时保持打开并展示错误 ——
 * 配置没落盘就把窗口关掉是最糟的体验。
 */
let closing = false;

async function save() {
  if (closing) return;
  setStatus('保存中…');
  try {
    const saved = await store.save(read());
    // 主进程只在热键变化时重注册，返回里才带 hotkeyStatus
    if (saved && saved.hotkeyStatus) showHotkeyStatus(saved.hotkeyStatus);
    else if (store.getHotkey) store.getHotkey().then(showHotkeyStatus).catch(() => {});
    setStatus('已保存');
    closing = true;
    setTimeout(() => window.close(), 400);
  } catch (err) {
    setStatus('保存失败：' + String((err && err.message) || err));
  }
}

// 事件绑定
$('saveBtn').addEventListener('click', save);
$('cancelBtn').addEventListener('click', () => window.close());
$('closeBtn').addEventListener('click', () => window.close());
$('relayTestBtn').addEventListener('click', testRelay);

// Ctrl/Cmd + S 快捷保存
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

// 打开时拉取配置，并顺带查一次热键注册状态
store.get().then(fill).catch((err) => setStatus('读取配置失败：' + String((err && err.message) || err)));
if (store.getHotkey) {
  store.getHotkey().then(showHotkeyStatus).catch(() => {});
}
