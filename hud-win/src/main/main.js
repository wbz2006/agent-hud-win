'use strict';

/**
 * 主进程：创建顶部居中悬浮条窗口 + 定时采集数据。
 *
 * 对应原 macOS 项目的：
 *   AgentHUDDesktop/App/DesktopApplication.swift
 *   AgentHUDDesktop/Notch/Island/IslandWindowController.swift
 *   AgentHUDDesktop/Notch/OverlayPanel.swift
 */

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * 定位 sources 目录（worker 与各采集器的所在地）。
 *
 * 打包后源码被压进 app.asar，而 **worker_threads 无法在 asar 内加载脚本**
 * （new Worker 会抛 `Cannot find module .../app.asar/src/main/sources/worker.js`），
 * 表现为悬浮条上常驻一个红色「采集失败：Cannot…」的提示框。
 *
 * 解决办法是打包时用 --asar-unpack 把 src/main/sources/** 解到 asar 外面，
 * 此时 __dirname 仍指向 asar 内，需要把 app.asar/ 这一段替换掉才能拿到真实路径。
 * 找不到解包目录时退回 __dirname（开发态本就正确）。
 */
function resolveSourcesDir() {
  const inAsar = path.join(__dirname, 'sources');
  // 开发态：直接就是 sources
  if (!inAsar.includes('app.asar')) return inAsar;
  // 打包态：app.asar/src/main → app.asar.unpacked/src/main
  const unpacked = inAsar.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(unpacked) ? unpacked : inAsar;
}

const SOURCES_DIR = resolveSourcesDir();
const { Worker } = require('worker_threads');
const config = require('./config');
/** 自由停靠（拖动）的纯几何计算：不依赖 electron，可单测。 */
const dragGeo = require('./drag');

const IS_DEV = process.argv.includes('--dev');

/**
 * 采集间隔。采集放在 worker 线程里跑（冷启动约 2.7 秒，之后靠缓存只要几十
 * 毫秒），因此这里的间隔不再直接决定主线程开销；默认 30 秒足够让 HUD 保持
 * 新鲜，又避免无谓地反复扫描几百 MB 的会话目录。可在设置里改。
 */
const COLLECT_INTERVAL_MS = config.load().collectIntervalMs || 30000;


/** 悬浮条尺寸（逻辑像素）。 */
const BAR = { width: 420, height: 48 };
/**
 * 横排时的最小/最大宽度：marks 数量不固定，宽度需按内容测量后夹在区间内。
 * 下限必须允许"只有几个环"的收起态（实测 4 个环 = 109px）——
 * 之前设 240 把收起态撑到了 240，看起来比内容宽一大截。
 * 上限要容得下 21 个 mark + 统计区 + 按钮（实测约 1240px）。
 */
/**
 * 横排展开时窗口的最小宽度 —— 必须能放下面板内容。
 *
 * 面板用 .all-models 的 auto-fill 网格，每格最小 210px、列间距 6px：
 *   两列 = 210×2 + 6 = 426
 * 加上 .panel 的左右内边距 14×2 = 28、面板左右各留 8px = 16、窗口边框 2，
 * 合计 472 —— 取 500 留余量。
 * 实测 460 时网格区只有 398px，放不下两列，会退化成单列、文字挤成竖排。
 */
const PANEL_MIN_WIDTH = 500;
const BAR_MIN_WIDTH = 100;
const BAR_MAX_WIDTH = 1240;
/**
 * 悬停展开时的窗口高度上限。
 * 实际高度由渲染进程按内容测量后回报，避免固定高度留下的空白区域
 * 拦截鼠标点击（透明窗口的空白部分仍会挡住下层窗口）。
 */
const EXPANDED_MAX = 900;  // 面板里有 17 个模型的网格，520 只够 6 行；按屏幕空间自适应后需要更大上限
const EXPANDED_MIN = 160;

let win = null;
let timer = null;
let expanded = false;
/** 设置窗口（单例，重复点击 ⚙ 只是聚焦已有窗口）。 */
let settingsWin = null;
/** 系统托盘：悬浮条隐藏后，用户仍需有办法把它叫回来。 */
let tray = null;
/** 当前注册成功的热键（便于重注册与注销）。 */
let registeredHotkey = null;
/** 光标是否停在栏上（主进程轮询得出，驱动渲染层的 hover 态）。 */
let hovering = false;
let hoverTimer = null;
/**
 * 横排时悬浮条的内容宽度（逻辑像素），由渲染层通过 hud:measure 回报。
 * marks 数量随模型数变化，固定宽度会导致内容被拉伸或截断。
 */
let contentWidth = BAR.width;
/**
 * 是否正在被用户按住拖动（自由定位）。
 *
 * 拖动期间主线程只允许 hud:drag-move 改窗口位置：hover 轮询、内容宽度测量、
 * 展开请求全都要让路，否则窗口会被这些"自动重排"拽回锚点，手感是跟手一顿一顿的。
 */
