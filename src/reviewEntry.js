// ============================================================
// 入口部分：接收复核提交，完成“钟表 + 当前调校 + 两名技师”的
// 绑定校验，并登记托钻间隙、锁值与牵引角三项量测。
// 量测缺项不在此处拒绝——保留记录并交判定部分转待保养。
// ============================================================

const { isMissing } = require("./reviewJudgment");

function entryError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 缺项或无法解析为数字的量测一律登记为 null（视为缺项）。
function normalizeMeasurement(value) {
  if (isMissing(value)) return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

// 每次复核必须绑定恰好两名不同技师。
function normalizeTechnicians(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = [...new Set(list.map((name) => String(name ?? "").trim()).filter(Boolean))];
  if (cleaned.length !== 2) {
    throw entryError("每次复核必须绑定两名不同技师（technicians 为两个姓名的数组）");
  }
  return cleaned;
}

// 组装复核草稿：绑定钟表与当前调校，登记三项量测。
function buildReviewDraft({ clock, currentAdjustment, body, id }) {
  if (!currentAdjustment) {
    throw entryError("该钟表当前没有调校记录，无法提交复核", 409);
  }
  return {
    id,
    clockId: clock.id,
    adjustmentId: currentAdjustment.id,
    technicians: normalizeTechnicians(body.technicians),
    palletJewelClearanceMm: normalizeMeasurement(body.palletJewelClearanceMm),
    lockValueMm: normalizeMeasurement(body.lockValueMm),
    drawAngleDegrees: normalizeMeasurement(body.drawAngleDegrees),
    note: body.note || "",
    createdAt: new Date().toISOString()
  };
}

module.exports = { buildReviewDraft, normalizeMeasurement, normalizeTechnicians };
