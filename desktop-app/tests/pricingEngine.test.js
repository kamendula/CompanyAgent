'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { calculateQuote, EXCEPTIONS } = require('../src/core/pricingEngine');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample-data');

function loadFixtures() {
  return {
    costCatalog: JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'cost_catalog.json'), 'utf8')),
    historicalQuotes: JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'historical_quotes.json'), 'utf8')),
    policy: JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'pricing_policy.json'), 'utf8'))
  };
}

test('正常场景：WJ-2000 命中两条成交案例，不把未成交报价计入成交均价', () => {
  const { costCatalog, historicalQuotes, policy } = loadFixtures();
  const result = calculateQuote({
    item: { productCode: 'WJ-2000', qty: 55, region: '华东', dueInDays: 28, paymentTerms: '月结30天' },
    costCatalog, historicalQuotes, policy
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.exceptions.includes(EXCEPTIONS.INSUFFICIENT_HISTORY), false);

  const closedIds = result.evidence.closed.map((q) => q.id);
  assert.ok(closedIds.includes('Q-24087'));
  assert.ok(closedIds.includes('Q-24090'));
  assert.equal(closedIds.includes('Q-24091'), false, 'Q-24091 是未成交报价，不应出现在成交均价依据里');

  assert.equal(result.evidence.closedAverageUnitPrice, (16800 + 16500) / 2);
  assert.ok(result.explanation.includes('成交均价'));
  assert.ok(result.explanation.includes('未成交'));

  // 成本加成公式：12500 / (1 - 0.28)
  const expectedPrice = Math.round(12500 / (1 - 0.28));
  assert.equal(result.pricing.suggestedUnitPrice, expectedPrice);
  assert.ok(Math.abs(result.pricing.margin - 0.28) < 0.001);
  assert.equal(result.pricing.marginMeetsFloor, true);
  assert.equal(result.approval.escalated, false);
});

test('产品无法匹配：不强行定价', () => {
  const { costCatalog, historicalQuotes, policy } = loadFixtures();
  const result = calculateQuote({
    item: { productCode: 'ZZ-9999', productCodeRaw: 'ZZ-9999', qty: 10 },
    costCatalog, historicalQuotes, policy
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.exceptions.includes(EXCEPTIONS.PRODUCT_NOT_MATCHED));
  assert.ok(result.message.includes('不得强行定价'));
});

test('成本源不可用：不得静默复用旧值', () => {
  const { costCatalog, historicalQuotes, policy } = loadFixtures();
  const unavailableCatalog = { ...costCatalog, available: false };
  const result = calculateQuote({
    item: { productCode: 'WJ-2000', qty: 55 },
    costCatalog: unavailableCatalog, historicalQuotes, policy
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.exceptions.includes(EXCEPTIONS.COST_SOURCE_UNAVAILABLE));
  assert.ok(result.message.includes(costCatalog.asOf), '应明确展示数据时间，而不是悄悄用旧值');
});

test('历史成交案例不足：仍给出规则建议价，但明确标记数据不足', () => {
  const { costCatalog, historicalQuotes, policy } = loadFixtures();
  // SV-300 在样例数据中只有 1 条「未成交」记录，没有成交案例
  const result = calculateQuote({
    item: { productCode: 'SV-300', qty: 15, region: '华南', dueInDays: 30, paymentTerms: '月结30天' },
    costCatalog, historicalQuotes, policy
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.exceptions.includes(EXCEPTIONS.INSUFFICIENT_HISTORY));
  assert.equal(result.evidence.closed.length, 0);
  assert.ok(result.explanation.includes('不足以形成可信的成交参考价'));
  assert.ok(result.approval.reasons.some((r) => r.includes('INSUFFICIENT_HISTORY')));
});

test('毛利触及底线：强制升级审批，不允许系统自主确认', () => {
  const { costCatalog, historicalQuotes, policy } = loadFixtures();
  // 人工把单价压到接近成本，制造毛利跌破底线的场景
  const result = calculateQuote({
    item: { productCode: 'WJ-2000', qty: 55, region: '华东', dueInDays: 28, paymentTerms: '月结30天' },
    costCatalog, historicalQuotes, policy,
    manualUnitPrice: 13500 // margin = (13500-12500)/13500 ≈ 7.4%，低于 20% 底线
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.pricing.marginMeetsFloor, false);
  assert.ok(result.exceptions.includes(EXCEPTIONS.MARGIN_BELOW_FLOOR));
  assert.equal(result.approval.escalated, true);
  assert.ok(result.approval.reasons.some((r) => r.includes('MARGIN_BELOW_FLOOR')));
});
