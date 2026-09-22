// ============================================================
// 存档部分：复核记录的落库、相同人员/并发重复的沿用、
// 失效处理与历史查询。已失效记录只标记不删除，历史始终可查。
// ============================================================

const { RESULT_PENDING_MAINTENANCE } = require("./reviewJudgment");

// 人员键与顺序无关，便于“相同人员”判定。
function technicianKey(technicians) {
  return [...technicians].sort().join("||");
}

// 相同人员（同钟表、同调校、同两名技师）或并发重复提交时，
// 返回仍然有效的首次复核结果；没有可沿用的记录时返回 null。
function findReusableReview(db, { clockId, adjustmentId, technicians }) {
  const key = technicianKey(technicians);
  const candidates = db.reviews
    .filter((review) =>
      review.clockId === clockId &&
      review.adjustmentId === adjustmentId &&
      review.valid !== false &&
      technicianKey(review.technicians || []) === key
    )
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return candidates[0] || null;
}

function saveReview(db, review) {
  db.reviews.push(review);
  return review;
}

// 更换擒纵部件或更正调校后，该钟表全部有效复核标记失效，返回失效条数。
function invalidateReviews(db, clockId, reason) {
  const now = new Date().toISOString();
  let invalidated = 0;
  for (const review of db.reviews) {
    if (review.clockId === clockId && review.valid !== false) {
      review.valid = false;
      review.invalidatedAt = now;
      review.invalidateReason = reason;
      invalidated += 1;
    }
  }
  return invalidated;
}

// 全部复核历史（含已失效），新的在前。
function reviewsOf(db, clockId) {
  return db.reviews
    .filter((review) => review.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function latestValidReview(db, clockId) {
  return reviewsOf(db, clockId).find((review) => review.valid !== false) || null;
}

// 最新有效复核为待保养时，钟表处于待保养状态（不影响合格状态）。
function pendingMaintenance(db, clockId) {
  const review = latestValidReview(db, clockId);
  return Boolean(review && review.result === RESULT_PENDING_MAINTENANCE);
}

module.exports = {
  technicianKey,
  findReusableReview,
  saveReview,
  invalidateReviews,
  reviewsOf,
  latestValidReview,
  pendingMaintenance
};
