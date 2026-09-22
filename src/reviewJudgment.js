// ============================================================
// 判定部分：擒纵叉瓦锁值复核的纯判定逻辑。
// 只依据登记的量测值给出结论，不校验绑定、不读写存档。
// 规则：缺项、锁值不在 0.02~0.05 毫米、牵引角低于 10 度 → 待保养。
// ============================================================

const LOCK_VALUE_MIN_MM = 0.02;
const LOCK_VALUE_MAX_MM = 0.05;
const DRAW_ANGLE_MIN_DEGREES = 10;

const RESULT_QUALIFIED = "合格";
const RESULT_PENDING_MAINTENANCE = "待保养";

function isMissing(value) {
  return value === undefined || value === null || value === "" || (typeof value === "number" && Number.isNaN(value));
}

// measurements: { palletJewelClearanceMm, lockValueMm, drawAngleDegrees }
// 返回 { result, reasons }，reasons 记录每一条不满足的原因。
function judgeReview(measurements) {
  const reasons = [];

  const missing = [];
  if (isMissing(measurements.palletJewelClearanceMm)) missing.push("托钻间隙");
  if (isMissing(measurements.lockValueMm)) missing.push("锁值");
  if (isMissing(measurements.drawAngleDegrees)) missing.push("牵引角");
  if (missing.length) {
    reasons.push(`缺项：${missing.join("、")}`);
  }

  if (!isMissing(measurements.lockValueMm)) {
    const lockValue = Number(measurements.lockValueMm);
    if (lockValue < LOCK_VALUE_MIN_MM || lockValue > LOCK_VALUE_MAX_MM) {
      reasons.push(`锁值${lockValue}毫米不在${LOCK_VALUE_MIN_MM}~${LOCK_VALUE_MAX_MM}毫米范围`);
    }
  }

  if (!isMissing(measurements.drawAngleDegrees)) {
    const drawAngle = Number(measurements.drawAngleDegrees);
    if (drawAngle < DRAW_ANGLE_MIN_DEGREES) {
      reasons.push(`牵引角${drawAngle}度低于${DRAW_ANGLE_MIN_DEGREES}度`);
    }
  }

  return {
    result: reasons.length ? RESULT_PENDING_MAINTENANCE : RESULT_QUALIFIED,
    reasons
  };
}

module.exports = {
  judgeReview,
  isMissing,
  LOCK_VALUE_MIN_MM,
  LOCK_VALUE_MAX_MM,
  DRAW_ANGLE_MIN_DEGREES,
  RESULT_QUALIFIED,
  RESULT_PENDING_MAINTENANCE
};
