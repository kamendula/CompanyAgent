'use strict';

const ROLE_ACTOR = {
  sales: '销售专员 · 张敏',
  manager: '销售经理 · 李强（审批人）',
  finance: '财务 / 业务管理员 · 王芳',
  data_admin: '数据管理员 · 赵亮'
};

const STATUS_LABEL = {
  draft: '草稿',
  calculated: '已测算',
  blocked: '规则阻断',
  pending_approval: '待审批',
  approved: '已审批通过',
  rejected: '已驳回',
  archived: '已归档'
};

const state = {
  role: 'sales',
  connectionState: { online: true, costSourceAvailable: true },
  currentFile: null, // excelParser 返回结构
  currentRow: null,
  currentQuote: null
};

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

function actorName() {
  return ROLE_ACTOR[state.role] || state.role;
}

function toast(message, isError = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' toast-error' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, 4200);
}

function setStatusbar(message) {
  $('#statusbarMessage').textContent = message;
}

function money(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN');
}

// ---------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------
function switchView(name) {
  $all('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  $all('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  if (name === 'archive') loadArchiveView();
  if (name === 'audit') loadAuditView();
  if (name === 'home') loadHomeView();
}

// ---------------------------------------------------------------------
// 顶部状态 / 演示控制
// ---------------------------------------------------------------------
async function refreshConnectionPill() {
  const cs = await window.api.getConnectionState();
  state.connectionState = cs;
  const pill = $('#connStatusPill');
  if (cs.online) {
    pill.innerHTML = '<span class="dot dot-ok"></span>企业已连接';
  } else {
    pill.innerHTML = '<span class="dot dot-off"></span>待连接（离线）';
  }
}

async function initDemoControls() {
  const roles = await window.api.listRoles();
  const sel = $('#roleSelect');
  sel.innerHTML = roles.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
  sel.value = state.role;
  sel.addEventListener('change', async () => {
    state.role = sel.value;
    setStatusbar(`已切换为角色：${ROLE_ACTOR[state.role]}`);
    // 换角色要重新向「企业服务端」按新角色取一次数据再渲染：
    // 成本是否可见必须按当前查看者实时判定，不能沿用上一个角色已经拿到的裁剪结果。
    if (state.currentQuote && state.currentQuote.id) {
      const fresh = await window.api.getQuote(state.currentQuote.id, state.role);
      if (fresh) {
        state.currentQuote = fresh;
        renderQuoteResult(fresh);
        renderEvidence(fresh.calculation);
      }
    }
  });

  $('#offlineToggle').addEventListener('change', async (e) => {
    await window.api.setOnlineState(!e.target.checked);
    await refreshConnectionPill();
    toast(e.target.checked ? '已模拟断网：远程查询与审批将显示待连接状态。' : '已恢复联网。');
  });
  $('#costFailToggle').addEventListener('change', async (e) => {
    await window.api.setCostSourceAvailable(!e.target.checked);
    toast(e.target.checked ? '已模拟成本源故障：报价测算将被规则阻断，不会使用旧值。' : '成本源已恢复可用。');
  });

  await refreshConnectionPill();
}

// ---------------------------------------------------------------------
// 本机工作区
// ---------------------------------------------------------------------
async function loadHomeView() {
  const folders = await window.api.listAuthorizedFolders();
  const tbody = $('#folderTable tbody');
  if (folders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="hint-text">尚未授权任何本机目录。</td></tr>';
  } else {
    tbody.innerHTML = folders.map((f) => `
      <tr>
        <td>${f.path}</td>
        <td>${{ temporary: '临时读取', personal_index: '个人索引', project_share: '项目共享' }[f.purpose] || f.purpose}</td>
        <td>${fmtTime(f.authorizedAt)}</td>
        <td>${f.revoked ? '<span class="badge badge-muted">已撤销</span>' : '<span class="badge badge-ok">生效中</span>'}</td>
        <td>${f.revoked ? '' : `<button class="btn btn-ghost" data-revoke="${encodeURIComponent(f.path)}">撤销</button>`}</td>
      </tr>
    `).join('');
    $all('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
      const p = decodeURIComponent(btn.dataset.revoke);
      await window.api.revokeAuthorizedFolder(p);
      toast('已撤销该目录授权（演示环境以标记代替真实缓存清理）。');
      loadHomeView();
    }));
  }

  const quotes = await window.api.listQuotes(state.role);
  const recentBox = $('#homeRecentQuotes');
  if (quotes.length === 0) {
    recentBox.textContent = '暂无记录';
  } else {
    recentBox.innerHTML = quotes.slice(0, 5).map((q) => `
      <div class="kv-row">
        <span>${q.id} · ${q.confirmedItem.customer || '未知客户'} · ${q.confirmedItem.productCode}</span>
        <span class="badge ${badgeClassForStatus(q.status)}">${STATUS_LABEL[q.status] || q.status}</span>
      </div>
    `).join('');
  }
}