let dragging = false;

/**
 * 侧边停靠时的竖条尺寸：窄边是条厚，长边沿屏幕纵向铺开。
 *
 * 对应原项目 ScreenHUD：`config.edge.isHorizontal
 *   ? CGSize(width: run, height: stripThickness)
 *   : CGSize(width: stripThickness, height: run)`
 * 侧边停靠是竖着的一条，不是横条挪到角落。
 *
 * 长边按内容算：3 个环 ×30 + 2 个间距 ×10 + 上下内边距 ×8 + 边框 ×2 ≈ 130。
 * 之前固定 320 会在下面留出近 200px 空白，胶囊被拉成一条空长条。
 */
const SIDE_THICKNESS = 52;
const SIDE_RUN = 130;
/**
 * 侧边停靠展开时窗口的最小宽度：竖条厚 52 + 缝隙 8 + 面板最小可读宽 420 + 右边距 8。
 * 小于这个值面板会被压窄、文字挤成单列并冒出横向滚动条。
 */
const SIDE_PANEL_MIN_WIDTH = 52 + 8 + 420 + 8;

/**
 * 停靠位置 → 窗口矩形。
 *
 * 竖排（left / right）时窗口是"窄而高"的竖条，贴在屏幕左右边缘、垂直居中；
 * 横排（top）保持横条、顶部居中，宽度取当前内容宽度（marks 数量不固定，
 * 由渲染层回报），这样悬浮条宽度始终贴合内容、不会出现横向拉伸。
 * 几何统一走 dragGeo.dockedRect（拖动吸附与停靠共用同一套矩形算法）。
 */
function dockRect(dock, bounds, currentWidth) {
  return dragGeo.dockedRect(dock, bounds, {
    barW: clampWidth(currentWidth),
    barH: BAR.height,
    sideW: SIDE_THICKNESS,
    runH: SIDE_RUN,
  });
}

/** 把渲染层回报的宽度夹在合理区间内。 */
function clampWidth(w) {
  const n = Math.ceil(Number(w) || BAR.width);
  return Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, n));
}

/** 当前停靠是否为竖排（侧边）。 */
function isVerticalDock(dock) {
  return dock === 'left' || dock === 'right';
}

/**
 * 几何常量包（给 drag.js 的纯函数用）。
 * barW 必须取**当前内容宽度**：marks 数量会变，收起态宽度不是固定值。
 */
function barDims() {
  return {
    barW: clampWidth(contentWidth),
    barH: BAR.height,
    sideW: SIDE_THICKNESS,
    runH: SIDE_RUN,
  };
}

/** 悬浮条所在显示器的可用区域（多屏时跟随窗口，而不是永远锁主屏）。 */
function currentWorkArea() {
  if (win && !win.isDestroyed()) {
    try {
      return screen.getDisplayMatching(win.getBounds()).workArea;
    } catch (_) {
      /* 窗口刚创建时偶发拿不到显示器，退回主屏 */
    }
  }
  return screen.getPrimaryDisplay().workArea;
}

/**
 * 当前布局：停靠边 + 朝向 + 面板展开方向。
 *
 * 胶囊只停靠在三条边上：顶部横条、左侧/右侧竖条。位置由 dockRect() 按屏幕
 * 边缘算出来（拖动松手只是改变 dock，不保留任意坐标）。
 * anchor 决定主进程怎么改窗口矩形，也要推给渲染层让 CSS 换面板方向。
 */
function layoutOf(cfg) {
  const conf = cfg || config.load();
  const dock = config.normalizeDock(conf.dock);
  return {
    dock,
    vertical: isVerticalDock(dock),
    wa: currentWorkArea(),
    dims: barDims(),
    anchor: dragGeo.anchorOf(dock),
  };
}

/** 把朝向 + 展开方向推给渲染层（CSS 据此把面板换到另一侧）。 */
function sendLayout(layout) {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.send('hud:layout', {
    vertical: layout.vertical,
    dock: layout.dock,
    anchor: layout.anchor,
  });
}

/** 按当前配置把悬浮条摆到指定位置（竖排/横排形状不同）。 */
function applyDock() {
  if (!win || win.isDestroyed()) return;
  // 拖动期间位置只由 hud:drag-move 决定 —— 任何重排都会把胶囊拽回原位
  if (dragging) return;

  const layout = layoutOf();
  const r = dockRect(layout.dock, layout.wa, contentWidth);
  if (expanded) {
    // 展开态下只更新位置，不压缩窗口尺寸——否则保存设置时会把已展开的
    // 卡片压回胶囊宽度，而渲染层的 panelOpen 状态未同步，导致 bar 变胶囊
    // 而图标仍停留在三环展开态（点 X 才恢复）。
    const b = win.getBounds();
    win.setBounds({ x: r.x, y: r.y, width: b.width, height: b.height });
  } else {
    win.setBounds(r);
  }
  sendLayout(layout);
}

