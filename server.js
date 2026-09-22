const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const intake = require("./lib/intake");
const archive = require("./lib/archive");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

const DEMO_AT = "2026-06-16T00:00:00.000Z";

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: DEMO_AT
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: DEMO_AT
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: DEMO_AT,
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  technicians: [
    { id: "tech_chen", name: "陈砚秋", role: "高级技师", active: true, createdAt: DEMO_AT },
    { id: "tech_lin", name: "林晚舟", role: "复核技师", active: true, createdAt: DEMO_AT },
    { id: "tech_wang", name: "王持正", role: "见习技师", active: true, createdAt: DEMO_AT }
  ],
  lockReviews: [
    {
      id: "lock_review_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      technicianIds: ["tech_chen", "tech_lin"],
      technicians: [
        { id: "tech_chen", name: "陈砚秋", role: "高级技师" },
        { id: "tech_lin", name: "林晚舟", role: "复核技师" }
      ],
      reviewedAt: DEMO_AT,
      measurements: { capJewelClearanceMm: 0.02, lockValueMm: 0.035, drawAngleDegrees: 12 },
      status: "qualified",
      qualified: true,
      pendingMaintenance: false,
      missingFields: [],
      issues: [],
      note: "进瓦/出瓦锁值居中，牵引正常，托钻间隙合格",
      valid: true,
      supersededAt: null,
      supersededReason: null,
      createdAt: DEMO_AT
    }
  ],
  escapementReplacements: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/pending-maintenance",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "POST /clocks/:id/escapement-replacements",
  "POST /clocks/:id/lock-reviews",
  "GET /clocks/:id/lock-reviews/current",
  "GET /clocks/:id/lock-reviews/:reviewId",
  "GET /adjustments",
  "GET /retests",
  "GET /technicians",
  "POST /technicians",
  "GET /lock-reviews"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function migrate(data) {
  // 旧版本档案补齐复核台相关集合
  if (!Array.isArray(data.technicians)) data.technicians = initialData.technicians;
  if (!Array.isArray(data.lockReviews)) data.lockReviews = [];
  if (!Array.isArray(data.escapementReplacements)) data.escapementReplacements = [];
  return data;
}

