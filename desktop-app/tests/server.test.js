'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaw-server-test-'));
process.env.EAW_WORKSPACE_DATA_DIR = tmpDir;

const server = require('../src/core/server');
const { ROLES } = require('../src/core/auth');

test('角色网关：销售看不到原始成本，经理可以看到', async () => {
  const item = { productCode: 'WJ-2000', productCodeRaw: 'WJ-2000', qty: 55, region: '华东', dueInDays: 28, paymentTerms: '月结30天' };

  const salesView = await server.calculateQuoteViaGateway({ actor: 'sales-zhang', role: ROLES.SALES, item });
  assert.equal(salesView.ok, true);
  assert.equal(salesView.result.cost.visible, false);
  assert.equal(salesView.result.cost.unitCost, undefined, '销售角色的返回结果里不应出现原始成本字段');
  assert.equal(salesView.result.pricing.marginMeetsFloor, true);

  const managerView = await server.calculateQuoteViaGateway({ actor: 'manager-li', role: ROLES.MANAGER, item });
  assert.equal(managerView.result.cost.visible, true);
  assert.equal(managerView.result.cost.unitCost, 12500);
});

test('端到端：草稿 -> 计算 -> 提交审批 -> 审批通过 -> 导出归档，全程留痕', async () => {
  const item = { productCode: 'WJ-2000', productCodeRaw: 'WJ-2000', customer: '苏州某智能制造有限公司', qty: 55, region: '华东', dueInDays: 28, paymentTerms: '月结30天' };
  const quote = server.createQuoteDraft({
    actor: 'sales-zhang',
    sourceFile: { name: 'customer_request_sample.xlsx', sha256: 'abc123' },
    confirmedItem: item
  });
  assert.equal(quote.status, 'draft');
  assert.deepEqual(quote.confirmedFieldsSentToServer.sort(), Object.keys(item).sort());

  const calcRes = await server.calculateForQuote({ actor: 'sales-zhang', role: ROLES.SALES, quoteId: quote.id });
  assert.equal(calcRes.ok, true);
  assert.equal(calcRes.quote.status, 'calculated');
  assert.equal(calcRes.quote.calculation.cost.visible, false, '销售测算时拿到的结果不应含原始成本');

  const submitRes = await server.submitForApproval({ actor: 'sales-zhang', role: ROLES.SALES, quoteId: quote.id });
  assert.equal(submitRes.ok, true);
  assert.equal(submitRes.quote.status, 'pending_approval');
  assert.equal(submitRes.quote.calculation.cost.visible, false, '销售自己查看提交后的报价仍不应看到成本');

  // 销售本人不能审批自己的报价
  const forbidden = await server.decideApproval({ actor: 'sales-zhang', role: ROLES.SALES, quoteId: quote.id, decision: 'approved' });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.state, 'forbidden');

  const approveRes = await server.decideApproval({ actor: 'manager-li', role: ROLES.MANAGER, quoteId: quote.id, decision: 'approved', comment: '同意，符合价格政策。' });
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.quote.status, 'approved');
  assert.equal(approveRes.quote.calculation.cost.visible, true, '经理审批时必须能看到真实成本，不能因为销售先算过就被永久裁剪');
  assert.equal(approveRes.quote.calculation.cost.unitCost, 12500);

  const { exportQuoteDocx } = require('../src/core/exportDoc');
  const finalQuote = server.getQuoteRaw(quote.id);
  const archiveDir = path.join(tmpDir, 'archive', quote.id);
  const { filePath } = await exportQuoteDocx(finalQuote, archiveDir);
  assert.ok(fs.existsSync(filePath));

  const recordRes = server.recordExport({ actor: 'sales-zhang', quoteId: quote.id, exportPath: filePath });
  assert.equal(recordRes.ok, true);
  assert.equal(recordRes.quote.status, 'archived');

  const auditLog = server.listAuditLog();
  const actions = auditLog.map((e) => e.action);
  for (const expected of ['CREATE_QUOTE_DRAFT', 'CALCULATE_QUOTE', 'SUBMIT_FOR_APPROVAL', 'DECIDE_APPROVAL', 'EXPORT_AND_ARCHIVE']) {
    assert.ok(actions.includes(expected), `审计日志应包含 ${expected}`);
  }
});

test('断网：不伪装成功，有缓存时只读可看，写操作（提交/审批）必须拒绝', async () => {
  const item = { productCode: 'WJ-2000', qty: 55, region: '华东', dueInDays: 28, paymentTerms: '月结30天' };

  // 先联网跑一次，确保有缓存
  await server.calculateQuoteViaGateway({ actor: 'sales-zhang', role: ROLES.SALES, item });

  server.setOnlineState(false);
  try {
    const offlineCalc = await server.calculateQuoteViaGateway({ actor: 'sales-zhang', role: ROLES.SALES, item });
    assert.equal(offlineCalc.ok, true, '断网但有缓存时，只读查询应仍可用（显式标注为缓存）');
    assert.equal(offlineCalc.state, 'cached');
    assert.equal(offlineCalc.stale, true);

    const quote = server.createQuoteDraft({ actor: 'sales-zhang', sourceFile: null, confirmedItem: item });
    await server.calculateForQuote({ actor: 'sales-zhang', role: ROLES.SALES, quoteId: quote.id });
    const submitRes = await server.submitForApproval({ actor: 'sales-zhang', quoteId: quote.id });
    assert.equal(submitRes.ok, false, '断网时不得假装提交成功');
    assert.equal(submitRes.state, 'offline');
  } finally {
    server.setOnlineState(true);
  }
});

test('成本源故障：不得静默使用旧成本值', async () => {
  const item = { productCode: 'WJ-2000', qty: 55 };
  server.setCostSourceAvailable(false);
  try {
    const res = await server.calculateQuoteViaGateway({ actor: 'sales-zhang', role: ROLES.MANAGER, item });
    assert.equal(res.ok, true);
    assert.equal(res.result.status, 'blocked');
    assert.ok(res.result.exceptions.includes('COST_SOURCE_UNAVAILABLE'));
  } finally {
    server.setCostSourceAvailable(true);
  }
});

test('getQuote/listQuotes 按角色裁剪，getQuoteRaw 返回完整记录供内部使用', async () => {
  const item = { productCode: 'WJ-2000', productCodeRaw: 'WJ-2000', customer: '测试客户', qty: 20, region: '华东', dueInDays: 20, paymentTerms: '款到发货' };
  const quote = server.createQuoteDraft({ actor: 'sales-zhang', sourceFile: null, confirmedItem: item });
  await server.calculateForQuote({ actor: 'sales-zhang', role: ROLES.SALES, quoteId: quote.id });

  const asSales = server.getQuote(quote.id, ROLES.SALES);
  assert.equal(asSales.calculation.cost.visible, false);

  const asManager = server.getQuote(quote.id, ROLES.MANAGER);
  assert.equal(asManager.calculation.cost.visible, true);
  assert.equal(asManager.calculation.cost.unitCost, 12500);

  const raw = server.getQuoteRaw(quote.id);
  assert.equal(raw.calculation.cost.unitCost, 12500, 'getQuoteRaw 不做任何角色裁剪');

  const listAsSales = server.listQuotes(ROLES.SALES).find((q) => q.id === quote.id);
  assert.equal(listAsSales.calculation.cost.visible, false);
  const listAsManager = server.listQuotes(ROLES.MANAGER).find((q) => q.id === quote.id);
  assert.equal(listAsManager.calculation.cost.visible, true);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