/**
 * 切换展开态。
 *
 * 横排：向下加高窗口（面板在下方）。
 * 竖排：向屏幕内侧加宽窗口（面板在左/右侧），对应原项目
 *   `.left: return CGRect(x: strip.maxX + gap, ...)` —— 面板总是朝屏幕内展开。
 */
/**
 * 切换展开态。
 *
 * 竖排有两种不同的"变大"，必须区分：
 *   hoverGrow = true  → 悬停态：只加高（给 ☰ 按钮腾位置），宽度保持竖条厚。
 *                       这是鼠标扫过就触发的高频操作，弹大面板会很烦。
 *   hoverGrow = false → 点击 ☰ 的完整展开：加宽到面板宽度 + 加高。
 *
 * 横排不受影响：悬停不展开面板（宽度由 measureBar 自适应），点击才展开。
 */
function setExpanded(next, wantedSize, wantedPanelHeight, hoverGrow) {
  if (!win || win.isDestroyed()) return;
  const layout = layoutOf();
  // 拖动期间窗口尺寸必须钉死：展开/收起会让"拖着的胶囊"忽大忽小
  if (dragging) return;
  const dock = layout.dock;
  const vertical = layout.vertical;
  if (expanded === next && !wantedSize) return;
  expanded = next;

  const b = win.getBounds();
  if (vertical) {
    if (hoverGrow) {
      /*
       * 竖排悬停：宽度不变（仍为竖条厚 52），高度加到容纳按钮。
       * wantedPanelHeight 此时传的是「悬停态总高」（如 185）。
       */
      const h = Math.max(SIDE_RUN, Math.ceil(Number(wantedPanelHeight) || SIDE_RUN));
      const wa = screen.getPrimaryDisplay().workArea;
      const y = Math.max(wa.y, Math.min(wa.y + wa.height - h, Math.round(b.y + b.height / 2 - h / 2)));
      win.setBounds({ x: b.x, y, width: SIDE_THICKNESS, height: h });
      return;
    }

    if (next) {
      /*
       * 完整展开：宽度 = 竖条(52) + 缝隙(8) + 面板宽(≥420) + 右边距(8)。
       * wantedSize 是渲染层给的「面板 scrollWidth + SIDE_PAD(60)」，
       * 但面板在竖排下会被压窄，scrollWidth 可能只有 232，
       * 导致窗口只有 300 宽、面板挤成单列还出横向滚动条。
       * 这里给一个下限，保证面板有足够空间。
       *
       * 高度：wantedPanelHeight 是渲染层按屏幕算的（≈工作区高-16），
       * 但会被 EXPANDED_MAX(900) 截断 —— 1000+ 高的屏幕上面板会缺一截，
       * 看起来"没有完全展开"。上限改为**屏幕工作区高度**本身。
       * y 也要 clamp 在工作区内，避免底部超出屏幕。
       */
      const want = Number(wantedSize) || EXPANDED_MIN;
      const w = Math.max(SIDE_THICKNESS, Math.min(EXPANDED_MAX, Math.ceil(want)), SIDE_PANEL_MIN_WIDTH);
      const wa = screen.getPrimaryDisplay().workArea;
      const panelH = Math.ceil(Number(wantedPanelHeight) || 0);
      const h = Math.max(SIDE_RUN, Math.min(wa.height, panelH));
      const y = Math.max(wa.y, Math.min(wa.y + wa.height - h, Math.round(b.y + b.height / 2 - h / 2)));
      win.setBounds({ x: b.x, y, width: w, height: h });
      return;
    }

    // 收起
    const d2 = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: dock === 'right' ? b.x + b.width - SIDE_THICKNESS : b.x,
      y: Math.round(d2.y + (d2.height - SIDE_RUN) / 2),
      width: SIDE_THICKNESS,
      height: SIDE_RUN,
    });
    return;
  }

  let h = BAR.height;
  let w = contentWidth; // 收起态回到内容宽度，不能用固定 BAR.width（会与动态宽度打架）
  if (next) {
    const want = Number(wantedSize) || EXPANDED_MIN;
    h = Math.max(EXPANDED_MIN, Math.min(EXPANDED_MAX, Math.ceil(want)));
    /*
     * 展开态的宽度必须能装下**面板内容**，不能停在收起态的环宽。
     *
     * 之前写 `w = Math.max(contentWidth, BAR_MIN_WIDTH)`，contentWidth 是收起态
     * 三个环的宽度（201），max(201, 100) 还是 201 —— 宽度根本没变，
     * 面板只能在 201px 里挤成竖排文字、还冒出横向滚动条（用户截图可见）。
     */
    w = Math.max(contentWidth, PANEL_MIN_WIDTH);
  }

  /*
   * 横向要**以原中心为基准左右对称扩展**，不能锁死左边（x: b.x）。
   *
   * 锁左边展开时条形停在原位、只往右长，视觉重心偏右而胶囊看上去偏左
   * （用户截图："整体不在屏幕中间"）。顶部居中停靠时，展开后应仍然居中。
   */
  const oldCenterX = b.x + b.width / 2;
  const x = Math.round(oldCenterX - w / 2);
  win.setBounds({ x, y: b.y, width: w, height: h });
}

