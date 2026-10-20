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
  // 金额计价方式（默认 internal：与 CC Switch 界面显示一致）
  $('costMode').value = current.costMode || 'internal';
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
    // 金额计价方式：internal / real / raw
    costMode: $('costMode').value,
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

/**
 * 热键录制。
 *
 * 为什么不让人手打：Electron 的 accelerator 必须是 `Control+Shift+H`
 * 这种精确格式，手打容易写成 Ctrl+H、ctrl+shift+h 之类的变体；
 * 而且用户可能一边打一边触发别的快捷键。
 *
 * 交互：
 *   单击输入框 → 进入录制态（清空 + 高亮 + 提示"请按组合键"）
 *   按下组合键 → 捕获、格式化、退出录制态
 *   按 Esc     → 取消录制，恢复原值
 *   失焦       → 视同取消（避免"录着录着点别处"留下半截状态）
 *
 * 格式转换：浏览器的 event.ctrlKey / keyCode 与 Electron accelerator
 * 的命名不完全一致，这里做一层映射，只输出 Electron 认得的名字。
 */
/*
 * 修饰键的输出顺序固定为 Control → Alt → Shift → Super。
 *
 * 顺序必须稳定，否则同一组合键可能生成 "Shift+Control+H" 和
 * "Control+Shift+H" 两种字符串，Electron 会当成两个不同的热键。
 * 这个次序也是 Electron accelerator 文档里的惯例写法。
 */
const HOTKEY_MODIFIERS = [
  ['ctrlKey', 'Control'],
  ['altKey', 'Alt'],
  ['shiftKey', 'Shift'],
  ['metaKey', 'Super'],
];

/**
 * 把一次 keydown 事件转成 Electron accelerator 字符串。
 * @returns {string|null} 不是有效组合时返回 null
 */
function keyEventToAccelerator(e) {
  // 只按住修饰键本身时不产生完整组合
  const bare = ['Control', 'Shift', 'Alt', 'Meta'];
  if (bare.includes(e.key)) return null;

  const parts = [];
  for (const [prop, name] of HOTKEY_MODIFIERS) {
    if (e[prop]) parts.push(name);
  }
  // 没有修饰键的热键容易与普通输入冲突，且 Electron 也基本不推荐
  if (!parts.length) return null;

  // 主键：优先用 e.code（物理键位，不受输入法/大小写影响）
  const key = normalizeMainKey(e);
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

/** 把主键规范成 Electron 的名字。 */
function normalizeMainKey(e) {
  const code = e.code || '';
  const key = e.key || '';

  // 字母：KeyA → A
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  // 数字：Digit1 → 1
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  // 小键盘：Numpad1 → num1
  m = /^Numpad(\d)$/.exec(code);
  if (m) return 'num' + m[1];
  // 功能键：F1..F24 原样
  m = /^(F\d{1,2})$/.exec(code);
  if (m) return m[1];

  // 特殊键映射（Electron accelerator 的命名）
  const SPECIAL = {
    Space: 'Space',
    Enter: 'Return',
    NumpadEnter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
  };
  if (SPECIAL[code]) return SPECIAL[code];

  // 兜底：单个可打印字符直接用（大写化，保持稳定）
  if (key.length === 1) return key.toUpperCase();
  return null;
}

/** 安装热键录制行为。在 DOM 就绪后调用一次。 */
function setupHotkeyRecorder() {
  const input = $('toggleHotkey');
  const hint = $('hotkeyHint');
  if (!input) return;

  let recording = false;
  let before = '';

  const enter = () => {
    if (recording) return;
    recording = true;
    before = input.value;
    input.value = '';
    input.classList.add('recording');
    input.placeholder = '请按组合键…（Esc 取消）';
    if (hint) {
      hint.textContent = '正在录制：直接按下组合键即可，例如 Ctrl+Alt+H。按 Esc 取消。';
      hint.className = 'hint recording';
    }
  };

  const exit = (restore) => {
    if (!recording) return;
    recording = false;
    input.classList.remove('recording');
    input.placeholder = '单击后按组合键';
    if (restore) input.value = before;
    if (hint) {
      hint.textContent = '单击右侧输入框，然后直接按下你要用的组合键（如 Ctrl+Alt+H）；按 Esc 取消。';
      hint.className = 'hint';
    }
  };

  // 单击开始录制
  input.addEventListener('mousedown', (e) => {
    e.preventDefault(); // 阻止默认的文本选中/聚焦行为
    enter();
    input.focus();
  });
  // 键盘可达性：Tab 聚焦后按 Enter 也能开始
  input.addEventListener('keydown', (e) => {
    if (!recording) {
      if (e.key === 'Enter') {
        e.preventDefault();
        enter();
      }
      return;
    }

    // Esc 取消
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exit(true);
      return;
    }

    // 什么都不按（只按修饰键）时先等，不退出录制
    const acc = keyEventToAccelerator(e);
    if (!acc) {
      // 纯修饰键：阻止默认行为，但不结束录制
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        e.preventDefault();
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    input.value = acc;
    exit(false);
    if (hint) {
      hint.textContent = `已录制：${acc}（点「保存」后生效）`;
      hint.className = 'hint ok';
    }
  });

  // 失焦视同取消，避免留下半截状态
  input.addEventListener('blur', () => exit(true));

  // 阻止在录制态下输入字符（input 本身是 readonly，这里再兜一层）
  input.addEventListener('keypress', (e) => {
    if (recording) e.preventDefault();
  });
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

// 热键录制（单击输入框 → 按组合键 → Esc 取消）
setupHotkeyRecorder();

// Ctrl/Cmd + S 快捷保存
document.addEventListener('keydown', (e) => {
  // 录制热键时不要触发保存 —— 否则想设 Ctrl+S 为热键会直接存盘
  if (document.activeElement && document.activeElement.id === 'toggleHotkey') return;
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
