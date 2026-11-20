'use strict';
/**
 * 本机客户需求 Excel 解析。
 *
 * 对应 PRD 6.2「Excel 解析包括多 Sheet、字段类型、日期、表头、合并单元格
 * 以及样本预览」与 8.2 步骤 1「解析客户需求并要求确认标准化产品映射」。
 *
 * 解析只在本机（Electron 主进程）完成，原始文件路径与字节内容不会传给
 * server.js／企业服务端；只有解析并经用户确认后的结构化字段才会进入后续
 * 报价计算与「发送给企业服务」的确认清单。
 */

const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

const HEADER_ALIASES = {
  customer: ['客户', '客户名称', 'customer', 'customername'],
  productCode: ['产品编号', '产品型号', '型号', '产品代码', 'productcode', 'model'],
  qty: ['数量', 'qty', 'quantity'],
  region: ['地区', '区域', 'region'],
  dueInDays: ['交期', '交期天数', '交付周期', 'leadtime', 'duedays'],
  dueDate: ['交付日期', '交期日期', 'duedate'],
  paymentTerms: ['付款条件', '付款方式', 'paymentterms']
};

function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase().replace(/[\s()（）]/g, '');
}

function buildFieldMapping(headerRow) {
  const mapping = {};
  const usedCols = new Set();
  const normalizedHeaders = headerRow.map((raw) => normalizeHeader(raw));

  // 第一遍：严格相等匹配，优先级最高，避免「产品型号」「型号」这类别名互相抢列。
  normalizedHeaders.forEach((norm, colIdx) => {
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (mapping[field] !== undefined || usedCols.has(colIdx)) continue;
      if (aliases.some((a) => norm === normalizeHeader(a))) {
        mapping[field] = colIdx;
        usedCols.add(colIdx);
      }
    }
  });

  // 第二遍：包含匹配兜底，覆盖「交期(天)」「数量(台)」这类带单位/修饰的真实表头。
  // 按别名长度从长到短尝试，降低短别名（如「型号」）抢占不相关列的概率。
  const fieldsByLongestAlias = Object.entries(HEADER_ALIASES)
    .map(([field, aliases]) => [field, [...aliases].sort((a, b) => b.length - a.length)]);

  normalizedHeaders.forEach((norm, colIdx) => {
    if (!norm || usedCols.has(colIdx)) return;
    for (const [field, aliases] of fieldsByLongestAlias) {
      if (mapping[field] !== undefined) continue;
      const hit = aliases.some((a) => {
        const na = normalizeHeader(a);
        return na.length >= 2 && (norm.includes(na) || na.includes(norm));
      });
      if (hit) {
        mapping[field] = colIdx;
        usedCols.add(colIdx);
        break;
      }
    }
  });

  return mapping;
}

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toDueInDays(cellValue, dueDateCellValue, asOfDate) {
  if (cellValue !== undefined && cellValue !== null && cellValue !== '') {
    const n = Number(cellValue);
    if (!Number.isNaN(n)) return Math.round(n);
  }
  if (dueDateCellValue) {
    let dueDate;
    if (dueDateCellValue instanceof Date) {
      dueDate = dueDateCellValue;
    } else if (typeof dueDateCellValue === 'number') {
      // Excel 序列日期
      dueDate = XLSX.SSF.parse_date_code(dueDateCellValue);
      dueDate = dueDate ? new Date(Date.UTC(dueDate.y, dueDate.m - 1, dueDate.d)) : null;
    } else {
      dueDate = new Date(dueDateCellValue);
    }
    if (dueDate && !Number.isNaN(dueDate.getTime())) {
      const diffMs = dueDate.getTime() - new Date(asOfDate).getTime();
      return Math.max(0, Math.round(diffMs / 86400000));
    }
  }
  return null;
}

/**
 * @param {string} filePath 本机文件绝对路径
 * @param {object} [options]
 * @param {string} [options.asOfDate] 解析基准日期（用于把交付日期换算为交期天数）
 * @returns {object} 解析结果，不包含原始文件字节内容
 */
function parseCustomerRequestExcel(filePath, options = {}) {
  const asOfDate = options.asOfDate || new Date().toISOString();
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const stat = fs.statSync(filePath);
  const sha256 = hashFile(filePath);

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    throw new Error('工作簿中没有任何工作表。');
  }
  const sheetName = sheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  if (grid.length === 0) {
    throw new Error('工作表为空。');
  }

  const headerRow = grid[0];
  const mapping = buildFieldMapping(headerRow);
  const requiredFields = ['customer', 'productCode', 'qty'];
  const missingRequired = requiredFields.filter((f) => mapping[f] === undefined);

  const warnings = [];
  if (missingRequired.length > 0) {
    warnings.push(`未能从表头自动识别字段：${missingRequired.join('、')}，请人工确认或手动填写。`);
  }
  if (sheetNames.length > 1) {
    warnings.push(`检测到 ${sheetNames.length} 个 Sheet，当前仅解析第一个「${sheetName}」，其余 Sheet 未处理。`);
  }

  const dataRows = grid.slice(1).filter((row) => row.some((c) => c !== null && c !== ''));

  const rows = dataRows.map((row, idx) => {
    const customerRaw = mapping.customer !== undefined ? row[mapping.customer] : null;
    const productCodeRaw = mapping.productCode !== undefined ? row[mapping.productCode] : null;
    const qtyRaw = mapping.qty !== undefined ? row[mapping.qty] : null;
    const regionRaw = mapping.region !== undefined ? row[mapping.region] : null;
    const paymentTermsRaw = mapping.paymentTerms !== undefined ? row[mapping.paymentTerms] : null;
    const dueInDaysRaw = mapping.dueInDays !== undefined ? row[mapping.dueInDays] : null;
    const dueDateRaw = mapping.dueDate !== undefined ? row[mapping.dueDate] : null;

    const productCode = productCodeRaw != null ? String(productCodeRaw).trim().toUpperCase() : null;
    const qty = qtyRaw != null && qtyRaw !== '' ? Number(qtyRaw) : null;
    const dueInDays = toDueInDays(dueInDaysRaw, dueDateRaw, asOfDate);

    const confirmNotes = [];
    if (!customerRaw) confirmNotes.push('客户名称缺失');
    if (!productCode) confirmNotes.push('产品编号缺失');
    if (qty == null || Number.isNaN(qty) || qty <= 0) confirmNotes.push('数量缺失或非法');
    if (dueInDays == null) confirmNotes.push('未能换算交期，请人工填写');

    return {
      rowIndex: idx + 2, // Excel 行号（含表头）
      customer: customerRaw != null ? String(customerRaw).trim() : null,
      productCodeRaw: productCodeRaw != null ? String(productCodeRaw).trim() : null,
      productCode,
      qty,
      region: regionRaw != null ? String(regionRaw).trim() : null,
      paymentTerms: paymentTermsRaw != null ? String(paymentTermsRaw).trim() : null,
      dueInDays,
      needsConfirmation: true, // PRD 8.2：标准化产品映射必须人工确认，不因解析成功而跳过
      confirmNotes
    };
  });

  return {
    file: {
      name: filePath.split(/[\\/]/).pop(),
      path: filePath,
      sizeBytes: stat.size,
      sha256,
      keptLocal: true
    },
    sheetName,
    sheetCount: sheetNames.length,
    headerRow,
    fieldMapping: mapping,
    warnings,
    rows
  };
}

module.exports = { parseCustomerRequestExcel, buildFieldMapping, normalizeHeader };