/**
 * 光标是否还停在「应当保持展开」的区域内。
 *
 * 为什么用主进程轮询而不是渲染层的 mouseenter/mouseleave：
 * 实测发现窗口失焦后 Chromium 不再派发 mouseleave，导致悬停态卡住收不回来
 * （光标早已移开，窗口仍是 360×66 不缩回 130×44）。
 * screen.getCursorScreenPoint() 是 Electron 原生 API，不受前台焦点影响。
 *
 * 关键：**判定范围就是整个窗口矩形**。
 * 之前只判断顶部 BAR.height 那一截，用户从胶囊往下滑到面板时会有一瞬间
 * 光标落在面板区（不在栏上）→ 判定为离开 → 立即收起 → 面板消失，
 * 根本没法查看内容（用户反馈：「准备滑动到详情页时直接又收回去」）。
 *
 * 收起态窗口本来就只有一个胶囊高，所以两种情况用同一个矩形判断即可。
 * 再留 4px 外扩容差，避免光标正好压在边框线上被判成"在外"。
 */
const HOVER_TOLERANCE = 4;

function cursorInside() {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const t = HOVER_TOLERANCE;
  return (
    p.x >= b.x - t &&
    p.x < b.x + b.width + t &&
    p.y >= b.y - t &&
    p.y < b.y + b.height + t
  );
}

/**
 * 轮询光标，在进出可交互区域时通知渲染层切换 hover 态。
 *
 * 注意：`hovering` 是主进程侧的状态机，初始 false。
 * 光标从未进入过时它一直停在 false，此时若渲染层因其它原因（合成事件、
 * 启动竞态）进了悬停态，主进程不会主动纠偏 —— 那种情况由渲染层的
 * DOM mouseleave 兜底。主进程负责的是「真实光标进出」这条路径。
 *
 * 离开时延迟 RECOLLAPSE_MS 再收：用户从胶囊滑到面板、或在面板内快速移动时，
 * 光标可能一瞬间越过窗口边缘，立刻收起会让面板"闪一下就没了"。
 */
const RECOLLAPSE_MS = 260;
let collapseTimer = null;

function startHoverWatch() {
  if (hoverTimer) clearInterval(hoverTimer);
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    /*
     * 拖动期间不做 hover 判定：窗口跟着光标走，光标当然"永远在里面"，
     * 一旦发 hud:hover 渲染层就会把胶囊从收起态撑到悬停态（露出统计与按钮），
     * 拖动中的胶囊宽度一跳一跳。松手后由下一轮轮询自动恢复。
     */
    if (dragging) return;
    const over = cursorInside();

    if (over) {
      // 回到区域内：取消待执行的收起
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
      if (hovering) return;
      hovering = true;
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('hud:hover', true);
      }
      return;
    }

    // 离开：延迟收起，期间若又回来则取消
    if (!hovering || collapseTimer) return;
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (!win || win.isDestroyed()) return;
      // 延迟结束时再确认一次，避免边缘抖动误收
      if (cursorInside()) return;
      hovering = false;
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('hud:hover', false);
      }
    }, RECOLLAPSE_MS);
  }, 120);
}

/**
 * 设置窗口。
 *
 * 与悬浮条分离成独立窗口：悬浮条是无边框透明置顶，设置需要正常交互
 * （下拉框、输入框、滚动），两者对窗口行为的要求完全相反。
 *
 * 单例：已存在则聚焦，避免重复点 ⚙ 开出多个窗口。
 */
