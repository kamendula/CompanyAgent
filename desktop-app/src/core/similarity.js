'use strict';
/**
 * 报价相似度评分。
 *
 * 对应 PRD 8.3：相似度需要考虑产品型号与配置、数量、地区、交期、客户类别、
 * 付款条件、报价日期和成交状态；算法与字段权重必须可审计。
 *
 * 实现为纯函数、确定性加权打分，不依赖模型推理，权重来自
 * sample-data/pricing_policy.json，可在试点中由业务方直接调整 JSON 复核。
 */

function quantityProximity(a, b) {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.min(a, b) / Math.max(a, b);
  return ratio; // 1 表示数量完全一致，越接近 0 表示差距越大
}

function dueDateProximity(a, b) {
  if (a == null || b == null) return 0.5; // 信息缺失时给中性分，不臆断
  const diff = Math.abs(a - b);
  return Math.max(0, 1 - diff / 60); // 60 天以上差异记 0 分
}

function recencyScore(quoteDateStr, refDateStr) {
  const quoteDate = new Date(quoteDateStr).getTime();
  const refDate = new Date(refDateStr).getTime();
  if (Number.isNaN(quoteDate) || Number.isNaN(refDate)) return 0.3;
  const ageDays = Math.max(0, (refDate - quoteDate) / 86400000);
  return Math.max(0, 1 - ageDays / 365); // 一年以上的报价记 0 分
}

/**
 * @param {object} target 当前报价请求的标准化字段
 * @param {object} candidate 历史报价记录
 * @param {object} weights pricing_policy.json 中的 similarityWeights
 * @param {string} asOfDate 数据快照时间，用于计算新鲜度
 * @returns {{score:number, breakdown:object}}
 */
function scoreSimilarity(target, candidate, weights, asOfDate) {
  const productMatch = target.productCode === candidate.productCode ? 1 : 0;
  const qtyScore = quantityProximity(target.qty, candidate.qty);
  const regionMatch = target.region && candidate.region && target.region === candidate.region ? 1 : 0;
  const dueScore = dueDateProximity(target.dueInDays, candidate.dueInDays);
  const paymentMatch = target.paymentTerms && candidate.paymentTerms && target.paymentTerms === candidate.paymentTerms ? 1 : 0;
  const recency = recencyScore(candidate.quoteDate, asOfDate);

  const breakdown = {
    productMatch, qtyScore, regionMatch, dueScore, paymentMatch, recency
  };

  const score =
    weights.productMatch * productMatch +
    weights.quantityProximity * qtyScore +
    weights.regionMatch * regionMatch +
    weights.dueDateProximity * dueScore +
    weights.paymentTermsMatch * paymentMatch +
    weights.recency * recency;

  return { score: Number(score.toFixed(4)), breakdown };
}

function rankHistoricalQuotes(target, historicalQuotes, weights, asOfDate) {
  return historicalQuotes
    .filter((q) => q.productCode === target.productCode)
    .map((q) => {
      const { score, breakdown } = scoreSimilarity(target, q, weights, asOfDate);
      return { ...q, similarityScore: score, similarityBreakdown: breakdown };
    })
    .sort((a, b) => b.similarityScore - a.similarityScore);
}

module.exports = { scoreSimilarity, rankHistoricalQuotes };
