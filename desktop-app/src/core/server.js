'use strict';
/**
 * 「企业服务端」边界模拟层（P0 演示用）。
 *
 * 真实产品里，组织权限、共享知识与数据资产、业务连接器、审批与审计都应
 * 由企业服务端持有（PRD 新增章节「企业服务端边界」）；桌面客户端只通过
 * 受控的业务 API 查询，不直连高权限生产库（PRD 12.2 AI Data Gateway）。
 *
 * 这个文件把以上边界在单机 Electron 进程内老老实实地模拟出来：
 *   - 历史报价 / 成本目录 / 定价规则 被当作「远端数据」，只能通过本文件
 *     导出的函数访问，渲染进程和 pricingEngine 都不能绕过它直接读文件。
 *   - 所有读取都经过一段人为网络延迟，并受 `online` 开关控制：断网时不会
 *     伪装成功，而是显式返回 offline/待连接状态，必要时退回到本机缓存的
 *     只读快照。
 *   - 审批、报价归档等「写」操作一律要求在线，因为协作与审批以服务端记
 *     录为权威数据（PRD「企业服务端边界」）。
 *   - 每一次网关调用都写审计日志，对应 PRD 6.6 / 12.2 的可追溯要求。
 *
 * 生产版本应把这里替换成真正的 HTTPS 调用 + 服务端持久化；对调用方
 * （Electron 主进程的 IPC handler）而言接口形状不需要变。
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { JsonStore } = require('./store');
const { calculateQuote } = require('./pricingEngine');
const { canViewRawCost, canApprove, ROLE_LABELS } = require('./auth');

const SAMPLE_DATA_DIR = process.env.EAW_SAMPLE_DATA_DIR || path.join(__dirname, '..', '..', 'sample-data');
const WORKSPACE_DATA_DIR = process.env.EAW_WORKSPACE_DATA_DIR || path.join(__dirname, '..', '..', 'workspace-data');
const CACHE_DIR = path.join(WORKSPACE_DATA_DIR, 'cache');

fs.mkdirSync(CACHE_DIR, { recursive: true });

const store = new JsonStore(WORKSPACE_DATA_DIR);

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 内存中的「企业数据」真值，带独立于总开关的成本源故障模拟开关。
const serverState = {
  online: true,
  costCatalog: loadJson(path.join(SAMPLE_DATA_DIR, 'cost_catalog.json')),
  historicalQuotes: loadJson(path.join(SAMPLE_DATA_DIR, 'historical_quotes.json')),
  pricingPolicy: loadJson(path.join(SAMPLE_DATA_DIR, 'pricing_policy.json'))
};

function networkDelay(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeCache(name, data) {
  fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function readCache(name) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function audit(event) {
  return store.appendAudit(event);
}

function getConnectionState() {
  return {
    online: serverState.online,
    costSourceAvailable: serverState.costCatalog.available !== false
  };
}

function setOnlineState(online) {
  serverState.online = Boolean(online);
  audit({ actor: 'demo-control', action: 'SET_ONLINE_STATE', detail: { online: serverState.online } });
  return getConnectionState();
}

function setCostSourceAvailable(available) {
  serverState.costCatalog.available = Boolean(available);
  audit({ actor: 'demo-control', action: 'SET_COST_SOURCE_AVAILABLE', detail: { available } });
  return getConnectionState();
}

/**
 * 只读查询：历史报价 + 成本目录 + 定价规则快照。
 * 在线时从「服务端」取数并刷新本机缓存；离线时若有缓存则返回缓存并显式
 * 标注 stale，没有缓存则返回 offline 状态，不假装成功。
 */
async function fetchPricingContext({ actor }) {
  if (!serverState.online) {
    const cached = readCache('pricing_context');
    audit({ actor, action: 'FETCH_PRICING_CONTEXT', detail: { online: false, usedCache: Boolean(cached) } });
    if (!cached) {
      return { ok: false, state: 'offline', message: '当前处于断网状态，且本机没有可用缓存，无法查询企业数据，请联网后重试。' };
    }
    return { ok: true, state: 'cached', stale: true, data: cached };
  }

  await networkDelay();
  const data = {
    costCatalog: serverState.costCatalog,
    historicalQuotes: serverState.historicalQuotes,
    pricingPolicy: serverState.pricingPolicy
  };
  writeCache('pricing_context', data);
  audit({ actor, action: 'FETCH_PRICING_CONTEXT', detail: { online: true, costAsOf: data.costCatalog.asOf, historyAsOf: data.historicalQuotes.asOf } });
  return { ok: true, state: 'online', stale: false, data };
}

