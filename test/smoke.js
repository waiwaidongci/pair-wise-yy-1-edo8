"use strict";

// 端到端冒烟测试：启动服务，按业务顺序验证复核台全部规则。
// 用法：PORT=3xxx node test/smoke.js

const BASE = `http://127.0.0.1:${process.env.PORT || 3099}`;

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function request(method, pathname, body, headers = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  console.log("1. 入口：基础档案");
  const health = await request("GET", "/health");
  assert(health.status === 200, "health 正常");

  const techs = await request("GET", "/technicians");
  assert(techs.json.data.length >= 3, "人员册至少三名技师");

  // 补充两名技师，保证待保养用例能使用未提交过的人员组合
  const techA = await request("POST", "/technicians", { name: "赵观澜", role: "复核技师" });
  const techB = await request("POST", "/technicians", { name: "孙守拙", role: "高级技师" });
  const techZhao = techA.json.data.id;
  const techSun = techB.json.data.id;

  const sameTech = await request("POST", "/clocks/clock_demo/lock-reviews", {
    lockValueMm: 0.035,
    drawAngleDegrees: 12,
    capJewelClearanceMm: 0.02,
    leadTechnicianId: "tech_chen",
    assistantTechnicianId: "tech_chen"
  });
  assert(sameTech.status === 400, "同一人任两名技师 -> 400");

  const missingTech = await request("POST", "/clocks/clock_demo/lock-reviews", {
    leadTechnicianId: "tech_chen"
  });
  assert(missingTech.status === 400, "缺少第二名技师 -> 400");

  console.log("2. 判定：合格复核（新钟表，避免与示例复核撞同人员）");
  const created = await request("POST", "/clocks", {
    code: "CLK-TEST-01",
    escapementType: "英国锚式",
    balanceFrequency: "21600vph",
    targetDailyRateSeconds: 15
  });
  const clockId = created.json.data.id;

  await request("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: 40,
    direction: "慢针方向",
    amount: "测试调校"
  });
  const qualifiedReview = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    capJewelClearanceMm: 0.018,
    lockValueMm: 0.035,
    drawAngleDegrees: 11,
    leadTechnicianId: "tech_chen",
    assistantTechnicianId: "tech_lin",
    note: "合格复核"
  });
  assert(qualifiedReview.status === 201, "合格复核返回 201");
  assert(qualifiedReview.json.data.status === "qualified", "状态 qualified");
  assert(qualifiedReview.json.data.qualified === true, "复核合格标记");
  assert(qualifiedReview.json.reused === false, "首次提交不复用");
  assert(qualifiedReview.json.clock.qualified === false, "复核不改变走时合格状态（仍 false，因为无复测）");

  console.log("3. 边界值：0.02 / 0.05 / 10 度均合格");
  const boundary = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    capJewelClearanceMm: 0.01,
    lockValueMm: 0.02,
    drawAngleDegrees: 10,
    leadTechnicianId: "tech_wang",
    assistantTechnicianId: "tech_chen"
  });
  assert(boundary.json.data.status === "qualified", "锁值0.02、牵引10 -> 合格");
  const boundary2 = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    capJewelClearanceMm: 0.01,
    lockValueMm: 0.05,
    drawAngleDegrees: 10.5,
    leadTechnicianId: "tech_wang",
    assistantTechnicianId: "tech_lin"
  });
  assert(boundary2.json.data.status === "qualified", "锁值0.05 -> 合格");

  console.log("4. 判定：缺项 / 锁值超界 / 牵引角不足 -> 待保养，状态不变");
  const missing = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    lockValueMm: 0.03,
    leadTechnicianId: "tech_lin",
    assistantTechnicianId: techZhao
  });
  assert(missing.status === 200, "待保养返回 200");
  assert(missing.json.data.status === "pending-maintenance", "缺项 -> pending-maintenance");
  assert(missing.json.data.missingFields.includes("drawAngleDegrees"), "登记缺项字段");
  assert(missing.json.data.missingFields.includes("capJewelClearanceMm"), "托钻间隙缺项也登记");
  assert(missing.json.data.pendingMaintenance === true, "待保养标记");
  assert(missing.json.clock.qualified === false, "待保养不改变走时合格状态");

  const outOfRange = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    capJewelClearanceMm: 0.02,
    lockValueMm: 0.06,
    drawAngleDegrees: 8,
    leadTechnicianId: "tech_chen",
    assistantTechnicianId: techSun
  });
  assert(outOfRange.json.data.status === "pending-maintenance", "锁值0.06且牵引8 -> 待保养");
  assert(outOfRange.json.data.issues.length === 2, "列出两条问题");

  const notANumber = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    capJewelClearanceMm: "x",
    lockValueMm: 0.03,
    drawAngleDegrees: 12,
    leadTechnicianId: "tech_wang",
    assistantTechnicianId: "tech_chen"
  });
  // tech_wang + tech_chen 已有边界复核（合格）在先，同人员会沿用首次结果
  assert(notANumber.json.reused === true, "同人员沿用首次结果（无论新数据如何）");
  assert(notANumber.json.data.status === "qualified", "沿用的是首次合格结果");

  console.log("5. 存档：待保养清单与历史");
  const pending = await request("GET", "/clocks/pending-maintenance");
  assert(
    pending.json.data.some((c) => c.id === clockId),
    "待保养钟表出现在清单"
  );
  const history = await request("GET", `/clocks/${clockId}/history`);
  assert(history.json.data.lockReviews.length >= 4, "历史保留全部复核记录");
  assert(history.json.data.currentLockReview.valid === true, "当前复核有效");

  console.log("6. 更正调校 -> 旧复核失效，按现有调校重算");
  await request("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: 10,
    direction: "慢针方向",
    amount: "再次调校"
  });
  const currentAfterCorrection = await request("GET", `/clocks/${clockId}/lock-reviews/current`);
  assert(currentAfterCorrection.json.data === null, "更正调校后无当前有效复核");

  const invalidatedOld = await request(
    "GET",
    `/clocks/${clockId}/lock-reviews/${qualifiedReview.json.data.id}`
  );
  assert(invalidatedOld.json.data.valid === false, "旧复核已失效");
  assert(
    invalidatedOld.json.data.supersededReason === "adjustment-corrected",
    "失效原因 adjustment-corrected"
  );

  const recalc = await request("POST", `/clocks/${clockId}/lock-reviews`, {
    capJewelClearanceMm: 0.02,
    lockValueMm: 0.04,
    drawAngleDegrees: 13,
    leadTechnicianId: "tech_chen",
    assistantTechnicianId: "tech_lin"
  });
  assert(recalc.status === 201, "按现有调校重新复核成功");
  assert(recalc.json.reused === false, "调校变了，不沿用旧结果");

  const historyAfter = await request("GET", `/clocks/${clockId}/history`);
  assert(historyAfter.json.data.lockReviews.length >= 5, "失效记录仍在历史中可查");
  assert(
    historyAfter.json.data.currentLockReview.id === recalc.json.data.id,
    "新复核成为当前复核"
  );

  console.log("7. 更换擒纵部件 -> 旧复核失效");
  const replacement = await request("POST", `/clocks/${clockId}/escapement-replacements`, {
    partsChanged: ["擒纵叉", "叉瓦"],
    reason: "叉瓦磨损",
    technicianId: "tech_chen"
  });
  assert(replacement.status === 201, "更换事件登记成功");
  assert(replacement.json.invalidatedLockReviews >= 1, "旧复核被失效");
  const afterReplacement = await request("GET", `/clocks/${clockId}/lock-reviews/current`);
  assert(afterReplacement.json.data === null, "换件后无当前有效复核");

  const archiveList = await request("GET", `/lock-reviews?clockId=${clockId}`);
  assert(
    archiveList.json.data.every((r) => r.valid === false),
    "存档中该钟表复核均已失效但仍可列出"
  );

  console.log("8. 并发重复提交 -> 合并为首次结果");
  await request("POST", `/clocks/${clockId}/adjustments`, {
    currentDailyRateSeconds: 8,
    direction: "慢针方向",
    amount: "换件后首次调校"
  });
  const payload = {
    capJewelClearanceMm: 0.02,
    lockValueMm: 0.033,
    drawAngleDegrees: 14,
    leadTechnicianId: "tech_chen",
    assistantTechnicianId: "tech_lin"
  };
  const [r1, r2, r3] = await Promise.all([
    request("POST", `/clocks/${clockId}/lock-reviews`, payload),
    request("POST", `/clocks/${clockId}/lock-reviews`, payload),
    request("POST", `/clocks/${clockId}/lock-reviews`, payload)
  ]);
  const ids = new Set([r1.json.data.id, r2.json.data.id, r3.json.data.id]);
  assert(ids.size === 1, "三个并发请求只产生一条复核");
  assert(r2.json.reused === true && r3.json.reused === true, "后两个请求沿用首次结果");

  console.log("9. Idempotency-Key 支持");
  const keyPayload = {
    capJewelClearanceMm: 0.02,
    lockValueMm: 0.03,
    drawAngleDegrees: 12,
    leadTechnicianId: "tech_wang",
    assistantTechnicianId: "tech_lin"
  };
  const k1 = await request("POST", `/clocks/${clockId}/lock-reviews`, keyPayload, {
    "Idempotency-Key": "key-001"
  });
  const k2 = await request("POST", `/clocks/${clockId}/lock-reviews`, keyPayload, {
    "Idempotency-Key": "key-001"
  });
  assert(k1.json.data.id === k2.json.data.id, "相同幂等键返回首次结果");

  console.log("\n" + `结果：${passed} 通过，${failed} 失败`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
