# hud-win — Agent HUD for Windows

Windows 版的 Agent HUD：顶部居中悬浮条，展示本地 AI agent 的 token 用量与会话。

改造自 [`jazzenchen/agent-hud-open`](https://github.com/jazzenchen/agent-hud-open)（macOS 原生 Swift 版）。
设计 token（配色、阈值、信息架构）复刻自原项目，实现换成 Electron。

## 设置页面

点悬浮条上的 **⚙ 按钮**打开（在 ⟳ 刷新与 ✕ 退出之间）。设置是独立窗口——悬浮条是无边框透明置顶，设置需要正常交互（下拉框、滚动），两者对窗口行为的要求相反。

可配置项：

| 分组 | 项 | 说明 |
|---|---|---|
| 常规 | 开机自启 | 用 Electron 的 login item API |
| | 采集间隔 | 10 秒 / 30 秒 / 1 分钟 / 5 分钟 |
| | 始终置顶 | 悬浮条与设置窗口同步 |
| | 停靠位置 | 屏幕顶部（居中）/ 顶部靠左 / 顶部靠右 / **屏幕左侧 / 右侧（竖排）** |
| | 今日预算（元） | 圆环进度弧的分母，默认 8 元 |
| 圆环 | 显示内容 | 自动（限流 > 积分 > 活跃度）/ 只限流 / 只积分 / 只活跃度 |
| 数据源 | Claude Code / Codex / DSH | 可单独关闭；右侧显示该源实际会话数，便于判断是否值得开 |
| 限流 | **【Beta】启用限流监控** | 整组是 Beta 功能，**默认关闭**（见下） |
| | 宽限判定 | 上游返回不带重置时刻的限流时，距最近命中多久内仍算限流中（0 / 5 / 15 / 30 分钟）|
| | 监控 OpenCode | 该渠道多为 403 渠道禁止，可关掉减少噪音 |
| | 纳入 DSH 免费模型 | 是否把 `*-free` 模型的限流也算进来 |

### Beta：限流监控（默认关闭）

从 DSH 会话日志里解析上游 `soft_rate`（HTTP 429）报文，把「已限流 / 重置倒计时」
显示在圆环与详情面板里。

判定规则仍在验证：上游文案有变动、部分路径不带重置时刻，
**误报可能把正常可用的模型标红**。因此整组**默认关闭**
（`rateEnabled: false`），用户可在设置里显式开启。

关闭时整个限流区不产出数据 —— 圆环不标红、详情面板显示「暂无频率限制记录」。
`betaRateFreeModel` 是它的子开关，用于只观察付费模型（免费模型限流语义更不确定）。

配置存到 `hud-win/config.json`（原子写入：临时文件 + rename，中途崩溃不会留半个 JSON）。保存后主进程**立即应用**置顶、位置、采集间隔，无需重启。

实现要点：渲染进程不直接写文件——配置影响窗口位置、置顶、定时器，都由主进程统一落盘并应用，避免两端状态不一致。

## 打包成独立 exe

```powershell
cd hud-win
npm install
npm run pack
```

产物在 `build\AgentHUD-win32-x64\`：

- **`AgentHUD.exe`（180 MB）** — 独立可执行程序。**双击即可运行**，不依赖 Node、npm 或本目录（应用代码打进 `resources/app.asar`，运行时只读 `%USERPROFILE%\.claude|\.codex|\.dsh`）。
- **`Run-AgentHUD.cmd`** — 终端启动器。唯一作用：清除 `ELECTRON_RUN_AS_NODE` 后启动 exe。**只有从 Electron 宿主终端（VS Code / DSH）启动时必需**；资源管理器里双击 `AgentHUD.exe` 不受该变量影响。

### 打包时踩到的三个坑

1. **`ELECTRON_RUN_AS_NODE=1` 会让 exe 静默退出**：打包版表现与开发版一致——进程数 0、无任何报错。原因/解法见下文「实现中必须注意的四个坑」。
2. **`.cmd` 文件名不能以 cmd 内置命令开头**：`Start AgentHUD.cmd` 会被解析成内置 `start` + 参数 `AgentHUD.cmd`，实际文件对不上，什么都不执行。重命名为 `Run-AgentHUD.cmd` 解决。
3. **重新打包前必须先停掉旧实例**：`AgentHUD.exe` 运行中被锁，packager 报 `EBUSY: resource busy or locked`。先 `Stop-Process -Name AgentHUD`，或输出到新目录。

## 运行

双击 `start.bat`，或：

```powershell
cd hud-win
npm install
npm start
```

悬浮条出现在主屏顶部居中，可拖动。悬停展开面板；`ALL / CC / CX / DSH` 切换数据源；`⟳` 刷新，`✕` 退出。

## 支持的数据源

| 标记 | 数据源 | 存储位置 | 格式 |
|---|---|---|---|
| `CC` | Claude Code | `%USERPROFILE%\.claude\projects\**\*.jsonl` | JSONL，UTF-8 |
| `CX` | Codex | `%USERPROFILE%\.codex\sessions\<年>\<月>\<日>\rollout-*.jsonl` | JSONL，UTF-8 |
| `DSH` | DSH | `%USERPROFILE%\.dsh\sessions\<项目>\session-*\session.v4.jsonl.zstd` | **zstd + UTF-16 LE** |

三源各自独立采集，单个源失败不影响其它源（面板上该源按钮会标红）。

### 关于中转站

**中转站完全支持。** 用量数据在本地就是完整的，与请求发往官方还是中转站无关。

Codex 会话元数据里的 `model_provider` 字段记录了这一点——本机实测 **195/195 个会话全部为 `custom`**（即走中转站），采集到的 2.26 亿 input token 一个不少。HUD 会把这个字段如实显示在副标题上。

需要说明的是：**额度百分比无法从中转站获取**。官方额度要调 Anthropic/OpenAI 的账号接口，中转站通常不提供该接口。所以 HUD 展示的是**实际用量**（token 数、调用次数、会话数），而不是"剩余额度百分比"。这反而更精确——用量是实测值，额度是估算值。

### 各数据源用量字段

Codex 的粒度最细，单独记录推理 token：

```json
{ "input_tokens": 34310, "cached_input_tokens": 3840,
  "output_tokens": 1582, "reasoning_output_tokens": 77, "total_tokens": 35892 }
```

## 架构

```
src/
  main/
    main.js              主进程：悬浮窗 + 定时采集 + 窗口高度自适应
    preload.js           contextBridge 安全桥
    sources/
      index.js           数据源注册表与统一汇总
      claude-source.js   Claude Code 采集
      codex-source.js    Codex 采集
      dsh-source.js      DSH 采集（zstd + UTF-16）
  renderer/
    index.html            悬浮条 + 悬停面板
    styles.css            配色与动效
    renderer.js           渲染与源切换
```

统一会话形状（各 source 的 `collect()` 都返回这个结构）：

```js
{ source, id, project, cwd, model, provider, lastAt,
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, calls } }
```

## 实测数据（本机）

| 源 | 会话 | input token | output token | 调用次数 |
|---|---:|---:|---:|---:|
| Claude Code | 6 | 116,097,565 | 1,204,941 | 1,993 |
| Codex | 195 | 225,732,690 | 1,520,067 | 2,210 |
| DSH | 23 | 200,445,644 | 4,709,516 | 7,623 |
| **合计** | **224** | **542,275,899** | **7,434,524** | **11,826** |

全量采集耗时约 2.7 秒。

## 免费模型的频率限制（soft_rate）—— 按模型粒度

免费模型（`credits: x0.00`）不消耗积分，但受上游**频率限制**约束。打满后上游返回：

```
429 soft_rate: 您的使用量已超出频率限制，将在 2026-10-15 15:18:20 UTC+8 重置
```

HUD 按**每个模型**展示状态，因为上游对每个模型独立计配额 —— 同一个 `workbuddy` 下，`hy4-preview-f` 可能已限流而 `step-5-preview` 仍可用。按 provider 聚合会漏掉这个细节。

三种状态：

| 状态 | 含义 |
|---|---|
| 🔴 **已限流** | 倒计时到重置时刻（如 `19h6m 后重置`） |
| 🟡 **已恢复** | 曾经限流过、现已重置（附历史命中次数） |
| 🟢 **正常** | 从未触发过限流 |

悬浮条圆环优先级为：**限流状态 > 剩余积分 > 活跃度**。有任何模型被限流时，圆环变红显示 `!`，光晕转红。

### 模型归属怎么定的（关键实现细节）

`llm/retry` 记录**不带 model 字段**，且它自带的 `provider` 字段**不可靠**——实测它会写 `workbuddy-vision`，但当时模型已切到 `workbuddy-ai` 的 `deepseek-v4.1-flash`。

因此 `dsh-source.js` 在**按记录顺序解析时维护"当前模型"**，限流事件就近归属。模型来源按可信度取三种记录：

| 记录类型 | 特征 | 密度（本机实测） |
|---|---|---|
| `assistant/message` | `data.message.source.{provider,model}` | 411/411 = **100%** |
| `request/header` | `data.header.config.{provider,model}` | 仅模型切换时（`reason:"change"`）|
| `model/selection` | `data.{provider,model}` | 仅模型切换时 |

实测归属覆盖率 **472/472 = 100%**。

### 关于"来源"（provider）的两个易混点

HUD 的限流条目会显示来源，看起来像有多套服务，实际只有两个真服务：

**1. `-vision` 后缀不是新服务，是"孪生路由"**

`workbuddy-vision` 由插件 `dsh-vision-router` 创建。该插件给纯文本模型"装上眼睛"，实现方式是为每个 provider 造一条孪生路由：

```js
// dsh-vision-router/index.js
const twinRoute = `${provider}-vision`
```

孪生路由与主路由**共用同一上游账号与配额**，只有一点不同：它能接收图片输入。而且孪生路由只为**支持图片的模型**创建（代码检查 `inputModalities.includes('image')`），所以 `workbuddy-vision` 的模型列表是 `workbuddy` 的子集。

实测证据：`workbuddy / hy4-preview-f` 与 `workbuddy-vision / hy4-preview-f` 共享同一重置时刻 `2026-10-15T07:18:20`。

因此 `ratelimit.js` 在归集时**剥掉 `-vision` 后缀合并显示**（10 条 → 7 条），并给走过图片路由的模型标「含图片」。不合并会让同一模型出现两行、看起来像两份独立配额。

**2. `workbuddy` 与 `workbuddy-ai` 是真的两个服务**

分别对应 WorkBuddy 国内版与国际版，插件 README 明确写「两版的模型、账号和积分互不混用」。这两个**不合并**。

### 为什么不做"剩余额度百分比"

配额模型**无法从本地日志反推**，这是有硬证据的：实测两个同样 24 小时的窗口，一个 **973 次调用**才触发限流，另一个**仅 123 次**就触发。不是简单计次，可能按 token 加权或分池。

因此不编造百分比。能精确拿到的是**重置时刻**（服务端在报错里明确给出），这比估算的百分比更有用——直接知道什么时候恢复。

### 数据从哪来

`dsh-source.js` 从 DSH 会话的 `llm/retry` 记录里解析 `soft_rate` 事件（本机累计 472 条），提取报错文本中的重置时刻。**这是唯一能拿到重置时间的地方**——本地没有任何配额查询接口，插件也只注册了积分路由。

## 额度（剩余积分）

悬浮条的圆环显示**真实剩余积分比例**，悬停面板展开各账号余额与包的明细。

数据来源是 `dsh-workbuddy-connect` 插件注册的只读 HTTP 路由：

```
GET http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/status      # 国内版
GET http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status   # 国际版
```

返回 `credits.total`（剩余积分）与 `credits.accounts[]`（各包的 remain/size）。这是上游计费接口的实时结果，**不是估算**。

三个约束：

- **DSH 必须正在运行** —— 路由由插件在宿主内注册，DSH 退出则连接被拒。此时面板如实显示原因，不假装有数字。
- **不要伪造 Host / Origin 头** —— 插件用它们防 DNS rebinding，伪造会被 403。默认 `fetch()` 即可通过。
- **`.workbuddy-catalog.json` 里的 `"credits":"x0.79 credits"` 是单价倍率，不是余额** —— 只能用来换算本地消耗，当额度用会得出完全错误的数字。余额从不落盘，只能走 HTTP。

面板下方另有「今日本地消耗」：按 provider 聚合调用次数与 token，用于判断今天烧得快不快。倍率未知的 provider 明确标注「倍率未知」，不编造积分。

## 性能设计（重要）

采集是同步重活（三源合计：读 264 MB Codex 文本 + 启动 23 次外部 zstd 进程）。若放在主进程里，会**冻结窗口消息循环**，表现为悬停卡死、按钮无响应。

实测（修复前）：单次采集 2700 ms、每 5 秒一次 ⇒ 主线程占空比 **54%**，采集期间定时器采样 **0 次**（完全冻死）。

两层防护：

1. **worker 线程**（`src/main/sources/worker.js`）——采集全部在 `worker_threads` 里执行，主线程只收结果。修复后主线程定时器采样 **151 次**，最大抖动 **20 ms**。
2. **指纹缓存**（`src/main/sources/cache.js`）——按 `路径:mtimeMs:size` 缓存解析结果，文件未变更就跳过读取与解压。冷 2598 ms → 热 **38 ms（68 倍）**。

采集间隔 `COLLECT_INTERVAL_MS = 30000`（30 秒）。附加收益：主进程内存 240 MB → 90 MB。

## 实现中必须注意的四个坑

1. **`ELECTRON_RUN_AS_NODE`**：从 Electron 宿主终端（VS Code / DSH）启动时该变量会被继承，导致 Electron 退化为纯 Node，报 `Cannot read properties of undefined (reading 'whenReady')`。`start.bat` 已清除它。
2. **`.bat` 必须 ASCII-only**：中文注释在 GBK 代码页下会被当作命令执行。
3. **必须显式传应用路径**：`electron.exe .` —— Electron **不会**自己读当前目录的 `package.json`，不传路径会起一个标题为 `Electron` 的空窗口。
4. **`.bat` 里不要用 `cmd` 的 `start` 启动**：`start "" "electron.exe" "."` 会把空引号当成窗口标题、argv 整体错位，结果是 Electron 打印 usage 横幅而不启动应用。直接调用 exe 即可。
3. **DSH 的双层格式**：文件是 zstd 压缩，且解压后是 **UTF-16 LE**（BOM `ff fe`）。
   - Node 的 `zlib.zstdDecompressSync` 对该多帧文件只解出第一帧（实测 478 KB 只解出 210 字节），Electron 内置的 Node 20 更是没有 zstd API。因此 `dsh-source.js` 调用外部 `zstd` 可执行文件。
   - 用 `utf8` 读会得到满屏 `\x00` 交错的乱码，必须用 `utf16le`。

## 与原 macOS 版的对应关系

| 原项目（Swift） | 本项目（JS） |
|---|---|
| `NSPanel` 悬浮窗 | `BrowserWindow` 无边框透明置顶 |
| 灵动岛（刘海区域） | 顶部居中悬浮条（Windows 无刘海） |
| `NSVisualEffectView` 毛玻璃 | CSS `backdrop-filter` |
| `GlowRenderer`（CoreGraphics） | CSS `radial-gradient` + `blur()` |
| `StatusPalette` 色值 | CSS 变量，1:1 复刻 |
| `CodexTranscripts.swift` | `sources/codex-source.js` |

## 待办

- [ ] SQLite 账本做历史趋势（原项目有 `Ledger/`）
- [ ] 开机自启与系统托盘
- [ ] 多显示器支持
- [ ] 额度告警卡片
- [ ] 其余 14 款 agent 的数据源