/**
 * 按查看者角色对「计算结果」做只读裁剪：原始成本只在返回给调用方前裁剪，
 * 服务端持久化的记录永远保留完整数据——这样同一笔报价换个有权限的角色
 * （例如提交给经理审批时）查看，才能看到真实成本，而不是把“销售看不到
 * 成本”永久烧进这条记录里，变成连审批人也看不到。
 */
function redactCalcForRole(calc, role) {
  if (!calc) return calc;
  const allowCost = canViewRawCost(role);
  const copy = JSON.parse(JSON.stringify(calc));
  if (copy.status === 'ok') {
    if (allowCost) {
      copy.cost.visible = true;
    } else {
      copy.cost = {
        visible: false,
        note: '当前角色无成本查看权限，仅返回授权计算结论（价格与毛利是否达标）。'
      };
    }
  }
  return copy;
}

function redactQuoteForRole(quote, role) {
  if (!quote) return quote;
  const copy = JSON.parse(JSON.stringify(quote));
  if (copy.calculation) copy.calculation = redactCalcForRole(copy.calculation, role);
  return copy;
}

/**
 * AI Data Gateway：参数化计算接口（对应 PRD 12.2 的 calculate_quote /
 * get_cost_summary / get_quote_history / search_similar_quotes 的合并简化
 * 版本）。调用方只传标准化字段和角色，拿不到任何「自由查询」能力，也拿不
 * 到裁剪前的原始数据。这是一个不落库的即时查询，不会创建/更新报价记录。
 */
async function calculateQuoteViaGateway({ actor, role, item, manualUnitPrice }) {
  const ctx = await fetchPricingContext({ actor });
  if (!ctx.ok) {
    return { ok: false, state: ctx.state, message: ctx.message };
  }

  const result = calculateQuote({
    item,
    costCatalog: ctx.data.costCatalog,
    historicalQuotes: ctx.data.historicalQuotes,
    policy: ctx.data.pricingPolicy,
    manualUnitPrice
  });
  const redacted = redactCalcForRole(result, role);

  audit({
    actor,
    action: 'CALCULATE_QUOTE_PREVIEW',
    detail: {
      role,
      roleLabel: ROLE_LABELS[role] || role,
      productCode: item.productCode,
      qty: item.qty,
      status: redacted.status,
      exceptions: redacted.exceptions,
      costVisible: canViewRawCost(role),
      dataState: ctx.state
    }
  });

  return { ok: true, state: ctx.state, stale: ctx.stale, result: redacted };
}

function newQuoteId() {
  const seq = store.readCollection('quotes').length + 1;
  const y = new Date().getFullYear();
  return `Q-${y}-${String(seq).padStart(4, '0')}`;
}

/**
 * 创建报价草稿：保存本机已确认的字段（不含原始 Excel 文件内容）。
 */
function createQuoteDraft({ actor, sourceFile, confirmedItem }) {
  const quote = {
    id: newQuoteId(),
    createdAt: new Date().toISOString(),
    createdBy: actor,
    status: 'draft',
    sourceFile: sourceFile ? { name: sourceFile.name, sha256: sourceFile.sha256, keptLocal: true } : null,
    confirmedItem,
    confirmedFieldsSentToServer: Object.keys(confirmedItem),
    calculation: null,
    approval: null,
    exportRecord: null
  };
  store.upsert('quotes', quote);
  audit({ actor, action: 'CREATE_QUOTE_DRAFT', detail: { quoteId: quote.id, productCode: confirmedItem.productCode } });
  return quote;
}

async function calculateForQuote({ actor, role, quoteId, manualUnitPrice }) {
  const quote = store.find('quotes', quoteId);
  if (!quote) return { ok: false, message: `报价 ${quoteId} 不存在。` };

  const ctx = await fetchPricingContext({ actor });
  if (!ctx.ok) return { ok: false, state: ctx.state, message: ctx.message };

  // 服务端持久化记录保留完整计算结果（含原始成本），是后续任何角色查看/
  // 审批的权威依据；只在「返回给某个角色查看」时才裁剪，绝不裁剪后入库。
  const fullResult = calculateQuote({
    item: quote.confirmedItem,
    costCatalog: ctx.data.costCatalog,
    historicalQuotes: ctx.data.historicalQuotes,
    policy: ctx.data.pricingPolicy,
    manualUnitPrice
  });

  quote.calculation = fullResult;
  quote.status = fullResult.status === 'ok' ? 'calculated' : 'blocked';
  quote.lastCalculatedAt = new Date().toISOString();
  quote.lastCalculatedBy = actor;
  store.upsert('quotes', quote);

  audit({
    actor,
    action: 'CALCULATE_QUOTE',
    detail: {
      role, roleLabel: ROLE_LABELS[role] || role, quoteId,
      productCode: quote.confirmedItem.productCode,
      status: fullResult.status, exceptions: fullResult.exceptions, dataState: ctx.state
    }
  });

  return { ok: true, state: ctx.state, stale: ctx.stale, quote: redactQuoteForRole(quote, role) };
}