async function readDb() {
  await ensureDb();
  return migrate(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// 串行化所有读-改-写，避免并发请求互相覆盖文件
let writeChain = Promise.resolve();
function withWriteLock(worker) {
  const run = writeChain.then(worker, worker);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = intake.latestAdjustment(db, clock.id);
  const lockReview = adjustment ? archive.latestValidReview(db, clock.id, adjustment.id) : null;
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    // 走时合格状态只来自复测，复核台任何结论都不改变它
    qualified: retest ? retest.qualified : false,
    latestLockReview: lockReview,
    lockReviewStatus: lockReview ? lockReview.status : null,
    pendingLockMaintenance: lockReview ? lockReview.pendingMaintenance : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  // ---------------- 人员册 ----------------

  if (req.method === "GET" && pathname === "/technicians") {
    const db = await readDb();
    const active = url.searchParams.get("active");
    let data = db.technicians;
    if (active !== null) data = data.filter((item) => item.active === (active === "true"));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/technicians") {
    return withWriteLock(async () => {
      const db = await readDb();
      const body = await parseBody(req);
      required(body, ["name", "role"]);
      const technician = {
        id: makeId("tech"),
        name: body.name,
        role: body.role,
        active: body.active !== false,
        createdAt: new Date().toISOString()
      };
      db.technicians.push(technician);
      await writeDb(db);
      return send(res, 201, { data: technician });
    });
  }

  // ---------------- 钟表与走时复测 ----------------

  if (req.method === "GET" && pathname === "/clocks") {
    const db = await readDb();
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    return withWriteLock(async () => {
      const db = await readDb();
      const body = await parseBody(req);
      required(body, ["code", "escapementType", "balanceFrequency"]);
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.clocks.push(clock);
      await writeDb(db);
      return send(res, 201, { data: clockSummary(db, clock) });
    });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await readDb();
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  // 当前调校下锁值复核转待保养的钟表
  if (req.method === "GET" && pathname === "/clocks/pending-maintenance") {
    const db = await readDb();
    const data = db.clocks
      .map((clock) => clockSummary(db, clock))
      .filter((clock) => clock.pendingLockMaintenance);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const db = await readDb();
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const lockArchive = archive.history(db, clock.id);
    return send(res, 200, {
      data: {
        clock: clockSummary(db, clock),
        adjustments,
        retests,
        latestRetest: latestRetest(db, clock.id),
        // 锁值复核历史（含已失效记录）与当前有效复核
        lockReviews: lockArchive.reviews,
        escapementReplacements: lockArchive.replacements,
        currentLockReview: lockArchive.currentReview
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    // 更正调校：新增调校记录，旧锁值复核随之失效，按现有调校重算
    return withWriteLock(async () => {
      const db = await readDb();
      const clock = findClock(db, adjustmentMatch[1]);
      const body = await parseBody(req);
      required(body, ["currentDailyRateSeconds", "direction", "amount"]);
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.adjustments.push(adjustment);
      const invalidated = archive.invalidateForClock(db, clock.id, "adjustment-corrected");
      await writeDb(db);
      return send(res, 201, { data: adjustment, invalidatedLockReviews: invalidated });
    });
  }

  const replacementMatch = pathname.match(/^\/clocks\/([^/]+)\/escapement-replacements$/);
  if (replacementMatch && req.method === "POST") {
    // 更换擒纵部件：登记事件，原锁值复核全部失效
    return withWriteLock(async () => {
      const db = await readDb();
      const clock = findClock(db, replacementMatch[1]);
      const body = await parseBody(req);
      required(body, ["partsChanged", "reason"]);
      const partsChanged = Array.isArray(body.partsChanged)
        ? body.partsChanged
        : String(body.partsChanged)
            .split(/[,，、]/)
            .map((item) => item.trim())
            .filter(Boolean);
      if (!partsChanged.length) throw intake.makeError(400, "更换部件不能为空");
      const replacement = {
        id: makeId("escapement_replacement"),
        clockId: clock.id,
        partsChanged,
        reason: body.reason,
        technicianId: body.technicianId || null,
        newEscapementType: body.newEscapementType || null,
        replacedAt: body.replacedAt || new Date().toISOString(),
        note: body.note || ""
      };
      if (body.newEscapementType) clock.escapementType = body.newEscapementType;
      db.escapementReplacements.push(replacement);
      const invalidated = archive.invalidateForClock(db, clock.id, "escapement-parts-replaced");
      await writeDb(db);
      return send(res, 201, { data: replacement, invalidatedLockReviews: invalidated });
    });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    return withWriteLock(async () => {
      const db = await readDb();
      const clock = findClock(db, retestMatch[1]);
      const body = await parseBody(req);
      required(body, ["dailyRateSeconds", "amplitude"]);
      const adjustmentId = body.adjustmentId || intake.latestAdjustment(db, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      db.retests.push(retest);
      await writeDb(db);
      return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
    });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const db = await readDb();
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  // ---------------- 擒纵叉瓦锁值复核台 ----------------

  const lockReviewCurrentMatch = pathname.match(/^\/clocks\/([^/]+)\/lock-reviews\/current$/);
  if (lockReviewCurrentMatch && req.method === "GET") {
    const db = await readDb();
    const clock = findClock(db, lockReviewCurrentMatch[1]);
    const adjustment = intake.latestAdjustment(db, clock.id);
    const review = adjustment ? archive.latestValidReview(db, clock.id, adjustment.id) : null;
    return send(res, 200, { data: review, adjustmentId: adjustment ? adjustment.id : null });
  }

  const lockReviewItemMatch = pathname.match(/^\/clocks\/([^/]+)\/lock-reviews\/([^/]+)$/);
  if (lockReviewItemMatch && req.method === "GET") {
    const db = await readDb();
    const clock = findClock(db, lockReviewItemMatch[1]);
    const review = archive.findReview(db, lockReviewItemMatch[2]);
    if (!review || review.clockId !== clock.id) {
      return send(res, 404, { error: "复核记录不存在" });
    }
    return send(res, 200, { data: review });
  }

  const lockReviewCreateMatch = pathname.match(/^\/clocks\/([^/]+)\/lock-reviews$/);
  if (lockReviewCreateMatch && req.method === "POST") {
    return withWriteLock(async () => {
      const db = await readDb();
      const clock = findClock(db, lockReviewCreateMatch[1]);
      const body = await parseBody(req);
      const idempotencyKey = req.headers["idempotency-key"] || body.idempotencyKey || null;
      const result = await intake.submitLockReview({
        db,
        clock,
        body,
        idempotencyKey,
        persist: () => writeDb(db)
      });
      const status = result.review.pendingMaintenance ? 200 : 201;
      return send(res, status, {
        data: result.review,
        reused: result.reused,
        reuseReason: result.reuseReason,
        clock: clockSummary(db, clock)
      });
    });
  }

  if (req.method === "GET" && pathname === "/lock-reviews") {
    const db = await readDb();
    const clockId = url.searchParams.get("clockId");
    const statusFilter = url.searchParams.get("status");
    const validFilter = url.searchParams.get("valid");
    const data = archive.allReviews(db).filter((item) => {
      if (clockId && item.clockId !== clockId) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (validFilter !== null && item.valid !== (validFilter === "true")) return false;
      return true;
    });
    return send(res, 200, { data });
  }

  // ---------------- 既有查询 ----------------

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await readDb();
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await readDb();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误" })
  );
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
