# Agent HUD 在 Windows 上运行的改造方案

> 基准仓库：`jazzenchen/agent-hud-open` @ `faa3a06`
> 本机环境：Windows，Node v24.18.0，无 Swift 工具链、无 pnpm
> 撰写日期：2026-10-14

## 一、结论先说

**当前项目无法在 Windows 上构建或运行，且不存在"配置一下就能跑"的路径。**

原项目是 macOS 原生应用（Swift 6 / SwiftUI / AppKit），即使装了 Swift for Windows 工具链，也只能编译出命令行程序，**编译不了 SwiftUI 与 AppKit**——这两者只在 Apple 平台存在。所以"在 Windows 运行"必然意味着**重写 UI 层**，不是移植。

### 规模实测

| Target | 文件数 | 行数 | 性质 |
|---|---:|---:|---|
| `AgentHUDCore` | 201 | 22,253 | 数据层：17 款 agent 的采集/解析/计费 |
| `AgentHUDDesktop` | 90 | 16,991 | **UI 层：SwiftUI + AppKit，全部需重写** |
| `AgentHUDOpenApp` | 1 | 63 | 入口 |
| `AgentHUDSupport` | 2 | 249 | 工具 |
| **合计** | **294** | **39,556** | |

### 平台耦合分布

`AgentHUDDesktop`（UI 层）的 import 统计：

```
SwiftUI 52 · AppKit 38 · CoreGraphics 5 · QuartzCore 5 · Observation 2
CoreText 1 · Accelerate 1 · AVFoundation 1 · CoreImage 1 · CoreVideo 1
Carbon 1 · ServiceManagement 1 · UniformTypeIdentifiers 2
```

**UI 层 100% 是 Apple 专有框架，没有一行 Windows 代码路径（全仓库含 Windows 框架引用 = 0 个文件）。**

`AgentHUDCore`（数据层）则基本跨平台，平台相关的只有 27 处、集中在少数基础设施文件：

```
Foundation 200（跨平台）
Darwin 10      → posix_spawn / 信号 / 进程组
SQLite3 7      → 读取各 agent 的本地数据库
CryptoKit 3    → 哈希/签名
os / os.log 3  → 日志（Windows 可用 os_log 替代品或直接 print）
Security 2     → 钥匙串读取凭据
CoreServices 2 → FSEvents 文件监听、UTI
Network 2      → 本地网络
Observation 2  → 跨平台（Swift 标准库）
```

**这意味着：数据层可以复用（改造约 27 处），UI 层必须重写（约 1.7 万行）。**

## 二、三条路线对比

### 路线 A：Electron / Tauri 壳 + 重写全部前端（推荐）

用 Node 重写数据采集层，UI 用 Web 技术重做。

- **优点**：Windows 上体验原生；灵动岛形态可用无边框置顶窗口模拟；生态与 DSH 本机环境一致（Node v24 已装）；后续可跨 Win/mac/Linux
- **缺点**：Core 层 2.2 万行 Swift 需重写为 JS/TS。但**其中大部分是各 agent 的数据格式解析逻辑，属于"有明确规范的体力活"**，可按 agent 逐个增量补齐
- **工作量**：壳 + 主 UI 骨架约 3–5 天；每个 agent 采集器 0.5–2 天，按需做
- **建议先做**：Claude Code + Codex 两个主力 agent

### 路线 B：保留 Swift Core，只重写 UI

把 `AgentHUDCore` 编译成 Windows 可用的库，UI 用 WinUI 3 / WPF 重写。

- **优点**：省掉 2.2 万行数据层重写
- **致命问题**：
  1. 本机无 Swift 工具链，需先装 Swift for Windows（约 3–5 GB）
  2. Core 层要用 `#if canImport` 把 Darwin/Security/CoreServices 逐个替换为 Windows 等价物（`windows-rs` 风格调用），**这部分工作量不比重写少**
  3. Swift for Windows 生态冷门，遇到问题几乎无社区支持
- **结论**：**不推荐**。省下的和新增的抵消，还引入了一个高风险工具链依赖

### 路线 C：直接在 Windows 上装 Swift 工具链编译原项目

- **结论**：**不可行**。SwiftUI/AppKit 在 Windows 上不存在，`import SwiftUI` 直接编译失败。UI 层 90 个文件全部无法编译。

## 三、推荐路线 A 的分阶段计划

### 阶段 0：环境与骨架（半天）

- 初始化 `apps/windows-hud`（Electron + Vite + React + TypeScript）
- 无边框、置顶、透明背景窗口，实现"屏幕边缘停靠"的容器
- 确认 `pnpm`（本机未装，需 `npm i -g pnpm` 或直接用 npm）

### 阶段 1：数据层最小闭环（2–3 天）

只做 Claude Code，打通「读取本地会话文件 → 解析 token 用量 → 渲染数字」。

需要移植的逻辑（参考 `AgentHUDCore/Providers/Claude/`）：
- `ClaudeTranscriptParser.swift` — JSONL 逐行解析
- `ClaudeTranscriptStore.swift` — 会话文件定位
- `UsageLedger.swift` — SQLite 账本（Node 用 `better-sqlite3` 或直接文件存储）

Windows 上的路径对应：
```
macOS: ~/.claude/projects/**/*.jsonl
Windows: %USERPROFILE%\.claude\projects\**\*.jsonl
```

### 阶段 2：UI 复刻（3–5 天）

按原项目视觉复刻，优先级：
1. `SimpleMeter` — 简约形态（图标 + 额度圆环），最容易出效果
2. `HoverPanel` — 悬停展开面板（额度、余额、24h token 柱状）
3. `Glow` — 光晕呼吸效果（CSS `filter: blur` + 动画即可，比 Swift 版更简单）
4. `Alerts` — 批准请求/回复提醒卡片

### 阶段 3：扩展 agent（按需，每个 0.5–2 天）

Codex → DeepSeek → 其余。每个 agent 一个采集器模块，注册到 provider 表。

## 四、"灵动岛"在 Windows 上的实现要点

原项目的灵动岛依赖 macOS 的刘海区域（`NSScreen` 的 `auxiliaryTopLeftArea`）与 `NSPanel` 的 `nonactivatingPanel` 行为。Windows 等价物：

| macOS 能力 | Windows 实现 |
|---|---|
| `NSPanel` 悬浮窗 | `BrowserWindow({ frame:false, alwaysOnTop:true, transparent:true, skipTaskbar:true })` |
| `nonactivatingPanel`（点击不抢焦点） | `setIgnoreMouseEvents(true, {forward:true})` + 精确区域恢复 |
| 刘海区域定位 | `screen.getPrimaryDisplay().bounds` 计算顶部居中 |
| `NSScreen` 多屏 | `screen.getAllDisplays()` |
| 毛玻璃 `NSVisualEffectView` | Electron `vibrancy`（Win11 支持 `acrylic`）或 CSS `backdrop-filter` |

**注意**：Windows 没有真正的"刘海"，灵动岛形态只能做成**顶部居中悬浮条**。这是形态上的必然差异，需要你在设计上确认接受。

## 五、待你确认的决策点

1. **接受路线 A（Electron，重写采集层 + 前端）吗？** 还是想先看看路线 B 的可行性验证？
2. **UI 复刻到什么程度？** 完全一致 vs. 只借鉴布局与配色
3. **第一步先做哪个 agent？** 建议 Claude Code
4. **是否接受"顶部居中悬浮条"替代灵动岛形态？**

确认后我立即开始阶段 0。
