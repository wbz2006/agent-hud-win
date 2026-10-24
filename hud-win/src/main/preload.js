'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  onData: (cb) => ipcRenderer.on('hud:data', (_e, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('hud:error', (_e, msg) => cb(msg)),
  /**
   * 停靠位置变化：竖排/横排 + 面板展开方向。
   * anchor = down / up（横排，面板在胶囊下/上方）· right / left（竖排）。
   */
  onLayout: (cb) => ipcRenderer.on('hud:layout', (_e, layout) => cb(layout)),
  /**
   * 光标进出栏的通知（主进程轮询 screen.getCursorScreenPoint 得出）。
   * 不用 CSS :hover / mouseleave —— 窗口失焦后 Chromium 不再派发 mouseleave，
   * 悬停态会永久卡住收不回来（实测：光标移开 5 秒窗口仍是 360×66）。
   */
  onHover: (cb) => ipcRenderer.on('hud:hover', (_e, over) => cb(over)),
  /** 主动查询当前朝向（启动时兜底用）。 */
  getLayout: () => ipcRenderer.invoke('hud:get-layout'),
  /** 读取当前配置（渲染层需要 dailyBudgetCny 等展示参数）。 */
  getConfig: () => ipcRenderer.invoke('hud:get-config'),
  /** 设置保存后的通知（载荷为新配置，渲染层据此刷新预算等展示参数）。 */
  onConfigChanged: (cb) => ipcRenderer.on('hud:config-changed', (_e, cfg) => cb(cfg)),
  /** 回报悬浮条内容宽度（marks 数量变化时窗口宽度需自适应）。 */
  measure: (w) => ipcRenderer.invoke('hud:measure', w),
  refresh: () => ipcRenderer.invoke('hud:refresh'),
  /**
   * 切换展开态。
   * 横排：wantedHeight 是窗口高度（面板在下方）。
   * 竖排：wantedHeight 是窗口宽度、wantedPanelHeight 是高度；
   *       hoverGrow=true 表示「仅悬停加高」（宽度保持竖条厚，给 ☰ 腾位置）。
   */
  expand: (next, wantedHeight, wantedPanelHeight, hoverGrow) =>
    ipcRenderer.invoke('hud:expand', next, wantedHeight, wantedPanelHeight, hoverGrow),
  quit: () => ipcRenderer.invoke('hud:quit'),
  /** 打开设置窗口。 */
  openSettings: () => ipcRenderer.invoke('hud:open-settings'),
  /** 显隐切换（热键/托盘/隐藏按钮共用）。 */
  toggle: () => ipcRenderer.invoke('hud:toggle'),
  /** 当前是否可见。 */
  isVisible: () => ipcRenderer.invoke('hud:is-visible'),
  /** 查询热键注册状态（设置页展示）。 */
  getHotkey: () => ipcRenderer.invoke('hud:get-hotkey'),
  /**
   * 拖动胶囊改变位置（左键按住 → 虚线边框 → 跟手移动 → 松手落盘）。
   * dragStart 让主进程落回收起态并冻结自动重排；dragMove 走增量（每帧一次）；
   * dragEnd 才把 dock='free' + freePos 写进 config.json。
   */
  dragStart: () => ipcRenderer.invoke('hud:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('hud:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.invoke('hud:drag-end'),
});
