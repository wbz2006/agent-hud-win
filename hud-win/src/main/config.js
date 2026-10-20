'use strict';

/**
 * 配置持久化。
 *
 * 存到**可执行文件同级目录**的 `config.json`（exe 旁边，与 Run-AgentHUD.cmd 同级）。
 * 之所以自研而不用 electron-store：这个项目的依赖越少越稳（本机 npm
 * 装包要绕镜像、打包也有安装脚本坑），一个 JSON 文件足够。
 *
 * 写入用「临时文件 + rename」保证原子性：中途断电/崩溃不会留下半个 JSON。
 */

const fs = require('fs');
const path = require('path');

/*
 * 配置路径必须锚定「可执行文件所在目录」，且**不能依赖 electron 模块**。
 *
 * 两个历史坑：
 * ①写死 __dirname 相对路径：打包态落在 asar 包内（只读），settings 保存
 *   写不进去，每次启动都回退默认值 ——「设置里选了左侧，exe 还是顶部横排」。
 * ②改用 require('electron').app.getAppPath()：asar 打包后 appPath 带
 *   `.asar` 后缀，早期正则没匹配到，路径仍落进包内；而且 config.js 还会被
 *   **worker_threads** 加载（sources 解包到 asar 外后，worker.js require
 *   ('../config') 落到真实磁盘），worker 是纯 Node 环境，`require('electron')`
 *   直接抛 Cannot find module 'electron'。
 *
 * 最终方案：用 process.execPath 推导，不碰 electron ——
 *   打包态 execPath = <exe目录>/AgentHUD.exe           → 配置就在 exeDir
 *   开发态 execPath = node_modules/electron/dist/electron.exe
 *                                    → 上两级 = hud-win/
 */
function resolveConfigFile() {
  const execPath = process.execPath || '';
  const exeDir = path.dirname(execPath);

  // 开发态：electron.exe 位于 node_modules/electron/dist/，
  // dist → electron → node_modules → hud-win，共三级
  if (/node_modules[\\/]electron[\\/]dist/i.test(execPath)) {
    return path.join(exeDir, '..', '..', '..', 'config.json');
  }
  // 打包态（含 asar / 非 asar）：exe 同级
  return path.join(exeDir, 'config.json');
}

const CONFIG_FILE = resolveConfigFile();

