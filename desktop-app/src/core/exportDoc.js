'use strict';
/**
 * 正式报价文件导出（PRD 8.2 步骤 7-8 / 10.2 文档中心）。
 *
 * 只有已审批通过的报价才允许调用（由 server.recordExport 在写入前二次校验）。
 * 导出内容包含依据来源、规则版本与审批记录，满足「可追溯性」非功能要求
 * （PRD 13）：正式报价 100% 关联来源、规则与审批版本。
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle
} = require('docx');

function cell(text, opts = {}) {
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: Boolean(opts.bold) })] })]
  });
}

function buildDocument(quote) {
  const calc = quote.calculation;
  const pricing = calc.pricing;
  const item = quote.confirmedItem;

  const headerBorder = { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' };
  const tableBorders = { top: headerBorder, bottom: headerBorder, left: headerBorder, right: headerBorder, insideHorizontal: headerBorder, insideVertical: headerBorder };

  const infoTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorders,
    rows: [
      new TableRow({ children: [cell('客户', { bold: true, width: 20 }), cell(item.customer, { width: 30 }), cell('报价编号', { bold: true, width: 20 }), cell(quote.id, { width: 30 })] }),
      new TableRow({ children: [cell('产品', { bold: true }), cell(`${calc.product.name}（${calc.product.code}）`), cell('数量', { bold: true }), cell(`${item.qty} ${calc.product.unit || ''}`)] }),
      new TableRow({ children: [cell('地区', { bold: true }), cell(item.region || '未填写'), cell('交期', { bold: true }), cell(item.dueInDays != null ? `${item.dueInDays} 天` : '未填写')] }),
      new TableRow({ children: [cell('付款条件', { bold: true }), cell(item.paymentTerms || '未填写'), cell('报价日期', { bold: true }), cell(new Date(quote.createdAt).toLocaleDateString('zh-CN'))] })
    ]
  });

  const priceTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorders,
    rows: [
      new TableRow({ children: [cell('项目', { bold: true, width: 40 }), cell('金额 / 说明', { bold: true, width: 60 })] }),
      new TableRow({ children: [cell('建议单价'), cell(`¥${pricing.suggestedUnitPrice.toLocaleString('zh-CN')}`)] }),
      new TableRow({ children: [cell('正式单价'), cell(`¥${pricing.appliedUnitPrice.toLocaleString('zh-CN')}`)] }),
      new TableRow({ children: [cell('总价'), cell(`¥${pricing.appliedTotalPrice.toLocaleString('zh-CN')}`)] }),
      new TableRow({ children: [cell('毛利是否达标'), cell(pricing.marginMeetsFloor ? `达标（毛利率 ${(pricing.margin * 100).toFixed(1)}%）` : `未达标，已走强制升级审批（毛利率 ${(pricing.margin * 100).toFixed(1)}%）`)] })
    ]
  });

  const evidenceLines = calc.evidence.closed.map(
    (c) => `· ${c.id} ｜ 客户：${c.customer} ｜ 数量：${c.qty} ｜ 地区：${c.region} ｜ 成交单价：¥${c.unitPrice.toLocaleString('zh-CN')} ｜ 相似度：${c.similarityScore}`
  );

  const children = [
    new Paragraph({ text: '企业正式报价单', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: `Enterprise AI Workspace · 智能报价助手生成 · ${new Date().toLocaleString('zh-CN')}`, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: '' }),
    infoTable,
    new Paragraph({ text: '' }),
    new Paragraph({ text: '报价结果', heading: HeadingLevel.HEADING_2 }),
    priceTable,
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'AI 依据说明', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun(calc.explanation)] }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: '引用的历史成交案例（仅成交记录，未成交报价不计入定价依据）', heading: HeadingLevel.HEADING_2 }),
    ...(evidenceLines.length > 0
      ? evidenceLines.map((l) => new Paragraph({ text: l }))
      : [new Paragraph({ text: '（历史成交案例不足，建议价仅基于成本加成规则给出，已在审批中特别标注）' })]),
    new Paragraph({ text: '' }),
    new Paragraph({ text: '审批与版本追溯', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: `定价规则版本：${calc.ruleVersion}` }),
    new Paragraph({ text: `成本数据时间：${calc.dataAsOf.cost}` }),
    new Paragraph({ text: `历史报价数据时间：${calc.dataAsOf.history}` }),
    new Paragraph({ text: `提交人：${quote.approval.submittedBy} ｜ 提交时间：${new Date(quote.approval.submittedAt).toLocaleString('zh-CN')}` }),
    new Paragraph({ text: `审批人：${quote.approval.decidedBy} ｜ 审批结论：${quote.approval.decision === 'approved' ? '通过' : '驳回'} ｜ 审批时间：${new Date(quote.approval.decidedAt).toLocaleString('zh-CN')}` }),
    ...(quote.approval.comment ? [new Paragraph({ text: `审批意见：${quote.approval.comment}` })] : []),
    new Paragraph({ text: '' }),
    new Paragraph({
      children: [new TextRun({
        text: '本文件由 Enterprise AI Workspace 桌面客户端生成，原始客户需求文件保留在本机，未上传企业服务器；' +
          '本文件内容与计算过程可依据上述规则版本与数据时间复核。',
        italics: true,
        size: 18
      })]
    })
  ];

  return new Document({ sections: [{ children }] });
}

async function exportQuoteDocx(quote, archiveDir) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const doc = buildDocument(quote);
  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join(archiveDir, `${quote.id}_正式报价.docx`);
  fs.writeFileSync(filePath, buffer);

  const manifestPath = path.join(archiveDir, `${quote.id}_manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(quote, null, 2), 'utf8');

  return { filePath, manifestPath };
}

module.exports = { exportQuoteDocx };
