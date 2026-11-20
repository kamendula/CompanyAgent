'use strict';
/**
 * 极简角色与权限模型（P0 演示用）。
 *
 * 对应 PRD 2「用户角色与核心场景」与 8.4「成本无查看权限只返回授权计算
 * 结论，不泄露原始成本」。真实系统的身份来自企业 SSO + RBAC/ABAC
 * （PRD 11.1），这里只保留判定接口，方便后续替换为真实身份源而不改调用方。
 */

const ROLES = {
  SALES: 'sales',
  MANAGER: 'manager',
  FINANCE: 'finance',
  DATA_ADMIN: 'data_admin'
};

const ROLE_LABELS = {
  [ROLES.SALES]: '销售专员',
  [ROLES.MANAGER]: '销售经理（审批人）',
  [ROLES.FINANCE]: '财务 / 业务管理员',
  [ROLES.DATA_ADMIN]: '数据管理员'
};

function canViewRawCost(role) {
  return role === ROLES.MANAGER || role === ROLES.FINANCE || role === ROLES.DATA_ADMIN;
}

function canApprove(role) {
  return role === ROLES.MANAGER || role === ROLES.FINANCE;
}

module.exports = { ROLES, ROLE_LABELS, canViewRawCost, canApprove };
