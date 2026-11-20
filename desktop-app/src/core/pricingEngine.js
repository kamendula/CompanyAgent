'use strict';
/**
 * 报价规则计算服务（PRD 8.2 步骤 3-5 / 8.3 / 8.4）。
 *
 * 这是一个纯计算模块：输入确认后的标准化字段、成本目录、历史报价和定价
 * 规则，输出建议价格、约束结果与可审计的依据说明。它本身不做权限裁剪——
 * 「销售看不到原始成本」属于访问控制，由 server.js 的网关层在调用方角色
 * 已知的前提下对返回结果做裁剪（对应 PRD 12.2 AI Data Gateway 的边界）。
 *
 * 价格解释文本由模板基于真实计算结果拼接生成，不经过大模型调用：这样每
 * 一句话都能直接对应到下面的数字，满足「算法与字段权重应可审计」的要求；
 * 后续若接入模型做更自然的表达，也必须以这里算出的事实为唯一依据。
 */

const { rankHistoricalQuotes } = require('./similarity');

const EXCEPTIONS = {
  PRODUCT_NOT_MATCHED: 'PRODUCT_NOT_MATCHED',
  COST_SOURCE_UNAVAILABLE: 'COST_SOURCE_UNAVAILABLE',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY',
  MARGIN_BELOW_FLOOR: 'MARGIN_BELOW_FLOOR'
};

function round(value, step) {
  if (!step) return Math.round(value * 100) / 100;
  return Math.round(value / step) * step;
}

