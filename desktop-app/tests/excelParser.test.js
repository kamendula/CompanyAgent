'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseCustomerRequestExcel } = require('../src/core/excelParser');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample-data');

test('解析正常客户需求 Excel：字段齐全、原件信息完整、需要人工确认映射', () => {
  const result = parseCustomerRequestExcel(path.join(SAMPLE_DIR, 'customer_request_sample.xlsx'));
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.customer, '苏州某智能制造有限公司');
  assert.equal(row.productCode, 'WJ-2000');
  assert.equal(row.qty, 55);
  assert.equal(row.region, '华东');
  assert.equal(row.dueInDays, 28);
  assert.equal(row.paymentTerms, '月结30天');
  assert.equal(row.needsConfirmation, true, 'PRD 8.2 要求标准化产品映射必须人工确认');
  assert.equal(row.confirmNotes.length, 0);

  assert.equal(result.file.keptLocal, true);
  assert.ok(result.file.sha256 && result.file.sha256.length === 64, '应计算原件哈希用于留痕，但不应把文件内容本身发往服务端');
  assert.equal(result.file.path, path.join(SAMPLE_DIR, 'customer_request_sample.xlsx'));
});

test('产品无法匹配场景：解析仍可完成，交由后续规则引擎判定', () => {
  const result = parseCustomerRequestExcel(path.join(SAMPLE_DIR, 'customer_request_unmatched.xlsx'));
  const row = result.rows[0];
  assert.equal(row.productCode, 'ZZ-9999');
  assert.equal(row.confirmNotes.length, 0, '字段本身完整，是否存在于产品目录由计算层判断，不是解析层');
});

test('缺失关键字段时给出告警且标记需要确认', () => {
  const XLSX = require('xlsx');
  const fs = require('fs');
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `eaw-missing-${Date.now()}.xlsx`);
  const ws = XLSX.utils.aoa_to_sheet([
    ['客户名称', '产品型号', '数量'],
    ['', 'WJ-2000', '']
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'sheet1');
  XLSX.writeFile(wb, tmpFile);

  const result = parseCustomerRequestExcel(tmpFile);
  const row = result.rows[0];
  assert.ok(row.confirmNotes.includes('客户名称缺失'));
  assert.ok(row.confirmNotes.includes('数量缺失或非法'));

  fs.unlinkSync(tmpFile);
});