/** 默认配置。首次启动或文件损坏时用这一份。 */
const DEFAULTS = {
  autostart: false,
  alwaysOnTop: true,
  /**
   * 显示/隐藏全局热键。启动时**常驻显示**，按一次隐藏、再按恢复。
   * 空字符串 = 禁用热键（此时只能从托盘菜单切换）。
   *
   * 默认值说明：本机实测 Ctrl+Alt+H 与 Ctrl+Alt+M 已被其他程序占用
   * （RegisterHotKey 返回 false），Ctrl+Shift+H 可用，故用它做默认。
   */
  toggleHotkey: 'Control+Shift+H',
  /** 启动时是否直接隐藏（默认 false：常驻显示）。 */
  startHidden: false,
  /** 采集间隔（毫秒）。 */
  collectIntervalMs: 30000,
  /** 停靠位置：top / top-left / top-right 为横条；left / right 为贴边竖条。 */
  dock: 'top',
  /**
   * 圆环进度弧的分母：今日预算（人民币）。
   * 弧长 = 今日花费 / dailyBudgetCny。0 或负数视为禁用（弧只显示状态点）。
   */
  dailyBudgetCny: 8,
  /** 圆环显示模式：auto / rate / credit / activity。 */
  ringMode: 'auto',
  /**
   * 【Beta】限流监控总开关 —— **默认关闭**。
   *
   * 从 DSH 会话日志解析上游 soft_rate(429) 报文来判定"某模型是否被限流"。
   * 判定规则尚在验证：上游文案有变动、部分路径不带重置时刻，
   * 误报会把正常可用的模型标红。因此默认关闭，用户可在设置里显式开启。
   * 关闭时整个限流区（圆环标红 / 详情面板限流表）不产出任何数据。
   */
  rateEnabled: false,
  /**
   * 限流宽限（分钟）：上游返回不带重置时刻的限流时，
   * 距最近一次命中多久内仍判为限流中。0 表示不宽限。
   */
  rateGraceMinutes: 5,
  /** 是否监控 OpenCode（该渠道多为 403 渠道禁止）。 */
  rateOpenCode: true,
  /**
   * 【Beta】DSH 免费模型的限流监控。
   *
   * 免费模型（`*-free` 后缀，如 step-5-preview-free / space-bunny-free）
   * 的限流判定未经验证——免费额度与付费额度的限流语义可能不同，
   * 误报会把正常可用的模型标红。因此**默认关闭**，用户可在设置里自行开启。
   * 关闭时，免费模型的限流事件不计入圆环与详情面板。
   */
  betaRateFreeModel: false,
  /** 各数据源开关。 */
  enabledSources: { claude: true, codex: true, dsh: true },
  /**
   * 中转站（CC Switch）金额的计价方式：
   *   'internal' 默认，÷5，与 CC Switch 界面显示的数字一致
   *   'real'     按真实汇率 ¥7.2/$ 折算
   *   'raw'      不换算，直接显示库里的原始值（标 $）
   * 详见 sources/ccswitch.js 的 COST_MODE 注释。
   */
  costMode: 'internal',
  /**
   * 中转站余额（Codex 走中转站时官方额度接口拿不到，改用中转站自己的余额接口）。
   * baseUrl/quotaPath/token/cookie 任一为空 → 不显示余额环；
   * 绝不拿估算值冒充实测余额。
   */
  relay: {
    baseUrl: '',
    quotaPath: '/api/user/self',
    token: '',
    cookie: '',
    balanceField: 'quota',
    usedField: 'used_quota',
  },
};

let cache = null;

/** 读取配置（带默认值合并）。文件不存在或损坏时回退默认值。 */
function load() {
  if (cache) return cache;
  try {
    // 必须剥掉 UTF-8 BOM：PowerShell 的 `Set-Content -Encoding utf8` 会写出
    // 带 BOM 的文件，而 JSON.parse 不接受前导 BOM，会直接抛异常，
    // 导致配置静默回退到默认值（症状：设置"保存"后完全不生效）。
    const text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    cache = {
      ...DEFAULTS,
      ...raw,
      enabledSources: { ...DEFAULTS.enabledSources, ...(raw.enabledSources || {}) },
      relay: { ...DEFAULTS.relay, ...(raw.relay || {}) },
    };
  } catch {
    cache = {
      ...DEFAULTS,
      enabledSources: { ...DEFAULTS.enabledSources },
      relay: { ...DEFAULTS.relay },
    };
  }
  return cache;
}

/**
 * 保存配置。合并进当前值，缺失字段用默认值补齐。
 * @param {object} patch 要修改的字段
 * @returns {object} 保存后的完整配置
 */
function save(patch) {
  const merged = { ...load(), ...(patch || {}) };
  // 过滤未知字段，避免配置里堆积垃圾
  for (const k of Object.keys(merged)) {
    if (!(k in DEFAULTS)) delete merged[k];
  }
  merged.enabledSources = { ...DEFAULTS.enabledSources, ...(merged.enabledSources || {}) };
  merged.relay = { ...DEFAULTS.relay, ...(merged.relay || {}) };

  const tmp = CONFIG_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE); // 原子替换
  } catch {
    // 写失败不致命：内存里的配置仍然有效，下次启动会重试
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
  }
  cache = merged;
  return merged;
}

/** 当前内存中的配置（不触发读盘）。 */
function current() {
  return load();
}

module.exports = { load, save, current, DEFAULTS, CONFIG_FILE };
