'use strict';

/**
 * 通知免打扰时段判定（纯函数，便于测试）。
 *
 * 设置项（main/settings.js DEFAULTS）：
 *   quietHoursEnabled: false,   // 是否启用免打扰
 *   quietHoursStart:  '23:00',  // 开始时间（"HH:MM"，24 小时制）
 *   quietHoursEnd:    '07:00',  // 结束时间（"HH:MM"，24 小时制）
 *
 * 语义：
 *   - start < end（如 07:00-23:00）：[start, end) 内为免打扰；
 *   - start > end（如 23:00-07:00）：跨午夜，[start, 24:00) ∪ [00:00, end) 内为免打扰；
 *   - start === end：视为全天免打扰（任何时刻都命中）；
 *   - 未启用或时间非法（非 "HH:MM"、超出 00:00-23:59）→ 一律 false。
 * 边界：开始时刻命中（含），结束时刻不命中（不含）。
 */

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** 解析 "HH:MM" 为当天分钟数（0-1439）；非法返回 null。 */
function parseTime(text) {
  if (typeof text !== 'string') return null;
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 判断 now 是否处于免打扰时段。
 * @param {object} cfg { enabled, start, end }
 * @param {Date|number|string} [now] 默认 new Date()；接受 Date、时间戳或 "HH:MM"（测试用）
 * @returns {boolean}
 */
function inQuietHours(cfg, now) {
  if (!cfg || cfg.enabled !== true) return false;
  const start = parseTime(cfg.start);
  const end = parseTime(cfg.end);
  if (start === null || end === null) return false;
  if (start === end) return true; // 全天免打扰

  let minutes;
  if (now instanceof Date) minutes = now.getHours() * 60 + now.getMinutes();
  else if (typeof now === 'number') {
    const d = new Date(now);
    minutes = d.getHours() * 60 + d.getMinutes();
  } else if (typeof now === 'string') {
    const t = parseTime(now);
    if (t === null) return false;
    minutes = t;
  } else {
    const d = new Date();
    minutes = d.getHours() * 60 + d.getMinutes();
  }

  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // 跨午夜
}

module.exports = { inQuietHours, parseTime };
