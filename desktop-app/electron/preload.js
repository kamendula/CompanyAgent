'use strict';
/**
 * Preload：渲染进程唯一可见的本机能力入口。
 * 只暴露下面列出的具体函数，不暴露 ipcRenderer/Node/fs 本身，
 * 避免渲染层（将来若加载第三方/不可信内容）获得超出需要的权限。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 拖拽文件：Electron 33 起不再暴露 File.path，必须用 webUtils 解析
  getPathForFile: (file) => webUtils.getPathForFile(file),

  selectExcelFile: () => ipcRenderer.invoke('fs:selectExcelFile'),
  parseExcel: (filePath) => ipcRenderer.invoke('fs:parseExcel', filePath),
  openPath: (targetPath) => ipcRenderer.invoke('fs:openPath', targetPath),

  selectAuthorizedFolder: (purpose) => ipcRenderer.invoke('fs:selectAuthorizedFolder', purpose),
  listAuthorizedFolders: () => ipcRenderer.invoke('fs:listAuthorizedFolders'),
  revokeAuthorizedFolder: (folderPath) => ipcRenderer.invoke('fs:revokeAuthorizedFolder', folderPath),

  getConnectionState: () => ipcRenderer.invoke('server:getConnectionState'),
  setOnlineState: (online) => ipcRenderer.invoke('server:setOnlineState', online),
  setCostSourceAvailable: (available) => ipcRenderer.invoke('server:setCostSourceAvailable', available),

  createQuoteDraft: (payload) => ipcRenderer.invoke('server:createQuoteDraft', payload),
  calculateForQuote: (payload) => ipcRenderer.invoke('server:calculateForQuote', payload),
  submitForApproval: (payload) => ipcRenderer.invoke('server:submitForApproval', payload),
  decideApproval: (payload) => ipcRenderer.invoke('server:decideApproval', payload),
  exportAndArchive: (payload) => ipcRenderer.invoke('server:exportAndArchive', payload),
  listQuotes: (role) => ipcRenderer.invoke('server:listQuotes', role),
  getQuote: (quoteId, role) => ipcRenderer.invoke('server:getQuote', { quoteId, role }),
  listAuditLog: () => ipcRenderer.invoke('server:listAuditLog'),

  listRoles: () => ipcRenderer.invoke('auth:listRoles')
});
