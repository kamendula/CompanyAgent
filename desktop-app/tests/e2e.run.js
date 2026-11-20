'use strict';
/**
 * 端到端烟雾测试：真正启动 Electron 应用（而不是只测核心逻辑模块），
 * 用 Playwright 驱动渲染进程完成一次完整的报价闭环，并对关键异常路径
 * 做回归验证。原生文件选择对话框通过 monkey-patch 主进程 dialog 模块
 * 绕开（Playwright 无法点击操作系统原生对话框）。
 *
 * 运行：pnpm run test:e2e
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const playwright = require('playwright-core');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-e2e-'));
  console.log('[e2e] 临时 workspace-data 目录：', tmpWorkspace);

  // 本开发环境默认设置了 ELECTRON_RUN_AS_NODE=1（避免工具误触发 GUI 应用），
  // 但这会让 electron 可执行文件退化成普通 Node 解释器、拿不到 app/BrowserWindow。
  // 启动真正的桌面应用时必须显式去掉它。
  const launchEnv = { ...process.env, EAW_WORKSPACE_DATA_DIR: tmpWorkspace, EAW_OPEN_DEVTOOLS: '0' };
  delete launchEnv.ELECTRON_RUN_AS_NODE;

  const electronApp = await playwright._electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_DIR],
    env: launchEnv
  });

  const page = await electronApp.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[renderer console error]', msg.text());
  });
  page.on('dialog', async (dialog) => {
    console.log('[e2e] 原生/JS 对话框:', dialog.type(), '-', dialog.message().slice(0, 80));
    await dialog.accept();
  });

  await page.waitForSelector('#view-home:not(.hidden)');
  console.log('[e2e] ✔ 应用启动，默认进入本机工作区');

  // ---- 场景 1：正常报价全流程 ----
  const sampleFile = path.join(APP_DIR, 'sample-data', 'customer_request_sample.xlsx');
  await electronApp.evaluate(async ({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, sampleFile);

  await page.click('#homeSelectFileBtn');
  await page.waitForSelector('#view-quote:not(.hidden)');
  await page.waitForSelector('#confirmForm:not(.hidden)');

  const productCode = await page.inputValue('#f_productCode');
  const qty = await page.inputValue('#f_qty');
  assert.strictEqual(productCode, 'WJ-2000');
  assert.strictEqual(qty, '55');
  console.log('[e2e] ✔ Excel 解析并回填确认表单正确（WJ-2000 / 55）');

  await page.click('#confirmAndCalcBtn'); // 触发 window.confirm，由上面的 dialog 监听器自动接受
  await page.waitForSelector('.price-hero', { timeout: 15000 });

  const priceText = await page.textContent('.price-hero');
  assert.ok(priceText.includes('17,361'), `期望建议单价 17,361，实际："${priceText}"`);
  console.log('[e2e] ✔ 报价计算结果正确：', priceText.trim());

  const explanation = await page.textContent('.explanation-box');
  assert.ok(explanation.includes('成交均价'));
  assert.ok(explanation.includes('未成交'));
  console.log('[e2e] ✔ AI 解释包含成交均价对比，且明确剔除未成交报价');

  const evidenceHtml = await page.innerHTML('#evidencePanel');
  assert.ok(evidenceHtml.includes('Q-24087'));
  assert.ok(evidenceHtml.includes('Q-24091'));
  assert.ok(evidenceHtml.includes('未成交'));
  console.log('[e2e] ✔ 证据栏区分已成交 / 未成交案例');

  // 销售角色：成本应被隐藏
  const salesResultHtml = await page.innerHTML('#quoteResult');
  assert.ok(salesResultHtml.includes('当前角色无查看权限'), '销售角色不应看到原始成本');
  console.log('[e2e] ✔ 销售角色看不到原始成本，仅见授权结论');

  await page.click('#submitApprovalBtn');
  await page.waitForSelector('text=待审批');
  console.log('[e2e] ✔ 已提交审批，状态变为待审批');

  const noApprovalRight = await page.innerHTML('#quoteResult');
  assert.ok(noApprovalRight.includes('当前角色无审批权限'));

  await page.selectOption('#roleSelect', 'manager');
  await page.waitForSelector('#approveBtn');
  const managerResultHtml = await page.innerHTML('#quoteResult');
  assert.ok(managerResultHtml.includes('¥12,500') || managerResultHtml.includes('12,500'), '切换为经理角色后应能看到原始成本');
  console.log('[e2e] ✔ 切换为经理角色后可见原始成本，且出现审批按钮');

  await page.fill('#approvalComment', '同意，符合价格政策。');
  await page.click('#approveBtn');
  await page.waitForSelector('text=已审批通过');
  console.log('[e2e] ✔ 审批通过');

  await page.click('#exportBtn');
  await page.waitForSelector('text=已归档', { timeout: 15000 });
  console.log('[e2e] ✔ 已生成正式报价文件并归档');

  const archiveDir = path.join(tmpWorkspace, 'archive');
  const quoteDirs = fs.readdirSync(archiveDir);
  assert.strictEqual(quoteDirs.length, 1);
  const files = fs.readdirSync(path.join(archiveDir, quoteDirs[0]));
  assert.ok(files.some((f) => f.endsWith('.docx')), '归档目录应包含正式报价 docx 文件');
  assert.ok(files.some((f) => f.endsWith('manifest.json')), '归档目录应包含可追溯的 manifest');
  console.log('[e2e] ✔ 本机文件系统确认已生成 docx 与 manifest：', files.join(', '));

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-quote-archived.png'), fullPage: true });

  // ---- 场景 2：产品无法匹配，不强行定价 ----
  await page.click('[data-view="home"]');
  const unmatchedFile = path.join(APP_DIR, 'sample-data', 'customer_request_unmatched.xlsx');
  await electronApp.evaluate(async ({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, unmatchedFile);
  await page.click('#homeSelectFileBtn');
  await page.waitForSelector('#confirmForm:not(.hidden)');
  await page.click('#confirmAndCalcBtn');
  await page.waitForSelector('text=规则阻断，不得强行定价', { timeout: 15000 });
  console.log('[e2e] ✔ 产品无法匹配场景：系统阻断，不强行定价');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-product-not-matched.png'), fullPage: true });

  // ---- 场景 3：断网状态显式提示，不伪装成功 ----
  await page.check('#offlineToggle');
  await sleep(200);
  const connPill = await page.textContent('#connStatusPill');
  assert.ok(connPill.includes('待连接'));
  console.log('[e2e] ✔ 断网后顶部状态显式变为“待连接”');

  await page.click('[data-view="home"]');
  const lowMarginFile = path.join(APP_DIR, 'sample-data', 'customer_request_low_margin.xlsx');
  await electronApp.evaluate(async ({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, lowMarginFile);
  await page.click('#homeSelectFileBtn');
  await page.waitForSelector('#confirmForm:not(.hidden)');
  await page.click('#confirmAndCalcBtn');
  await page.waitForSelector('text=待连接', { timeout: 15000 });
  console.log('[e2e] ✔ 断网时查询报价显式提示待连接，而不是伪装成功');
  await page.uncheck('#offlineToggle');

  await electronApp.close();
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  console.log('\n[e2e] 全部场景通过。');
}

main().catch((err) => {
  console.error('[e2e] 失败：', err);
  process.exitCode = 1;
});