$('#addFolderBtn').addEventListener('click', async () => {
  const purpose = $('#folderPurposeSelect').value;
  const record = await window.api.selectAuthorizedFolder(purpose);
  if (record) {
    toast(`已授权目录：${record.path}`);
    loadHomeView();
  }
});

$('#homeSelectFileBtn').addEventListener('click', async () => {
  const filePath = await window.api.selectExcelFile();
  if (filePath) await handleFileSelected(filePath);
});

function wireDropzone(el, onFile) {
  ['dragenter', 'dragover'].forEach((evt) => el.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => el.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover');
  }));
  el.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.api.getPathForFile(file);
    onFile(filePath);
  });
}

wireDropzone($('#homeDropzone'), (p) => handleFileSelected(p));
wireDropzone($('#quoteDropzone'), (p) => handleFileSelected(p));
$('#quoteSelectFileBtn').addEventListener('click', async () => {
  const filePath = await window.api.selectExcelFile();
  if (filePath) await handleFileSelected(filePath);
});

// ---------------------------------------------------------------------
// 智能报价助手 · 左栏：解析与确认
// ---------------------------------------------------------------------
async function handleFileSelected(filePath) {
  setStatusbar(`正在本机解析：${filePath}`);
  const res = await window.api.parseExcel(filePath);
  if (!res.ok) {
    toast(`解析失败：${res.message}`, true);
    setStatusbar('解析失败');
    return;
  }
  state.currentFile = res.data;
  state.currentRow = res.data.rows[0] || null;
  state.currentQuote = null;

  switchView('quote');
  renderFileInfo();
  renderConfirmForm();
  $('#quoteResult').innerHTML = '<div class="hint-text">请确认左侧字段后点击「确认字段并发起测算」。</div>';
  $('#evidencePanel').innerHTML = '<div class="hint-text">暂无数据</div>';
  setStatusbar('解析完成，原件保留在本机，请确认字段');
}

function renderFileInfo() {
  const f = state.currentFile;
  const box = $('#quoteFileInfo');
  const warn = f.warnings.length ? `<div style="color:#B27017;margin-top:4px;">${f.warnings.join('<br/>')}</div>` : '';
  box.innerHTML = `
    <div><strong>${f.file.name}</strong>（本机保留，未上传）</div>
    <div>SHA-256：${f.file.sha256.slice(0, 16)}…</div>
    <div>工作表：${f.sheetName}（共 ${f.rows.length} 行需求，首版仅处理第 1 行）</div>
    ${warn}
  `;
}

function renderConfirmForm() {
  const row = state.currentRow;
  const form = $('#confirmForm');
  if (!row) {
    form.classList.add('hidden');
    toast('未解析到任何数据行。', true);
    return;
  }
  form.classList.remove('hidden');
  $('#f_customer').value = row.customer || '';
  $('#f_productCode').value = row.productCode || '';
  $('#f_qty').value = row.qty || '';
  $('#f_region').value = row.region || '';
  $('#f_dueInDays').value = row.dueInDays != null ? row.dueInDays : '';
  $('#f_paymentTerms').value = row.paymentTerms || '';

  const notesBox = $('#confirmNotes');
  notesBox.innerHTML = row.confirmNotes.length
    ? `⚠ ${row.confirmNotes.join('；')}，请人工核实后再确认。`
    : '';
}

