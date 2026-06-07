'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oneshellDesktop', {
  isDesktop: true,
  getSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('desktop:update-settings', patch),
  openWindow: () => ipcRenderer.invoke('desktop:open-window'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
