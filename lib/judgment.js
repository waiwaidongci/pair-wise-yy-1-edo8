"use strict";

// ============================================================
// 业务部分二：判定（擒纵叉瓦锁值复核台）
// 纯函数模块：只依据登记的测量数据给出结论，不触碰网络与存储。
// 规则：
//   1. 托钻间隙、锁值、牵引角任一缺项 -> 转待保养（记录仍保留）；
//   2. 锁值须在 0.02 ~ 0.05 毫米之间（含边界）；
//   3. 牵引角不得低于 10 度；
//   4. 判定只产出复核自身状态，绝不改变钟表由复测得出的合格状态。
// ============================================================

const LOCK_VALUE_MIN_MM = 0.02;
const LOCK_VALUE_MAX_MM = 0.05;
const MIN_DRAW_ANGLE_DEG = 10;

const STATUS_QUALIFIED = "qualified";
const STATUS_PENDING_MAINTENANCE = "pending-maintenance";

const MEASUREMENT_FIELDS = [
  { key: "capJewelClearanceMm", label: "托钻间隙", unit: "毫米" },
  { key: "lockValueMm", label: "锁值", unit: "毫米" },
  { key: "drawAngleDegrees", label: "牵引角", unit: "度" }
];

function round4(value) {
  // 规避 0.020000000000000004 一类浮点表示误差
  return Math.round(value * 10000) / 10000;
}

function parseMeasurement(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: false, kind: "missing" };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { ok: false, kind: "not-a-number" };
  }
  return { ok: true, value: round4(num) };
}

function evaluateLockReview(raw = {}) {
  const measurements = {};
  const missingFields = [];
  const issues = [];

  for (const field of MEASUREMENT_FIELDS) {
    const parsed = parseMeasurement(raw[field.key]);
    if (!parsed.ok) {
      measurements[field.key] = null;
      if (parsed.kind === "missing") {
        missingFields.push(field.key);
        issues.push({ code: "missing", field: field.key, message: `${field.label}未登记（缺项）` });
      } else {
        issues.push({ code: "not-a-number", field: field.key, message: `${field.label}必须为数值` });
      }
      continue;
    }
    measurements[field.key] = parsed.value;
  }

  const lockValue = measurements.lockValueMm;
  if (lockValue !== null && (lockValue < LOCK_VALUE_MIN_MM || lockValue > LOCK_VALUE_MAX_MM)) {
    issues.push({
      code: "out-of-range",
      field: "lockValueMm",
      message: `锁值须在${LOCK_VALUE_MIN_MM}至${LOCK_VALUE_MAX_MM}毫米之间，实测${lockValue}毫米`
    });
  }

  const drawAngle = measurements.drawAngleDegrees;
  if (drawAngle !== null && drawAngle < MIN_DRAW_ANGLE_DEG) {
    issues.push({
      code: "below-minimum",
      field: "drawAngleDegrees",
      message: `牵引角不得低于${MIN_DRAW_ANGLE_DEG}度，实测${drawAngle}度`
    });
  }

  return {
    status: issues.length === 0 ? STATUS_QUALIFIED : STATUS_PENDING_MAINTENANCE,
    measurements,
    missingFields,
    issues
  };
}

module.exports = {
  LOCK_VALUE_MIN_MM,
  LOCK_VALUE_MAX_MM,
  MIN_DRAW_ANGLE_DEG,
  STATUS_QUALIFIED,
  STATUS_PENDING_MAINTENANCE,
  MEASUREMENT_FIELDS,
  evaluateLockReview
};
