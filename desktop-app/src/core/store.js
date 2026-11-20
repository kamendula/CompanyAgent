'use strict';
/**
 * 极简本地持久化层。
 *
 * 设计意图：用「企业服务端」应当持有的权威记录（报价、审批、审计日志）在本
 * 地演示环境里落成人类可读的 JSON 文件，方便评审时直接打开查看，而不是
 * 隐藏在二进制数据库里。生产版本应替换为 PostgreSQL（见 PRD 第12节），
 * 这里的 JSON 文件边界与 server.js 的函数边界一一对应，替换时不需要改调
 * 用方代码。
 *
 * 不做并发写入保护：这是单用户桌面演示，真实多用户环境必须在服务端做。
 */

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  _file(name) {
    return path.join(this.baseDir, `${name}.json`);
  }

  readCollection(name) {
    const file = this._file(name);
    if (!fs.existsSync(file)) return [];
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return [];
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`读取本地存储 ${name}.json 失败：${err.message}`);
    }
  }

  writeCollection(name, records) {
    const file = this._file(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  upsert(name, record, idField = 'id') {
    const records = this.readCollection(name);
    const idx = records.findIndex((r) => r[idField] === record[idField]);
    if (idx >= 0) {
      records[idx] = record;
    } else {
      records.push(record);
    }
    this.writeCollection(name, records);
    return record;
  }

  find(name, idValue, idField = 'id') {
    return this.readCollection(name).find((r) => r[idField] === idValue) || null;
  }

  appendAudit(event) {
    const records = this.readCollection('audit_log');
    records.push({ ...event, seq: records.length + 1, at: new Date().toISOString() });
    this.writeCollection('audit_log', records);
    return records[records.length - 1];
  }
}

module.exports = { JsonStore };