function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  const cfg = config.load();
  settingsWin = new BrowserWindow({
    width: 460,
    height: 560,
    minWidth: 420,
    minHeight: 420,
    resizable: true,
    minimizable: true,
    maximizable: false,
    frame: true,
    transparent: false,
    backgroundColor: '#16161a',
    skipTaskbar: false,
    alwaysOnTop: cfg.alwaysOnTop,
    title: 'Agent HUD 设置',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.setMenuBarVisibility(false);
  if (IS_DEV) settingsWin.webContents.openDevTools({ mode: 'detach' });

  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

/** 采集间隔变化后重建定时器。 */
function restartCollectTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(pushData, config.load().collectIntervalMs || 30000);
}

/**
 * 显示悬浮条（并按配置定位）。
 * 隐藏后再显示时位置可能过期（分辨率变化），所以每次都重新定位。
 */
function showBar() {
  if (!win || win.isDestroyed()) return false;
  applyDock();
  win.show();
  win.focus();
  updateTrayMenu();
  return true;
}

/** 隐藏悬浮条。窗口仍存活，只是不显示。 */
function hideBar() {
  if (!win || win.isDestroyed()) return false;
  win.hide();
  updateTrayMenu();
  return true;
}

/** 热键与托盘共用的显隐切换。 */
function toggleBar() {
  if (!win || win.isDestroyed()) return false;
  if (win.isVisible()) return hideBar();
  return showBar();
}

/** 更新托盘菜单里的"显示/隐藏"文案，使其始终反映当前状态。 */
function updateTrayMenu() {
  if (!tray) return;
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? '隐藏悬浮条' : '显示悬浮条', click: () => toggleBar() },
      { type: 'separator' },
      { label: '设置…', click: () => createSettingsWindow() },
      { label: '立即刷新', click: () => pushData() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
  tray.setToolTip(`Agent HUD${visible ? '' : '（已隐藏）'}`);
}

/**
 * 创建托盘图标。
 *
 * 托盘是必需的而非可选：悬浮条可以隐藏，若没有托盘，隐藏后就再也找不回来。
 * 图标用内嵌的 data URL（一个简化的状态点），避免额外资源文件。
 */
function createTray() {
  if (tray) return tray;
  /*
   * 托盘图标：用 16px 的应用图标（assets/icon-16.png）。
   * 之前是手写 base64 的 16x16 实心方块占位图 —— 深色托盘上几乎看不见，
   * 而且和应用毫无关联。托盘会在 16/24/32 之间自动选尺寸，
   * 这里直接给 16 的最小尺寸文件（体积小、加载快）。
   */
  const iconPath = path.join(__dirname, '..', 'renderer', 'assets', 'icon-16.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL(
    'data:image/png;base64,' +
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAP0lEQVR42u3OMQEAAAgDoJnc6BpjDyQg' +
          'dpRCpU2tIQGKY4pBQAAAAAAAAAAAAAAHwbSjUAADJ0J3cAAAAASUVORK5CYII=',
        'base64'
      ).toString()
  );
  tray = new Tray(icon);
  tray.setToolTip('Agent HUD');
  updateTrayMenu();
  tray.on('click', () => toggleBar());
  return tray;
}

/**
 * 注册显示/隐藏全局热键。
 * 先注销旧的再注册新的（设置项改动后需要重注册）。
 * @returns {{ok: boolean, hotkey: string, error?: string}}
 */
