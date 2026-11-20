#!/usr/bin/env node
'use strict';
/**
 * 生成用于联调与演示的「客户需求 Excel」样例文件。
 * 两个场景：
 *   customer_request_sample.xlsx      —— 正常场景（WJ-2000，应能顺利算价）
 *   customer_request_unmatched.xlsx   —— 产品无法匹配场景（PRD 8.4 异常用例）
 */
const path = require('path');
const XLSX = require('xlsx');

function writeWorkbook(filePath, rows) {
  const header = ['客户名称', '产品型号', '数量', '地区', '交期(天)', '付款条件'];
  const data = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '需求清单');
  XLSX.writeFile(wb, filePath);
  console.log('已生成', filePath);
}

writeWorkbook(path.join(__dirname, 'customer_request_sample.xlsx'), [
  ['苏州某智能制造有限公司', 'WJ-2000', 55, '华东', 28, '月结30天']
]);

writeWorkbook(path.join(__dirname, 'customer_request_unmatched.xlsx'), [
  ['未知客户有限公司', 'ZZ-9999', 10, '华东', 15, '款到发货']
]);

writeWorkbook(path.join(__dirname, 'customer_request_low_margin.xlsx'), [
  ['压价集团采购部', 'SV-150', 300, '华东', 20, '款到发货']
]);
