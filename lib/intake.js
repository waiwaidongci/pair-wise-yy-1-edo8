"use strict";

const crypto = require("crypto");
const { evaluateLockReview, STATUS_QUALIFIED } = require("./judgment");
const archive = require("./archive");

// ============================================================
// 业务部分一：入口（擒纵叉瓦锁值复核台）
// 职责：
//   1. 校验并绑定钟表、当前调校、两名技师；
//   2. 解析托钻间隙/锁值/牵引角，交给判定模块出结论；
//   3. 组装复核记录交给存档模块；
//   4. 同人员重复提交沿用首次结果；并发重复提交合并到在途的首次提交。
// 入口不直接写文件，所有变更在 db 对象上完成后由 server.js 统一落盘。
// ============================================================

function makeError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function latestAdjustment(db, clockId) {
  return (
    db.adjustments
      .filter((item) => item.clockId === clockId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
  );
}

function findTechnician(db, technicianId) {
  return db.technicians.find((item) => item.id === technicianId) || null;
}

// 解析并校验：钟表 + 当前调校 + 两名不同的在岗技师
function resolveBinding(db, clock, body) {
  const technicianIds = [body.leadTechnicianId, body.assistantTechnicianId].filter(
    (value) => value !== undefined && value !== null && value !== ""
  );

  if (technicianIds.length < 2) {
    throw makeError(400, "每次复核须登记两名技师：主技师与复核技师");
  }

  const lead = findTechnician(db, technicianIds[0]);
  const assistant = findTechnician(db, technicianIds[1]);
  if (!lead || !assistant) {
    throw makeError(400, "技师不存在或未在人员册中登记");
  }
  if (lead.id === assistant.id) {
    throw makeError(400, "两名技师不能为同一人，须双人复核");
  }
  if (lead.active === false || assistant.active === false) {
    throw makeError(400, "技师已离岗，不能执行复核");
  }

  const adjustment = latestAdjustment(db, clock.id);
  if (!adjustment) {
    throw makeError(409, "该钟表尚无调校记录，无法绑定当前调校");
  }
  if (body.adjustmentId && body.adjustmentId !== adjustment.id) {
    throw makeError(409, "指定调校已不是当前调校，请按最新调校重新复核");
  }

  return {
    adjustment,
    technicians: [lead, assistant],
    technicianIds: [lead.id, assistant.id]
  };
}

function makeReviewId() {
  return `lock_review_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// 无显式幂等键时，用绑定关系与登记数据生成内容指纹
function buildContentHash(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// 组装并判定一条复核记录（尚未入存档）
function buildReview(db, clock, body) {
  const binding = resolveBinding(db, clock, body);
  const verdict = evaluateLockReview(body);

  const review = {
    id: makeReviewId(),
    clockId: clock.id,
    adjustmentId: binding.adjustment.id,
    technicianIds: binding.technicianIds,
    technicians: binding.technicians.map((tech) => ({ id: tech.id, name: tech.name, role: tech.role })),
    reviewedAt: body.reviewedAt || new Date().toISOString(),
    measurements: verdict.measurements,
    status: verdict.status,
    qualified: verdict.status === STATUS_QUALIFIED,
    pendingMaintenance: verdict.status !== STATUS_QUALIFIED,
    missingFields: verdict.missingFields,
    issues: verdict.issues,
    note: body.note || "",
    valid: true,
    supersededAt: null,
    supersededReason: null,
    createdAt: new Date().toISOString()
  };
  return { review, binding };
}

// 并发重复提交合并：同一钟表+调校+两名技师的在途请求只执行一次
const inflight = new Map();

function inflightKey(clockId, adjustmentId, technicianIds) {
  return `${clockId}|${adjustmentId}|${[...technicianIds].sort().join(",")}`;
}

function withCoalescer(key, worker) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = Promise.resolve()
    .then(worker)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// 幂等键结果暂存：同一键在各业务对象间复用，始终沿用首次结果
const idempotencyStore = new Map();

function runWithIdempotency(key, producer) {
  if (!key) return producer();
  const cached = idempotencyStore.get(key);
  if (cached) return Promise.resolve(cached);
  return Promise.resolve()
    .then(producer)
    .then((result) => {
      idempotencyStore.set(key, result);
      return result;
    });
}

// 入口主流程：幂等 -> 并发合并 -> 同人员沿用首次 -> 判定 -> 存档
async function submitLockReview({ db, clock, body, idempotencyKey, persist }) {
  const binding = resolveBinding(db, clock, body);
  const key = inflightKey(clock.id, binding.adjustment.id, binding.technicianIds);

  return withCoalescer(key, () =>
    runWithIdempotency(idempotencyKey, async () => {
      // 人员相同（同一钟表、当前调校、同两名技师）已有有效复核：沿用首次结果
      const existing = archive.findExistingValidReview(db, {
        clockId: clock.id,
        adjustmentId: binding.adjustment.id,
        technicianIds: binding.technicianIds
      });
      if (existing) {
        return { review: existing, reused: true, reuseReason: "same-technicians-first-result" };
      }

      const { review } = buildReview(db, clock, body);
      archive.saveLockReview(db, review);
      await persist();
      return { review, reused: false, reuseReason: null };
    })
  );
}

module.exports = {
  makeError,
  latestAdjustment,
  resolveBinding,
  buildReview,
  buildContentHash,
  submitLockReview,
  // 导出供测试使用
  _stores: { inflight, idempotencyStore }
};