$('#confirmAndCalcBtn').addEventListener('click', async () => {
  const confirmedItem = {
    customer: $('#f_customer').value.trim(),
    productCodeRaw: $('#f_productCode').value.trim(),
    productCode: $('#f_productCode').value.trim().toUpperCase(),
    qty: Number($('#f_qty').value),
    region: $('#f_region').value.trim(),
    dueInDays: $('#f_dueInDays').value ? Number($('#f_dueInDays').value) : null,
    paymentTerms: $('#f_paymentTerms').value.trim()
  };

  if (!confirmedItem.customer || !confirmedItem.productCode || !confirmedItem.qty) {
    toast('客户、产品编号、数量为必填项，请补全后再确认。', true);
    return;
  }

  const fieldList = Object.entries(confirmedItem).map(([k, v]) => `${k} = ${v}`).join('\n');
  const proceed = window.confirm(
    `以下字段将发送给企业服务用于查询历史数据与计算报价，原始 Excel 文件不会上传：\n\n${fieldList}\n\n确认发起测算？`
  );
  if (!proceed) return;

  setStatusbar('正在创建报价草稿…');
  const quote = await window.api.createQuoteDraft({
    actor: actorName(),
    sourceFile: state.currentFile.file,
    confirmedItem
  });
  state.currentQuote = quote;

  await runCalculation(quote.id);
});

async function runCalculation(quoteId, manualUnitPrice) {
  setStatusbar('正在查询企业数据并计算报价…');
  const res = await window.api.calculateForQuote({
    actor: actorName(),
    role: state.role,
    quoteId,
    manualUnitPrice
  });

  if (!res.ok) {
    $('#quoteResult').innerHTML = `
      <div class="approval-box">
        <strong>⚠ ${res.state === 'offline' ? '待连接' : '查询失败'}</strong>
        <div class="hint-text" style="margin-top:6px;">${res.message}</div>
        <div class="action-row"><button class="btn btn-secondary" id="retryCalcBtn">重试</button></div>
      </div>`;
    $('#retryCalcBtn').addEventListener('click', () => runCalculation(quoteId, manualUnitPrice));
    setStatusbar('查询未完成：' + res.message);
    return;
  }

  state.currentQuote = res.quote;
  if (res.stale) toast('当前使用的是断网前缓存的数据，可能不是最新。');
  renderQuoteResult(res.quote);
  renderEvidence(res.quote.calculation);
  setStatusbar('测算完成');
}

// ---------------------------------------------------------------------
// 智能报价助手 · 中栏：结果 / 审批 / 导出
// ---------------------------------------------------------------------
function badgeClassForStatus(status) {
  return {
    draft: 'badge-muted', calculated: 'badge-muted', blocked: 'badge-danger',
    pending_approval: 'badge-warn', approved: 'badge-ok', rejected: 'badge-danger', archived: 'badge-ok'
  }[status] || 'badge-muted';
}

