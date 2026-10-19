# Agent HUD for Windows

把 macOS 原生的 [agent-hud-open](https://github.com/jazzenchen/agent-hud-open) 移植到 Windows：
一条常驻悬浮条，实时显示本地 AI agent 的用量、额度与限流状态。

**纯本地运行，不联网、不上传任何数据。**

```
  ╭─────────────────────────────────────╮
  │  ◕ ◔ ◑   1.2M tok · 42 会话 · ¥3.20  │   ← 悬浮条
  ╰─────────────────────────────────────╯
        ☰  ⟳  ⚙  ⊖  ✕                      ← 悬停露出按钮
  ┌───────────────────────────────────┐
  │ 全部模型（24H 调用量）              │   ← 点 ☰ 展开详情
  │ gpt-6.1-sol        ███████░░  1284 │
  │ claude-opus-4      █████░░░░   842 │
  │ ...                                │
  └───────────────────────────────────┘
```

## 下载安装

到 [Releases](https://github.com/wbz2006/agent-hud-win/releases) 下载
`AgentHUD-<版本>-win32-x64.zip`，解压后双击 `Run-AgentHUD.cmd`（或 `AgentHUD.exe`）即可。

- **免安装**：不写注册表、不装服务，删掉文件夹就算卸载
- **不需要** Node / npm / 任何运行时
- 首次启动会在托盘出现图标；悬浮条默认在屏幕顶部居中，可在设置里改成贴左/贴右/侧边竖排
- 想开机自启：设置里勾选「开机自启」

> 如果 Windows SmartScreen 拦截（未签名应用常见），点「更多信息 → 仍要运行」。

## 为什么是移植而不是直接跑

上游是 Swift 6 + SwiftUI / AppKit 编写的 macOS 原生应用（294 个 Swift 文件、约 4 万行），
其中 UI 层 `AgentHUDDesktop`（90 文件 / 1.7 万行）**100% 依赖 Apple 专有框架**，
全仓库没有任何 Windows 框架引用 —— 在 Windows 上无法构建。

因此本项目沿用上游的**设计 token**（配色、阈值、信息架构）与**数据源约定**，
实现改为 **Electron + Web 技术**：数据层用 JS 重写，UI 用 HTML/CSS 复刻。
形态上以「顶部居中悬浮条 / 屏幕侧边竖条」替代 macOS 的灵动岛（Windows 没有刘海，这是必然差异）。

## 支持的数据源

| 源 | 路径 | 格式 | 用量字段位置 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | JSONL / UTF-8 | `type=assistant` → `message.usage` |
| Codex | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | JSONL / UTF-8 | `type=token_usage_record` → `payload.usage` |
| DSH | `~/.dsh/sessions/<项目>/session-*/session.v4.jsonl.zstd` | **zstd + UTF-16LE** | `type=assistant/message` → `data.usage` |

DSH 的会话是 zstd 压缩的多帧文件，且内部是 UTF-16LE 编码 —— 采集时会外部调用 `zstd.exe` 解压。

## 从源码构建

```powershell
cd hud-win
npm install
npm start          # 开发运行
npm run pack       # 打包成独立 exe（build/AgentHUD-win32-x64/）
npm run dist       # 打包 + 压成 dist/AgentHUD-<版本>-win32-x64.zip（发版用）
```

打包产物不依赖 Node / npm / 本目录（应用打进 `resources/app.asar`，运行时只读取本地 agent 数据）。

> Windows 下 Electron 二进制直连 GitHub 通常不通，需先设置镜像：
> `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`

## 交互

- **悬停** —— 悬浮条"活起来"：展开今日金额、露出按钮。不自动弹面板（避免鼠标扫过就弹一大块）。
- **点 ☰** —— 展开详情面板（模型用量、限流、额度、最近会话）。
  展开后**整体维持**：卡片与按钮都不因鼠标移开而收缩，需再点一次 ☰/✕。
- **⚙** —— 设置（停靠位置、采集间隔、预算、限流开关、数据源开关、Beta 功能）。
- **托盘图标** —— 隐藏后可从托盘唤回；也可以在这里退出。
- **全局热键** —— 默认 `Ctrl+Shift+H` 显隐（被占用时设置页会明确提示）。

## 圆环在表达什么

圆环 = **灰色轨道 + 彩色进度弧**，弧长 = 今日花费 ÷ 今日预算（设置项，默认 8 元）。
颜色只看该源的实时状态：

- 🟢 可用 · 🔴 限流中 · ⚪ 无调用

**不编造百分比**：没有可靠额度信号时只画一个状态点（约 1.5%），
零花费就只留圆点，不会为了"看得见"而画一段假弧。

## 隐私

**纯本地运行，不联网、不上传。** 所有数据都从本机 agent 的会话文件与 CC Switch 的本地
SQLite 账本读取。唯一的可选网络请求是中转站余额接口 —— 需要你在设置里**显式填写**
Base URL 与 Token 才会发起；不填就完全没有请求。

## 项目结构

```
hud-win/
  src/main/          主进程：悬浮窗、worker 调度、IPC、托盘、设置窗
    sources/         采集层（三个数据源 + 限流 + 额度 + 中转站 + CC Switch）
    config.js        配置持久化（原子写入，零依赖）
  src/renderer/      UI（index.html / styles.css / renderer.js）
    assets/          品牌 logo + 应用图标
  pack.js            打包脚本
```

采集跑在 `worker_threads` 里（冷启动约 2.7 秒：读 264 MB 文本 + 启动 23 次 zstd），
主线程永不阻塞 —— 这是悬停不卡顿的关键。

## Beta 功能

- **DSH 免费模型限流监控** —— 免费模型（`*-free`）的限流语义未经验证，
  默认关闭，可在设置中开启帮忙验证。

## 许可证

Apache-2.0（见 [LICENSE](LICENSE)）。本项目是上游 `agent-hud-open` 的衍生作品，
沿用相同许可证并保留原归属声明；品牌 logo 来自上游 Resources。

## 致谢

感谢 [jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open)
提供的设计与数据源约定 —— 本项目是在其基础上的 Windows 移植。
