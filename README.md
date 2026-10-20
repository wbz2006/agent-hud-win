# Agent HUD for Windows

**中文** · [English](#english)

一条常驻 Windows 悬浮条，实时显示本地 AI agent 的用量、额度与限流状态。
外观复刻 Apple 的设计风格，内核是独立的 Electron 实现。

**纯本地运行，不联网、不上传任何数据。免安装，删掉文件夹即卸载。**

![整体外观](.assets/01-overview.png)

## 下载安装

到 [Releases](https://github.com/wbz2006/agent-hud-win/releases) 下载
`AgentHUD-<版本>-win32-x64.zip`，解压后双击 `Run-AgentHUD.cmd`（或 `AgentHUD.exe`）。

- **免安装**：不写注册表、不装服务，删掉文件夹就算卸载
- **不需要** Node / npm / 任何运行时
- 首次启动托盘出现图标；悬浮条默认屏幕顶部居中，可改为贴左 / 贴右 / 侧边竖排
- 开机自启：设置里勾选「开机自启」

> Windows SmartScreen 可能拦截（未签名应用常见），点「更多信息 → 仍要运行」。
> 每个发布包都带 SHA256，可用 `Get-FileHash` 核对。

## 外观借鉴，而非代码移植

这一点说清楚，避免误解：

- **借鉴的只是外观。** 视觉设计参考了
  [agent-hud-open](https://github.com/jazzenchen/agent-hud-open) 的呈现方式
  （一个环 = 一个 agent、环内嵌品牌图标、状态用颜色区分）。
- **内核完全不同。** 上游是 Swift 6 + SwiftUI / AppKit 的 macOS 原生应用
  （294 个 Swift 文件、约 4 万行）；本项目是 **Electron + 原生 JavaScript** 的独立实现，
  数据层与 UI 均为重写，**没有复用上游任何代码**。
- **而那套外观，本质上是 Apple 的设计语言。**「深色圆角胶囊 + 细环进度 + 毛玻璃」
  属于 Apple HIG 的视觉范式（与 macOS 灵动岛一脉相承），并非上游项目的原创发明。
  本项目是在 Windows 上**复刻这套 Apple 风格**，让 Windows 用户也能获得接近 macOS 的观感。

之所以不叫"移植"：上游的 UI 层 90 文件 / 1.7 万行 **100% 依赖 Apple 专有框架**，
全仓库没有任何 Windows 框架引用 —— 它在 Windows 上根本无法构建，
不存在"把代码移植过来"的可能。

**形态差异**：Windows 没有刘海，所以不用灵动岛，改为
**顶部居中悬浮条**或**屏幕侧边竖条**（设置里可切换）。

![侧边停靠](.assets/03-side-dock.png)

## 交互

- **悬停** —— 悬浮条"活起来"：展开今日金额、露出按钮。不自动弹面板（避免鼠标扫过就弹一大块）。
- **点 ☰** —— 展开详情面板（模型用量、限流、额度、最近会话）。
  展开后**整体维持**：卡片与按钮都不因鼠标移开而收缩，需再点一次 ☰/✕。
- **⚙** —— 设置（按使用频率排序：常用项在前，Beta 与金额计价靠后）。
- **托盘图标** —— 隐藏后可从托盘唤回，也可以在这里退出。
- **全局热键** —— 默认 `Ctrl+Shift+H` 显隐（被占用时设置页会明确提示）。

![详情面板](.assets/04-panel.png)

## 圆环在表达什么

圆环 = **灰色轨道 + 彩色进度弧**，弧长 = 今日花费 ÷ 今日预算（设置项，默认 8 元）。
颜色只看该源的实时状态：

- 🟢 可用 · 🔴 限流中 · ⚪ 无调用

**不编造百分比**：没有可靠额度信号时只画一个状态点（约 1.5%），
零花费就只留圆点，不会为了"看得见"而画一段假弧。

![圆环特写](.assets/02-rings.png)

## 支持的数据源

| 源 | 路径 | 格式 | 用量字段位置 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL / UTF-8 | `type=assistant` → `message.usage` |
| Codex | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | JSONL / UTF-8 | `type=token_usage_record` → `payload.usage` |
| DSH | `~/.dsh/sessions/<项目>/session-*/session.v4.jsonl.zstd` | **zstd + UTF-16LE** | `type=assistant/message` → `data.usage` |

DSH 的会话是 zstd 压缩的多帧文件，且内部是 UTF-16LE 编码 —— 采集时会外部调用 `zstd.exe` 解压。

### 今日花费：读 CC Switch 账本，不是估算

中转站的计费规则不公开（倍率按渠道变化），本地 token 只能估算。
本项目直接读 **CC Switch**（`~/.cc-switch/cc-switch.db`）的 `proxy_request_logs` 表 ——
那是用户自己实际付费的账本，金额是真实计费值。

> **这是强依赖**：没有安装 CC Switch 就没有「今日花费」这一项，
> 其余数据（token / 会话 / 限流）不受影响。
> 为此做了**运行时探测**（自动找数据库 / 表名 / 字段名，不写死）
> 与**优雅降级**（探测失败只把花费显示为"—"并说明原因，不影响其他功能），
> CC Switch 升级改表结构也不需要改代码。

## 从源码构建

```powershell
cd hud-win
npm install
npm start          # 开发运行
npm run pack       # 打包成独立 exe（build/AgentHUD-win32-x64/）
npm run dist       # 打包 + 压成 dist/AgentHUD-<版本>-win32-x64.zip（发版用）
npm test           # 跑测试（探测层 / 降级 / 计价 / 静态防护）
```

打包产物不依赖 Node / npm / 本目录（应用打进 `resources/app.asar`，运行时只读取本地 agent 数据）。

> Windows 下 Electron 二进制直连 GitHub 通常不通，需先设置镜像：
> `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`

### 代码签名（可选）

发布包默认用**自签名证书**签名（`pack.js` 在打包后自动执行）。脚本在 `hud-win/scripts/`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-cert.ps1    # 1. 生成证书（3 年有效期）
powershell -ExecutionPolicy Bypass -File scripts\trust-cert.ps1   # 2. 导入受信任根（需点确认）
npm run pack                                                      # 3. 打包时自动签名
```

- `scripts/get-signtool.ps1` 会自动获取 `signtool.exe`（从 NuGet 拉 21MB，无需装 1GB 的 Windows SDK）
- `.certs/`（含私钥）与 `tools/signtool/` 都在 `.gitignore` 里，不会进仓库
- 撤销信任：`scripts\trust-cert.ps1 -Remove`

**自签名的局限（重要）**：签名只在你导入了证书的机器上被认作 `Valid`。
别人下载后 Windows 仍会提示「未知发布者」—— 要面向陌生用户分发需要
OV/EV 证书或 Azure Trusted Signing。自签名的价值在于：**能验证文件确实来自你**（内容未被篡改）。

## 隐私

**纯本地运行，不联网、不上传。** 所有数据都从本机 agent 的会话文件与 CC Switch 的本地
SQLite 账本读取。唯一的可选网络请求是中转站余额接口 —— 需要你在设置里**显式填写**
Base URL 与 Token 才会发起；不填就完全没有请求。

## 项目结构

```
hud-win/
  src/main/          主进程：悬浮窗、worker 调度、IPC、托盘、设置窗
    sources/         采集层
      ccdb.js          CC Switch 数据库探测（自动找库/表/字段）
      ccswitch.js      中转站账本读取 + 金额计价
      claude-source.js / codex-source.js / dsh-source.js
      ratelimit.js     限流判定（Beta）
      quota.js / relay.js
    config.js        配置持久化（原子写入，零依赖）
  src/renderer/      UI（index.html / styles.css / renderer.js）
    assets/          品牌 logo + 应用图标
  tools/             图标生成脚本
  scripts/           自签名脚本
  test/              单元 + 静态防护测试
  pack.js / dist.js  打包 / 发布
```

采集跑在 `worker_threads` 里（冷启动约 2.7 秒：读 264 MB 文本 + 启动 23 次 zstd），
主线程永不阻塞 —— 这是悬停不卡顿的关键。

## Beta 功能

- **限流监控（整组）** —— 从 DSH 会话日志解析上游 `soft_rate`(429) 报文判定"某模型是否被限流"。
  判定规则仍在验证，误报可能把正常模型标红，因此**默认关闭**，需手动开启。
- **纳入 DSH 免费模型** —— 免费模型（`*-free`）限流语义更不确定，这是前一项的子开关，
  用于只观察付费模型。

## 许可证

Apache-2.0（见 [LICENSE](LICENSE)）。

本项目**不是**上游 `agent-hud-open` 的 fork 或衍生代码 —— 代码为独立实现。
沿用 Apache-2.0 是出于对原项目与 Apple 设计风格参考的尊重；
品牌 logo 素材来自上游的 `Resources/`。

## 致谢

- [jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open) ——
  提供了「一个环 = 一个 agent」的呈现思路与数据源约定，本项目的视觉设计参考了它。
- Apple Human Interface Guidelines —— 本项目复刻的视觉范式（深色圆角胶囊、
  细环进度、毛玻璃）源自其设计语言。

---

<a id="english"></a>

## English

A persistent Windows HUD bar showing your local AI agents' usage, quota and rate-limit status at a glance. Apple-inspired design, built as an independent Electron implementation.

**Runs fully offline. No data leaves your machine. Portable: just delete the folder to uninstall.**

### Install

Download `AgentHUD-<version>-win32-x64.zip` from [Releases](https://github.com/wbz2006/agent-hud-win/releases), unzip, and run `Run-AgentHUD.cmd` (or `AgentHUD.exe`).

No Node, no npm, no runtime required. Every release is signed and ships with a SHA256.

### Credit, not a port

Only the **look** is borrowed from [agent-hud-open](https://github.com/jazzenchen/agent-hud-open) (one ring per agent, brand icon inside, status as color). The **internals are entirely independent** — the upstream is Swift/SwiftUI and cannot build on Windows at all. And that look is really **Apple's design language** (dark rounded capsule, thin progress ring, blur), which this project reproduces on Windows.

### Data sources

Claude Code, Codex and DSH session logs — read locally. Today's cost comes from the **CC Switch** ledger (a real billing record, not an estimate), with runtime schema discovery and graceful degradation so a CC Switch update never breaks the HUD.