function renderQuoteResult(quote) {
  const box = $('#quoteResult');
  const calc = quote.calculation;

  if (!calc || calc.status !== 'ok') {
    box.innerHTML = `
      <div class="badge ${badgeClassForStatus('blocked')}">规则阻断，不得强行定价</div>
      <div class="explanation-box">${calc ? calc.message : '尚未测算。'}</div>
      ${calc && calc.exceptions ? `<div class="hint-text">异常代码：${calc.exceptions.join('、')}</div>` : ''}
    `;
    return;
  }

  const p = calc.pricing;
  const costRow = calc.cost.visible
    ? `<div class="kv-row"><span>单位成本（${calc.cost.sourceSystem}）</span><span>${money(calc.cost.unitCost)}</span></div>`
    : `<div class="kv-row"><span>单位成本</span><span class="hint-text">当前角色无查看权限，仅显示授权结论</span></div>`;

  const marginBadge = p.marginMeetsFloor
    ? `<span class="badge badge-ok">毛利达标 ${(p.margin * 100).toFixed(1)}%</span>`
    : `<span class="badge badge-danger">毛利未达标 ${(p.margin * 100).toFixed(1)}%，强制升级审批</span>`;

  box.innerHTML = `
    <div class="badge ${badgeClassForStatus(quote.status)}">${STATUS_LABEL[quote.status]}</div>
    <div class="price-hero">${money(p.appliedUnitPrice)} <span style="font-size:13px;color:#8A94A6;">/ 单价</span></div>
    <div class="kv-row"><span>总价</span><span>${money(p.appliedTotalPrice)}</span></div>
    <div class="kv-row"><span>规则建议单价</span><span>${money(p.suggestedUnitPrice)}</span></div>
    ${costRow}
    <div class="kv-row"><span>毛利</span>${marginBadge}</div>

    <div class="explanation-box">${calc.explanation}</div>

    ${quote.status === 'calculated' ? `
      <h4>人工调整（可选）</h4>
      <div style="display:flex; gap:8px; align-items:center;">
        <input type="number" id="manualPriceInput" placeholder="输入正式单价" style="flex:1;padding:7px;border:1px solid var(--divider);border-radius:9px;" value="${p.appliedUnitPrice}" />
        <button class="btn btn-secondary" id="recalcBtn">重新测算</button>
      </div>
    ` : ''}

    ${renderApprovalSection(quote)}

    ${quote.status === 'archived' ? `
      <div class="action-row">
        <button class="btn btn-secondary" id="openFileBtn">打开正式报价文件</button>
        <button class="btn btn-secondary" id="openFolderBtn">打开归档目录</button>
      </div>
    ` : ''}
  `;

  if (quote.status === 'calculated') {
    $('#recalcBtn').addEventListener('click', () => {
      const v = Number($('#manualPriceInput').value);
      if (!v || v <= 0) { toast('请输入有效的正式单价', true); return; }
      runCalculation(quote.id, v);
    });
    $('#submitApprovalBtn') && $('#submitApprovalBtn').addEventListener('click', () => submitApproval(quote.id));
  }

  wireApprovalButtons(quote);
}

function renderApprovalSection(quote) {
  if (quote.status === 'calculated') {
    return `
      <div class="action-row">
        <button class="btn btn-primary" id="submitApprovalBtn">提交审批</button>
      </div>`;
  }
  if (quote.status === 'pending_approval') {
    const canApprove = state.role === 'manager' || state.role === 'finance';
    return `
      <div class="approval-box">
        <strong>待审批</strong>
        <div class="hint-text">提交人：${quote.approval.submittedBy} ｜ 提交时间：${fmtTime(quote.approval.submittedAt)}</div>
        ${quote.approval.reasons.length ? `<div class="hint-text">升级原因：${quote.approval.reasons.join('；')}</div>` : ''}
        ${canApprove ? `
          <textarea id="approvalComment" placeholder="审批意见（可选）" style="width:100%;margin-top:8px;padding:7px;border:1px solid var(--divider);border-radius:9px;" rows="2"></textarea>
          <div class="action-row">
            <button class="btn btn-success" id="approveBtn">通过</button>
            <button class="btn btn-danger" id="rejectBtn">驳回</button>
          </div>` : `<div class="hint-text" style="margin-top:6px;">当前角色无审批权限，请切换为「销售经理」或「财务」试用审批。</div>`}
      </div>`;
  }
  if (quote.status === 'approved') {
    return `
      <div class="approval-box calm">
        <strong>已审批通过</strong>
        <div class="hint-text">审批人：${quote.approval.decidedBy} ｜ 时间：${fmtTime(quote.approval.decidedAt)}</div>
        ${quote.approval.comment ? `<div class="hint-text">意见：${quote.approval.comment}</div>` : ''}
        <div class="action-row"><button class="btn btn-primary" id="exportBtn">生成正式报价并归档</button></div>
      </div>`;
  }
  if (quote.status === 'rejected') {
    return `
      <div class="approval-box">
        <strong>已驳回</strong>
        <div class="hint-text">审批人：${quote.approval.decidedBy} ｜ 意见：${quote.approval.comment || '（无）'}</div>
      </div>`;
  }
  if (quote.status === 'archived') {
    return `
      <div class="approval-box calm">
        <strong>已归档</strong>
        <div class="hint-text">导出时间：${fmtTime(quote.exportRecord && quote.exportRecord.exportedAt)}</div>
      </div>`;
  }
  return '';
}

