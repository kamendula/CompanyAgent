'use strict';
/**
 * Electron 主进程。
 *
 * 所有文件系统访问（选择文件、解析 Excel、打开所在目录）和「企业服务端」
 * 调用都只在主进程完成；渲染进程通过 preload 暴露的最小 IPC 接口访问，
 * 不持有 Node/文件系统能力，降低本机文件被渲染层任意脚本滥用的风险
 * （对应 PRD 11.2「执行沙箱进行文件、网络、环境变量与凭据隔离」的最小化
 * 实践，真实生产还需要更完整的沙箱与权限分级）。
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { parseCustomerRequestExcel } = require('../src/core/excelParser');
const { exportQuoteDocx } = require('../src/core/exportDoc');
const server = require('../src/core/server');
const { ROLES, ROLE_LABELS } = require('../src/core/auth');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    backgroundColor: '#F5F7FB',
    title: 'Enterprise AI Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  if (process.env.EAW_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- 授权目录（本机数据权限）最小落地：维护一份已授权目录清单 ----
const AUTH_STORE_FILE = path.join(server.WORKSPACE_DATA_DIR, 'authorized_folders.json');

function readAuthorizedFolders() {
  if (!fs.existsSync(AUTH_STORE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(AUTH_STORE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAuthorizedFolders(list) {
  fs.mkdirSync(path.dirname(AUTH_STORE_FILE), { recursive: true });
  fs.writeFileSync(AUTH_STORE_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---------------------------------------------------------------------
// IPC：文件与本机能力
// ---------------------------------------------------------------------
ipcMain.handle('fs:selectExcelFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择客户需求 Excel',
    properties: ['openFile'],
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx', 'xls'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('fs:parseExcel', async (_evt, filePath) => {
  try {
    return { ok: true, data: parseCustomerRequestExcel(filePath) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('fs:openPath', async (_evt, targetPath) => {
  if (!fs.existsSync(targetPath)) return { ok: false, message: '文件或目录不存在。' };
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    await shell.openPath(targetPath);
  } else {
    shell.showItemInFolder(targetPath);
  }
  return { ok: true };
});

ipcMain.handle('fs:selectAuthorizedFolder', async (_evt, purpose) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要授权的本机目录',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folderPath = result.filePaths[0];
  const list = readAuthorizedFolders();
  const record = {
    path: folderPath,
    purpose: purpose || 'temporary', // temporary | personal_index | project_share
    authorizedAt: new Date().toISOString(),
    revoked: false
  };
  const idx = list.findIndex((r) => r.path === folderPath);
  if (idx >= 0) list[idx] = record; else list.push(record);
  writeAuthorizedFolders(list);
  return record;
});

ipcMain.handle('fs:listAuthorizedFolders', async () => readAuthorizedFolders());

ipcMain.handle('fs:revokeAuthorizedFolder', async (_evt, folderPath) => {
  const list = readAuthorizedFolders();
  const idx = list.findIndex((r) => r.path === folderPath);
  if (idx < 0) return { ok: false, message: '未找到该授权记录。' };
  list[idx].revoked = true;
  list[idx].revokedAt = new Date().toISOString();
  writeAuthorizedFolders(list);
  return { ok: true, record: list[idx] };
});

// ---------------------------------------------------------------------
// IPC：企业服务端边界（server.js）
// ---------------------------------------------------------------------
ipcMain.handle('server:getConnectionState', async () => server.getConnectionState());
ipcMain.handle('server:setOnlineState', async (_evt, online) => server.setOnlineState(online));
ipcMain.handle('server:setCostSourceAvailable', async (_evt, available) => server.setCostSourceAvailable(available));

ipcMain.handle('server:createQuoteDraft', async (_evt, payload) => server.createQuoteDraft(payload));
ipcMain.handle('server:calculateForQuote', async (_evt, payload) => server.calculateForQuote(payload));
ipcMain.handle('server:submitForApproval', async (_evt, payload) => server.submitForApproval(payload));
ipcMain.handle('server:decideApproval', async (_evt, payload) => server.decideApproval(payload));
ipcMain.handle('server:listQuotes', async (_evt, role) => server.listQuotes(role));
ipcMain.handle('server:getQuote', async (_evt, { quoteId, role }) => server.getQuote(quoteId, role));
ipcMain.handle('server:listAuditLog', async () => server.listAuditLog());

ipcMain.handle('server:exportAndArchive', async (_evt, { quoteId }) => {
  // 导出在主进程内部完成，使用完整（未按角色裁剪）的权威记录；
  // 正式报价文件本身也从不打印原始单位成本，见 exportDoc.js。
  const quote = server.getQuoteRaw(quoteId);
  if (!quote) return { ok: false, message: `报价 ${quoteId} 不存在。` };
  if (quote.status !== 'approved') return { ok: false, message: '只有已审批通过的报价才能导出。' };

  const archiveDir = path.join(server.WORKSPACE_DATA_DIR, 'archive', quote.id);
  const { filePath, manifestPath } = await exportQuoteDocx(quote, archiveDir);
  const recordRes = server.recordExport({ actor: quote.createdBy, quoteId, exportPath: filePath });
  return { ...recordRes, filePath, manifestPath, archiveDir };
});

ipcMain.handle('auth:listRoles', async () => Object.values(ROLES).map((r) => ({ id: r, label: ROLE_LABELS[r] })));
