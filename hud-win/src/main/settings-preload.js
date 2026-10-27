'use strict';

/**
 * 设置窗口的 contextBridge 桥。
 *
 * 只暴露配置读写与自启控制，不暴露 ipcRenderer 本身 —— 设置窗口需要处理
 * 用户输入，收窄接口面更稳妥。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hudSettings', {
  /** 读取当前配置（含默认值合并）。 */
  get: () => ipcRenderer.invoke('hud:get-config'),
  /** 各环数据监测状态（会话数 / CC Switch 账本按 app 的今日请求与金额）。 */
  getDataStats: () => ipcRenderer.invoke('hud:get-data-stats'),
  /** 保存配置，返回保存后的完整配置。 */
  save: (patch) => ipcRenderer.invoke('hud:save-settings', patch),
  /** 开机自启开关。 */
  setAutostart: (on) => ipcRenderer.invoke('hud:set-autostart', on),
  getAutostart: () => ipcRenderer.invoke('hud:get-autostart'),
  /** 热键注册状态：{ registered, hotkey, error }，用于明确告知"被占用"而非静默失败。 */
  getHotkey: () => ipcRenderer.invoke('hud:get-hotkey'),
  /** 测试中转站余额接口（用传入参数，不读已保存配置）。 */
  testRelay: (relay) => ipcRenderer.invoke('hud:test-relay', relay),
});