function wireApprovalButtons(quote) {
  const submitBtn = $('#submitApprovalBtn');
  if (submitBtn) submitBtn.addEventListener('click', () => submitApproval(quote.id));

  const approveBtn = $('#approveBtn');
  if (approveBtn) approveBtn.addEventListener('click', () => decide(quote.id, 'approved'));
  const rejectBtn = $('#rejectBtn');
  if (rejectBtn) rejectBtn.addEventListener('click', () => decide(quote.id, 'rejected'));

  const exportBtn = $('#exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', () => doExport(quote.id));

  const openFileBtn = $('#openFileBtn');
  const openFolderBtn = $('#openFolderBtn');
  if (openFileBtn && quote.exportRecord) {
    openFileBtn.addEventListener('click', () => window.api.openPath(quote.exportRecord.path));
  }
  if (openFolderBtn && quote.exportRecord) {
    openFolderBtn.addEventListener('click', () => window.api.openPath(quote.exportRecord.path));
  }
}

async function submitApproval(quoteId) {
  setStatusbar('正在提交审批…');
  const res = await window.api.submitForApproval({ actor: actorName(), role: state.role, quoteId });
  if (!res.ok) { toast(res.message, true); setStatusbar('提交失败：' + res.message); return; }
  state.currentQuote = res.quote;
  renderQuoteResult(res.quote);
  toast('已提交审批。');
  setStatusbar('已提交审批');
}

async function decide(quoteId, decision) {
  const comment = $('#approvalComment') ? $('#approvalComment').value.trim() : '';
  const res = await window.api.decideApproval({ actor: actorName(), role: state.role, quoteId, decision, comment });
  if (!res.ok) { toast(res.message, true); return; }
  state.currentQuote = res.quote;
  renderQuoteResult(res.quote);
  toast(decision === 'approved' ? '已通过审批。' : '已驳回。');
}

async function doExport(quoteId) {
  setStatusbar('正在生成正式报价文件…');
  const res = await window.api.exportAndArchive({ quoteId });
  if (!res.ok) { toast(res.message, true); setStatusbar('导出失败：' + res.message); return; }
  state.currentQuote = res.quote;
  renderQuoteResult(res.quote);
  toast('已生成正式报价并归档。');
  setStatusbar('已归档：' + res.filePath);
}