function average(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function buildExplanation({ item, closedTop, openTop, unitCost, suggestedUnitPrice, targetMargin, closedAvg, costAsOf, historyAsOf, insufficientHistory }) {
  const lines = [];
  lines.push(
    `按成本 ¥${unitCost.toLocaleString('zh-CN')}/${item.unit || '单位'}（来源：ERP 示例环境，数据时间 ${costAsOf}）与目标毛利 ${(targetMargin * 100).toFixed(0)}%，` +
    `规则计算建议单价为 ¥${suggestedUnitPrice.toLocaleString('zh-CN')}。`
  );

  if (insufficientHistory) {
    lines.push(
      `在可访问的历史数据（数据时间 ${historyAsOf}）中，该产品的已成交案例少于 ${closedTop.minRequired} 条，不足以形成可信的成交参考价，` +
      `以上建议价仅基于成本加成规则给出，请业务人员结合实际情况人工复核。`
    );
  } else if (closedAvg != null) {
    const diffPct = ((suggestedUnitPrice - closedAvg) / closedAvg) * 100;
    const direction = diffPct >= 0 ? '高于' : '低于';
    lines.push(
      `与近期 ${closedTop.items.length} 条已成交案例（${closedTop.items.map((c) => c.id).join('、')}）的成交均价 ¥${closedAvg.toFixed(0)} 相比，` +
      `建议单价${direction}成交均价 ${Math.abs(diffPct).toFixed(1)}%。`
    );
    const top = closedTop.items[0];
    if (top) {
      lines.push(
        `相似度最高的成交案例为 ${top.id}（客户：${top.customer}，数量 ${top.qty}，地区 ${top.region}，` +
        `成交单价 ¥${top.unitPrice.toLocaleString('zh-CN')}，相似度评分 ${top.similarityScore}）。`
      );
    }
  }

  if (openTop.length > 0) {
    lines.push(
      `另有 ${openTop.length} 条相似但「未成交」的历史报价（${openTop.map((c) => c.id).join('、')}）仅作参考，` +
      `已从成交均价计算中剔除，不作为定价依据。`
    );
  }

  return lines.join(' ');
}

/**
 * @param {object} args
 * @param {object} args.item 标准化后的报价请求字段 {productCode, qty, region, dueInDays, paymentTerms}
 * @param {object} args.costCatalog sample-data/cost_catalog.json 的内容
 * @param {object} args.historicalQuotes sample-data/historical_quotes.json 的内容
 * @param {object} args.policy sample-data/pricing_policy.json 的内容
 * @param {string} [args.asOfDate] 计算基准时间
 * @param {number} [args.manualUnitPrice] 销售人工调整后的单价（如提供，margin 基于此重新核验）
 */
function calculateQuote(args) {
  const { item, costCatalog, historicalQuotes, policy } = args;
  const asOfDate = args.asOfDate || new Date().toISOString();
  const exceptions = [];

  const catalogItem = costCatalog.items[item.productCode];
  if (!catalogItem) {
    exceptions.push(EXCEPTIONS.PRODUCT_NOT_MATCHED);
    return {
      status: 'blocked',
      exceptions,
      message: `产品编号「${item.productCodeRaw || item.productCode}」未能匹配到标准产品目录，不得强行定价，请业务人员确认正确的产品型号。`
    };
  }

  if (costCatalog.available === false) {
    exceptions.push(EXCEPTIONS.COST_SOURCE_UNAVAILABLE);
    return {
      status: 'blocked',
      exceptions,
      message: `成本数据源当前不可用（最近一次成功数据时间：${costCatalog.asOf}），系统不会使用过期缓存值静默计算，请稍后重试或转人工处理。`
    };
  }

  const ranked = rankHistoricalQuotes(item, historicalQuotes.items, policy.similarityWeights, asOfDate);
  const closedAll = ranked.filter((q) => q.status === 'closed').slice(0, 5);
  const openAll = ranked.filter((q) => q.status === 'open').slice(0, 3);
  const insufficientHistory = closedAll.length < policy.minClosedCasesForTrustedReference;
  if (insufficientHistory) exceptions.push(EXCEPTIONS.INSUFFICIENT_HISTORY);

  const unitCost = catalogItem.unitCost;
  const suggestedUnitPrice = round(unitCost / (1 - policy.targetMargin), policy.roundingStep);
  const suggestedTotalPrice = round(suggestedUnitPrice * item.qty, 1);

  const closedAvg = average(closedAll.map((q) => q.unitPrice));

  const basePrice = args.manualUnitPrice != null ? args.manualUnitPrice : suggestedUnitPrice;
  const margin = (basePrice - unitCost) / basePrice;
  const marginMeetsFloor = margin >= policy.marginFloor;
  if (!marginMeetsFloor) exceptions.push(EXCEPTIONS.MARGIN_BELOW_FLOOR);

  const explanation = buildExplanation({
    item,
    closedTop: { items: closedAll, minRequired: policy.minClosedCasesForTrustedReference },
    openTop: openAll,
    unitCost,
    suggestedUnitPrice,
    targetMargin: policy.targetMargin,
    closedAvg,
    costAsOf: costCatalog.asOf,
    historyAsOf: historicalQuotes.asOf,
    insufficientHistory
  });

  return {
    status: 'ok',
    exceptions,
    ruleVersion: policy.ruleVersion,
    dataAsOf: { cost: costCatalog.asOf, history: historicalQuotes.asOf },
    product: { code: item.productCode, name: catalogItem.name, unit: catalogItem.unit },
    cost: { unitCost, stockQty: catalogItem.stockQty, sourceSystem: costCatalog.sourceSystem },
    pricing: {
      suggestedUnitPrice,
      suggestedTotalPrice,
      appliedUnitPrice: basePrice,
      appliedTotalPrice: round(basePrice * item.qty, 1),
      targetMargin: policy.targetMargin,
      marginFloor: policy.marginFloor,
      margin: Number(margin.toFixed(4)),
      marginMeetsFloor
    },
    evidence: {
      closed: closedAll,
      open: openAll,
      closedAverageUnitPrice: closedAvg,
      insufficientHistory
    },
    explanation,
    approval: {
      required: true, // 首版规则：每一笔正式报价都需经理审批留痕（PRD「正式报价需保留审批记录」）
      escalated: !marginMeetsFloor,
      reasons: [
        !marginMeetsFloor ? 'MARGIN_BELOW_FLOOR：毛利低于底线，按规则强制升级审批，AI/系统不得自主确认。' : null,
        insufficientHistory ? 'INSUFFICIENT_HISTORY：成交案例不足，建议价仅供参考，需人工复核。' : null
      ].filter(Boolean)
    }
  };
}

module.exports = { calculateQuote, EXCEPTIONS };
