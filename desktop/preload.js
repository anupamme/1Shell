'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oneshellDesktop', {
  isDesktop: true,
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('desktop:update-settings', patch),
  openWindow: () => ipcRenderer.invoke('desktop:open-window'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  // 自动更新
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:update-state', handler);
    return () => ipcRenderer.removeListener('desktop:update-state', handler);
  },
});