// ---------------------------------------------------------------------
// 右栏：依据与证据
// ---------------------------------------------------------------------
function renderEvidence(calc) {
  const box = $('#evidencePanel');
  if (!calc || calc.status !== 'ok') {
    box.innerHTML = '<div class="hint-text">规则阻断，暂无可用依据。</div>';
    return;
  }

  const closedCards = calc.evidence.closed.map((c) => `
    <div class="evidence-card">
      <div class="evid-head"><span>${c.id}</span><span class="badge badge-ok">已成交</span></div>
      <div>客户：${c.customer}</div>
      <div>数量：${c.qty} ｜ 地区：${c.region} ｜ 交期：${c.dueInDays} 天</div>
      <div>成交单价：${money(c.unitPrice)} ｜ 相似度：${c.similarityScore}</div>
    </div>`).join('');

  const openCards = calc.evidence.open.map((c) => `
    <div class="evidence-card open-case">
      <div class="evid-head"><span>${c.id}</span><span class="badge badge-muted">未成交 · 仅参考</span></div>
      <div>客户：${c.customer}</div>
      <div>${c.statusNote || '未成交，不计入成交均价'}</div>
      <div>报价单价：${money(c.unitPrice)} ｜ 相似度：${c.similarityScore}</div>
    </div>`).join('');

  box.innerHTML = `
    <div class="kv-row"><span>规则版本</span><span>${calc.ruleVersion}</span></div>
    <div class="kv-row"><span>成本数据时间</span><span>${fmtTime(calc.dataAsOf.cost)}</span></div>
    <div class="kv-row"><span>历史报价数据时间</span><span>${fmtTime(calc.dataAsOf.history)}</span></div>
    ${calc.evidence.insufficientHistory ? '<div class="badge badge-warn" style="margin:8px 0;">成交案例不足，建议价仅供参考</div>' : ''}
    <h4 style="margin-top:14px;">已成交案例</h4>
    ${closedCards || '<div class="hint-text">暂无</div>'}
    <h4>未成交参考（不计入定价）</h4>
    ${openCards || '<div class="hint-text">暂无</div>'}
  `;
}

// ---------------------------------------------------------------------
// 项目空间 / 归档
// ---------------------------------------------------------------------
async function loadArchiveView() {
  const quotes = await window.api.listQuotes(state.role);
  const tbody = $('#archiveTable tbody');
  if (quotes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="hint-text">暂无报价记录。</td></tr>';
    return;
  }
  tbody.innerHTML = quotes.map((q) => {
    const total = q.calculation && q.calculation.pricing ? money(q.calculation.pricing.appliedTotalPrice) : '—';
    const actions = q.exportRecord
      ? `<button class="btn btn-ghost" data-open="${encodeURIComponent(q.exportRecord.path)}">打开文件</button>`
      : `<button class="btn btn-ghost" data-view="${q.id}">查看</button>`;
    return `
      <tr>
        <td>${q.id}</td>
        <td>${q.confirmedItem.customer || '—'}</td>
        <td>${q.confirmedItem.productCode}</td>
        <td><span class="badge ${badgeClassForStatus(q.status)}">${STATUS_LABEL[q.status] || q.status}</span></td>
        <td>${total}</td>
        <td>${fmtTime(q.createdAt)}</td>
        <td>${actions}</td>
      </tr>`;
  }).join('');

  $all('[data-open]').forEach((btn) => btn.addEventListener('click', () => {
    window.api.openPath(decodeURIComponent(btn.dataset.open));
  }));
  $all('[data-view]').forEach((btn) => btn.addEventListener('click', async () => {
    const q = await window.api.getQuote(btn.dataset.view, state.role);
    state.currentQuote = q;
    state.currentFile = { file: q.sourceFile || { name: '（历史记录，原件信息不完整）' }, warnings: [], sheetName: '—', rows: [] };
    switchView('quote');
    $('#confirmForm').classList.add('hidden');
    $('#quoteFileInfo').innerHTML = `<div><strong>${q.sourceFile ? q.sourceFile.name : '历史报价'}</strong></div>`;
    renderQuoteResult(q);
    renderEvidence(q.calculation);
  }));
}

// ---------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------
async function loadAuditView() {
  const log = await window.api.listAuditLog();
  const tbody = $('#auditTable tbody');
  if (log.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="hint-text">暂无审计记录。</td></tr>';
    return;
  }
  tbody.innerHTML = log.map((e) => `
    <tr>
      <td>${e.seq}</td>
      <td>${fmtTime(e.at)}</td>
      <td>${e.actor}</td>
      <td>${e.action}</td>
      <td class="hint-text">${JSON.stringify(e.detail)}</td>
    </tr>`).join('');
}

// ---------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------
$all('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

(async function init() {
  await initDemoControls();
  await loadHomeView();
  setStatusbar('就绪');
})();