async function submitForApproval({ actor, role, quoteId }) {
  if (!serverState.online) {
    audit({ actor, action: 'SUBMIT_FOR_APPROVAL', detail: { quoteId, result: 'offline' } });
    return { ok: false, state: 'offline', message: '当前处于断网状态，审批须由企业服务端受理，暂无法提交，请联网后重试。' };
  }
  const quote = store.find('quotes', quoteId);
  if (!quote) return { ok: false, message: `报价 ${quoteId} 不存在。` };
  if (!quote.calculation || quote.calculation.status !== 'ok') {
    return { ok: false, message: '报价尚未完成计算或被规则阻断，不能提交审批。' };
  }

  await networkDelay(200);
  quote.status = 'pending_approval';
  quote.approval = {
    required: true,
    escalated: quote.calculation.approval.escalated,
    reasons: quote.calculation.approval.reasons,
    submittedAt: new Date().toISOString(),
    submittedBy: actor,
    decidedAt: null,
    decidedBy: null,
    decision: null,
    comment: null
  };
  store.upsert('quotes', quote);
  audit({ actor, action: 'SUBMIT_FOR_APPROVAL', detail: { quoteId, escalated: quote.approval.escalated } });
  return { ok: true, quote: redactQuoteForRole(quote, role) };
}

async function decideApproval({ actor, role, quoteId, decision, comment }) {
  if (!serverState.online) {
    audit({ actor, action: 'DECIDE_APPROVAL', detail: { quoteId, result: 'offline' } });
    return { ok: false, state: 'offline', message: '当前处于断网状态，审批决定无法写回企业服务端，暂不可操作。' };
  }
  if (!canApprove(role)) {
    audit({ actor, action: 'DECIDE_APPROVAL', detail: { quoteId, result: 'forbidden', role } });
    return { ok: false, state: 'forbidden', message: `角色「${ROLE_LABELS[role] || role}」无审批权限。` };
  }
  const quote = store.find('quotes', quoteId);
  if (!quote || quote.status !== 'pending_approval') {
    return { ok: false, message: '报价不处于待审批状态。' };
  }

  await networkDelay(200);
  quote.status = decision === 'approved' ? 'approved' : 'rejected';
  quote.approval.decidedAt = new Date().toISOString();
  quote.approval.decidedBy = actor;
  quote.approval.decision = decision;
  quote.approval.comment = comment || null;
  store.upsert('quotes', quote);
  audit({ actor, action: 'DECIDE_APPROVAL', detail: { quoteId, decision, role } });
  return { ok: true, quote: redactQuoteForRole(quote, role) };
}

/**
 * 导出归档只在主进程内部调用（main.js 直接拿完整记录去生成文件），
 * 不经过渲染进程，因此使用未裁剪的原始记录——况且正式报价文件本身也
 * 从不打印原始单位成本（见 exportDoc.js），裁剪与否不影响文件内容。
 */
function recordExport({ actor, quoteId, exportPath }) {
  const quote = store.find('quotes', quoteId);
  if (!quote) return { ok: false, message: `报价 ${quoteId} 不存在。` };
  if (quote.status !== 'approved') {
    return { ok: false, message: '只有已审批通过的报价才能导出正式文件。' };
  }
  quote.exportRecord = { exportedAt: new Date().toISOString(), exportedBy: actor, path: exportPath };
  quote.status = 'archived';
  store.upsert('quotes', quote);
  audit({ actor, action: 'EXPORT_AND_ARCHIVE', detail: { quoteId, exportPath } });
  return { ok: true, quote };
}

/** IPC 对渲染进程的列表/详情接口：按请求方角色裁剪成本。 */
function listQuotes(role) {
  const all = store.readCollection('quotes').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return role ? all.map((q) => redactQuoteForRole(q, role)) : all;
}

function getQuote(quoteId, role) {
  const quote = store.find('quotes', quoteId);
  return role ? redactQuoteForRole(quote, role) : quote;
}

/** 内部专用：导出、测试等需要完整记录的场景。不经过 IPC 暴露给渲染进程。 */
function getQuoteRaw(quoteId) {
  return store.find('quotes', quoteId);
}

function listAuditLog(limit = 200) {
  const all = store.readCollection('audit_log');
  return all.slice(Math.max(0, all.length - limit)).reverse();
}

module.exports = {
  getConnectionState,
  setOnlineState,
  setCostSourceAvailable,
  fetchPricingContext,
  calculateQuoteViaGateway,
  createQuoteDraft,
  calculateForQuote,
  submitForApproval,
  decideApproval,
  recordExport,
  listQuotes,
  getQuote,
  getQuoteRaw,
  listAuditLog,
  WORKSPACE_DATA_DIR
};
