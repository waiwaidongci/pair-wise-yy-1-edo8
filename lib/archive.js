"use strict";

// ============================================================
// 业务部分三：存档（擒纵叉瓦锁值复核台）
// 负责复核记录的写入、查询，以及旧复核的失效。
// 规则：
//   1. 每次复核都落库（包括待保养记录），历史永远可查；
//   2. 更换擒纵部件（escapementReplacement）或更正调校
//      （新增调校记录）后，该钟表原有效复核全部失效；
//   3. 失效采用软失效：supersededAt/supersededReason 留痕，
//      历史仍可查，但只有 valid 的记录代表当前调校下的结论；
//   4. 同钟表、同调校、同两名技师已有有效复核时，沿用首次结果。
// ============================================================

function byReviewedAtDesc(a, b) {
  return new Date(b.reviewedAt) - new Date(a.reviewedAt);
}

function reviewsOf(db, clockId) {
  return db.lockReviews.filter((item) => item.clockId === clockId);
}

function allReviews(db) {
  return [...db.lockReviews].sort(byReviewedAtDesc);
}

function findReview(db, reviewId) {
  return db.lockReviews.find((item) => item.id === reviewId) || null;
}

// 当前调校（最新一条调校）下的有效复核
function currentValidReviews(db, clockId, adjustmentId) {
  return reviewsOf(db, clockId)
    .filter((item) => item.adjustmentId === adjustmentId && item.valid)
    .sort(byReviewedAtDesc);
}

function latestValidReview(db, clockId, adjustmentId) {
  return currentValidReviews(db, clockId, adjustmentId)[0] || null;
}

function findExistingValidReview(db, { clockId, adjustmentId, technicianIds }) {
  const [first, second] = technicianIds;
  // 人员顺序无关：两名技师相同即视为同一组人员
  return (
    reviewsOf(db, clockId).find(
      (item) =>
        item.valid &&
        item.adjustmentId === adjustmentId &&
        ((item.technicianIds[0] === first && item.technicianIds[1] === second) ||
          (item.technicianIds[0] === second && item.technicianIds[1] === first))
    ) || null
  );
}

function saveLockReview(db, review) {
  db.lockReviews.push(review);
  return review;
}

// 旧复核失效。更换擒纵部件或更正调校时调用。
function invalidateForClock(db, clockId, reason) {
  const now = new Date().toISOString();
  let count = 0;
  for (const review of reviewsOf(db, clockId)) {
    if (review.valid) {
      review.valid = false;
      review.supersededAt = now;
      review.supersededReason = reason;
      count += 1;
    }
  }
  return count;
}

function history(db, clockId) {
  const reviews = reviewsOf(db, clockId).sort(byReviewedAtDesc);
  const replacements = (db.escapementReplacements || [])
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.replacedAt) - new Date(a.replacedAt));
  const latestAdjustment =
    db.adjustments
      .filter((item) => item.clockId === clockId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  const current = latestAdjustment
    ? latestValidReview(db, clockId, latestAdjustment.id)
    : null;
  return { reviews, replacements, latestAdjustment, currentReview: current };
}

module.exports = {
  reviewsOf,
  allReviews,
  findReview,
  currentValidReviews,
  latestValidReview,
  findExistingValidReview,
  saveLockReview,
  invalidateForClock,
  history
};