function registerToggleHotkey() {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
  const hotkey = (config.load().toggleHotkey || '').trim();
  if (!hotkey) return { ok: true, hotkey: '' }; // 空 = 禁用

  try {
    const ok = globalShortcut.register(hotkey, () => {
      toggleBar();
    });
    if (ok) {
      registeredHotkey = hotkey;
      return { ok: true, hotkey };
    }
    return { ok: false, hotkey, error: '该快捷键已被其他程序占用' };
  } catch (err) {
    return { ok: false, hotkey, error: String((err && err.message) || err) };
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;

  win = new BrowserWindow({
    width: BAR.width,
    height: BAR.height,
    x: Math.round(x + (width - BAR.width) / 2),
    y: y + 6,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    // 应用图标（任务栏/Alt+Tab/窗口属性里显示，悬浮条本身透明不显示标题栏）
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 布局朝向必须等页面就绪后再发：loadFile 是异步的，提前发的话渲染层的
  // ipcRenderer 监听器还没注册，消息会丢失，竖排布局就切不过来。
  win.webContents.once('did-finish-load', () => applyDock());

  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });

  win.on('closed', () => {
    win = null;
  });
}

/**
 * 采集 worker。
 *
 * 采集是同步重活，放在主进程会冻结窗口消息循环（表现为悬停卡顿、按钮无响应）。
 * 实测：不隔离时每 5 秒阻塞主线程 2.7 秒，占空比 54%。
 */
let worker = null;
let collecting = false;
let lastSummary = null;
/**
 * 各数据源的会话数（每次采集后更新），设置窗口展示用。
 * 形如 { claude: 6, codex: 195, dsh: 23 }
 */
let lastSourceCounts = {};

function startWorker() {
  worker = new Worker(path.join(SOURCES_DIR, 'worker.js'));

  worker.on('message', (msg) => {
    collecting = false;
    /*
     * 采集失败时把完整错误写进 exe 同级的 error.log。
     *
     * 悬浮条只有几十像素宽，红色提示框里的错误文本会被窗口边界裁掉
     * （实测只能看到「采集失败：Cannot」），根本没法定位。
     * 落盘后可以直接读到完整堆栈与消息，排查打包态问题尤其必要
     * （asar / PATH / python 可用性这些差异只有打包后才暴露）。
     */
    if (!msg.ok) {
      try {
        const logPath = path.join(path.dirname(config.CONFIG_FILE), 'error.log');
        const line = `[${new Date().toISOString()}] ${msg.error}\n${msg.stack || ''}\n`;
        fs.appendFileSync(logPath, line, 'utf8');
      } catch (_) {
        /* 日志写不出来就算了，不能因此再抛错 */
      }
    }
    if (!win || win.isDestroyed()) return;

    if (msg.ok) {
      lastSummary = msg.summary;
      // 记录各源会话数，供设置窗口判断该源是否值得开启
      const sc = {};
      for (const [k, v] of Object.entries(msg.summary.bySource || {})) {
        sc[k] = v.sessionCount || 0;
      }
      lastSourceCounts = sc;
      win.webContents.send('hud:data', msg.summary);
      if (IS_DEV) {
        console.log(`[collect] ${msg.elapsedMs}ms  cache=${JSON.stringify(msg.cache)}`);
      }
    } else {
      win.webContents.send('hud:error', msg.error);
    }
  });

  worker.on('error', (err) => {
    collecting = false;
    /*
     * 这条路径是 worker **加载/运行期崩溃**（不是采集逻辑返回 ok:false）。
     * 最常见的原因是 new Worker() 指向了 asar 内的路径 —— worker_threads
     * 不能从 asar 里加载脚本。必须落盘，否则界面上只能看到被裁掉的半行字。
     */
    try {
      const logPath = path.join(path.dirname(config.CONFIG_FILE), 'error.log');
      fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] WORKER CRASH: ${err && err.message}\n` +
          `  SOURCES_DIR=${SOURCES_DIR}\n` +
          `  workerFile=${path.join(SOURCES_DIR, 'worker.js')}\n` +
          `  exists=${fs.existsSync(path.join(SOURCES_DIR, 'worker.js'))}\n` +
          `${(err && err.stack) || ''}\n`,
        'utf8'
      );
    } catch (_) {
      /* ignore */
    }
    if (win && !win.isDestroyed()) win.webContents.send('hud:error', String(err.message || err));
  });

  worker.on('exit', (code) => {
    collecting = false;
    // worker 意外退出时重建，保证 HUD 不会永久停更
    if (code !== 0 && win && !win.isDestroyed()) {
      setTimeout(startWorker, 2000);
    }
  });
}

/** 触发一次采集。上一次还没跑完就跳过，避免堆积。 */
function pushData() {
  if (!worker || collecting) return;
  collecting = true;
  /*
   * 必须把当前配置一起发给 worker。
   *
   * worker 的 runOnce(cfg) 用的是 msg.config，不带就是 undefined ——
   * 于是 cfg.costMode / cfg.rateEnabled / cfg.enabledSources 全部取不到值，
   * 设置里的改动（如「金额计价」切到 real）要等下一次才生效，甚至完全不生效。
   *
   * 以前设置页保存后会 config.save() 再触发采集，但保存的是主进程的 config，
   * 而 worker 里的 costMode 需要显式传进来。这里统一在触发时带上最新配置。
   */
  worker.postMessage({ type: 'collect', config: config.load() });
}

app.whenReady().then(() => {
  createWindow();
  applyDock(); // 按配置里的 dock 定位
  // worker 启动后会立即采集一次并把结果发回，无需额外触发
  startWorker();
  restartCollectTimer();

  // 始终置顶可随时被设置改动，启动时同步一次
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!config.load().alwaysOnTop);

  // 托盘 + 全局热键：常驻显示，按热键隐藏，再按恢复。
  // 托盘是必需的——隐藏后没有它就找不回悬浮条。
  createTray();
  startHoverWatch();
  const hotkeyResult = registerToggleHotkey();
  if (!hotkeyResult.ok) {
    // 热键被占用：立刻通过托盘告知用户，避免"按了没反应"的困惑
    if (tray) {
      tray.displayBalloon
        ? tray.displayBalloon({
            title: 'Agent HUD',
            content: `热键 ${hotkeyResult.hotkey} 注册失败：${hotkeyResult.error}\n可在设置里换一个快捷键，或从托盘菜单切换显示/隐藏。`,
          })
        : null;
    }
    console.warn(`[hotkey] 注册失败: ${hotkeyResult.hotkey} — ${hotkeyResult.error}`);
  } else if (hotkeyResult.hotkey) {
    console.log(`[hotkey] 已注册: ${hotkeyResult.hotkey}`);
  }

  // startHidden = true 时启动即隐藏（默认 false：常驻显示）
  if (config.load().startHidden) {
    if (win && !win.isDestroyed()) win.hide();
    updateTrayMenu();
  }

  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return;
    applyDock();
    setExpanded(false);
  });
});

/**
 * 隐藏时不能真的退出应用：托盘与热键都要继续工作。
 * 因此 window-all-closed 只在用户明确点「退出」时才触发 app.quit()，
 * 这里用 flag 区分。
 */
let reallyQuitting = false;
app.on('before-quit', () => {
  reallyQuitting = true;
});

ipcMain.handle('hud:refresh', () => {
  pushData();
  return true;
});

/** 渲染层请求显隐切换（悬浮条上加一个隐藏按钮也走这里）。 */
ipcMain.handle('hud:toggle', () => toggleBar());

/** 渲染层查询当前是否可见。 */
ipcMain.handle('hud:is-visible', () => !!(win && !win.isDestroyed() && win.isVisible()));

/** 查询热键是否注册成功（设置页展示用）。 */
ipcMain.handle('hud:get-hotkey', () => ({
  registered: !!registeredHotkey,
  hotkey: registeredHotkey || config.load().toggleHotkey || '',
  error: registeredHotkey ? null : '该快捷键已被其他程序占用',
}));

/** 渲染层启动时主动查询当前朝向（兜底，防 layout 消息早于监听器注册）。 */
ipcMain.handle('hud:get-layout', () => {
  const layout = layoutOf();
  return { vertical: layout.vertical, dock: layout.dock, anchor: layout.anchor };
});

/**
 * 渲染层回报悬浮条内容宽度（仅横排使用）。
 * 宽度变化超过 1px 才重新定位，避免每次渲染都抖动。
 *
 * 竖排必须直接忽略：竖条的宽高由 SIDE_THICKNESS / SIDE_RUN 固定，
 * 一旦 applyDock() 被触发就会把窗口强制收回收起尺寸 ——
 * 实测症状是悬停展开时宽 78、高 195 反复横跳，面板根本展不开。
 */
ipcMain.handle('hud:measure', (_e, width) => {
  const layout = layoutOf();
  if (layout.vertical) return SIDE_THICKNESS;
  // 拖动中不接测量值：翻转朝向的瞬间渲染层还按横排量，数值会偏小
  if (dragging) return contentWidth;

  const next = clampWidth(width);
  if (Math.abs(next - contentWidth) > 1) {
    contentWidth = next;
    // 展开态下不重新定位：面板已经占好了位置，再调 applyDock 会把窗口按
    // 收起尺寸重设一次，面板瞬间被裁掉。拖动中更不能动（见 dragging 注释）。
    if (!expanded && !dragging) applyDock();
  }
  return contentWidth;
});

/** 打开设置窗口（单例）。 */
ipcMain.handle('hud:open-settings', () => {
  createSettingsWindow();
  return true;
});

/**
 * 保存设置。主进程统一落盘，并立即应用影响窗口/采集的项：
 *   - alwaysOnTop       → 悬浮条与设置窗口的置顶状态
 *   - dock              → 悬浮条位置（top / left / right）
 *   - collectIntervalMs → 定时器间隔
 *   - enabledSources    → 下次采集生效
 *   - rateGraceMinutes / ringMode / rateOpenCode → 渲染层读取
 */
ipcMain.handle('hud:save-settings', (_e, patch) => {
  const before = config.load();
  const next = { ...(patch || {}) };
  const saved = config.save(next);

  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!saved.alwaysOnTop);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setAlwaysOnTop(!!saved.alwaysOnTop);
  applyDock();
  restartCollectTimer();
  pushData(); // 立刻按新设置刷一次

  // 预算等展示参数可能变了，通知悬浮条重拉配置
  if (win && !win.isDestroyed()) win.webContents.send('hud:config-changed', saved);

  // 热键改了才重注册，避免每次保存都抖一下
  if (before.toggleHotkey !== saved.toggleHotkey) {
    const r = registerToggleHotkey();
    saved.hotkeyStatus = r;
  }
  return saved;
});

/** 开机自启（Electron 的 login item API 跨平台可用）。 */
ipcMain.handle('hud:set-autostart', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});

/**
 * 测试中转站余额接口（设置页「测试连接」按钮）。
 * 用传入的参数而非已保存配置，方便用户在保存前先验证。
 */
ipcMain.handle('hud:test-relay', async (_e, relay) => {
  try {
    const { fetchRelayBalance } = require('./sources/relay');
    return await fetchRelayBalance(relay || {});
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('hud:get-autostart', () => app.getLoginItemSettings().openAtLogin);

/**
 * 渲染进程在鼠标进入/离开悬浮条时调用，用于加高（横排）或加宽+加高（竖排）窗口。
 * wantedHeight 是面板需要的高度（横排=窗口高度；竖排=面板本身的高度）。
 */
ipcMain.handle('hud:expand', (_e, next, wantedHeight, wantedPanelHeight, hoverGrow) => {
  if (dragging) return expanded; // 拖动期间任何展开请求都不改窗口尺寸
  setExpanded(Boolean(next), wantedHeight, wantedPanelHeight, Boolean(hoverGrow));
  return expanded;
});

/**
 * 读取当前配置（设置窗口打开时拉取）。
 * 附带各数据源的会话数，便于用户判断某个源是否真的在用、值不值得开。
 */
ipcMain.handle('hud:get-config', () => {
  return { ...config.load(), sourceCounts: lastSourceCounts };
});

ipcMain.handle('hud:quit', () => {
  reallyQuitting = true;
  app.quit();
  return true;
});

/*
 * ---------- 拖动胶囊（吸附加载） ----------
 *
 * 对应原 macOS 项目的 HUDDragWindowController + ScreenHUD.beginMoving/move/finishMoving：
 * 按住期间只移动窗口、**不写偏好**；松手才提交一次停靠。
 *
 * 本项目胶囊只停靠在三条边（上/左/右），所以拖动做两件事：
 *   1. 跟手移动窗口，夹在光标所在显示器的工作区内；
 *   2. 胶囊中心靠近左右边时**就地翻成竖条**（以中心为基准，不会横漂），
 *      靠近顶部时翻回横条 —— 松手前就能看到最终形状。
 *
 *   hud:drag-start → 落回收起态胶囊矩形，立起 dragging 标志（hover/measure/expand 全部让路）
 *   hud:drag-move  → 增量移动 + 预测吸附边 + 必要时翻转朝向
 *   hud:drag-end   → 写盘 dock=<最近的边>，再按停靠矩形重排一次
 *
 * 用增量而不是绝对光标坐标：窗口本身在动，增量对 DPI 缩放与多屏都是稳的；
 * 渲染层用 e.screenX/screenY（CSS 像素）与主进程的 DIP 坐标同一坐标系。
 */
let dragZone = null;
/** 翻转朝向时窗口矩形的位置变化量；下一条拖动增量里要把它扣掉（见 drag-move）。 */
let morphShift = null;

ipcMain.handle('hud:drag-start', () => {
  if (!win || win.isDestroyed()) return { ok: false };
  const layout = layoutOf();
  dragging = true;
  dragZone = layout.dock;
  morphShift = null;
  hovering = false;
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  // 展开态按住胶囊：先落回收起态，接下来拖的就是胶囊本身而不是整张卡片
  const barRect = dragGeo.barRectFrom(win.getBounds(), layout.vertical, layout.anchor, layout.dims, layout.wa);
  expanded = false;
  win.setBounds(barRect);
  sendLayout(layout);
  return { ok: true, rect: barRect };
});

/** 拖动增量是高频消息（每帧一次），用 send/on 而不是 invoke，避免每帧一个 Promise。 */
ipcMain.on('hud:drag-move', (_e, dx, dy) => {
  if (!dragging || !win || win.isDestroyed()) return;

  let mx = Number(dx) || 0;
  let my = Number(dy) || 0;
  if (morphShift) {
    // 上一条消息里翻转朝向时已经重摆过矩形，这段位移不能再算一遍
    mx -= morphShift.x;
    my -= morphShift.y;
    morphShift = null;
  }

  let b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const p = dragGeo.clampPos(b.x + mx, b.y + my, b.width, b.height, wa);
  if (p.x !== b.x || p.y !== b.y) win.setPosition(p.x, p.y);

  /*
   * 吸附边变了就翻转朝向：横条 ↔ 竖条。
   *
   * 必须**以胶囊中心为基准**重设矩形：窗口宽度从 134 变 52 时若固定左上角，
   * 胶囊会横漂一截；以中心重设后它就在光标底下原地变形。
   *
   * 矩形重摆会让窗口左上角跳一段（中心不变、尺寸变了）。渲染层只看得到
   * 自己的 screenX/screenY，它并不知道这层修正，会把这段位移叠进下一条
   * 增量里 —— 翻转一次就多移一次（竖条越拖越靠外，最后被夹在屏幕边上）。
   * 所以这里把左上角的变化量记下来，下一条增量先扣掉它。
   */
  b = win.getBounds();
  const zone = dragGeo.zoneOf(b, wa);
  if (zone !== dragZone) {
    dragZone = zone;
    const vertical = zone !== 'top';
    const pill = dragGeo.pillRect(b.x + b.width / 2, b.y + b.height / 2, vertical, barDims(), wa);
    morphShift = { x: pill.x - b.x, y: pill.y - b.y };
    win.setBounds(pill);
    sendLayout({ vertical, dock: zone, anchor: dragGeo.anchorOf(zone) });
  }
});

ipcMain.handle('hud:drag-end', () => {
  if (!win || win.isDestroyed()) {
    dragging = false;
    dragZone = null;
    morphShift = null;
    return config.load();
  }
  dragging = false;
  morphShift = null;
  const b = win.getBounds();
  const dock = dragZone || dragGeo.zoneOf(b, screen.getDisplayMatching(b).workArea);
  dragZone = null;
  const saved = config.save({ dock });
  applyDock(); // 吸附到最近的边（居中停靠），顺带把朝向摆正
  return saved;
});

/**
 * 所有窗口都关闭时不退出：悬浮条可能被用户隐藏（win.hide() 不算 closed），
 * 但若它真的被关掉，也要把托盘与热键清掉再退出，避免残留后台进程。
 */
app.on('window-all-closed', () => {
  if (timer) clearInterval(timer);
  if (worker) worker.terminate();
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (reallyQuitting) app.quit();
  // 否则保持托盘常驻（macOS 行为），Windows 上托盘在，无窗口也还在
});

/** 退出前统一清理：注销热键、销毁托盘，避免全局快捷键残留卡住其他软件。 */
app.on('will-quit', () => {
  if (hoverTimer) {
    clearInterval(hoverTimer);
    hoverTimer = null;
  }
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
