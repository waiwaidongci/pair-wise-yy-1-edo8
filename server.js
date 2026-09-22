const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

// 擒纵叉瓦锁值复核台：入口、判定、存档三个业务部分
const { buildReviewDraft } = require("./src/reviewEntry");
const { judgeReview } = require("./src/reviewJudgment");
const {
  findReusableReview,
  saveReview,
  invalidateReviews,
  reviewsOf,
  latestValidReview,
  pendingMaintenance
} = require("./src/reviewArchive");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
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
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  reviews: [],
  partReplacements: []
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
  "POST /clocks/:id/reviews",
  "GET /clocks/:id/reviews",
  "GET /clocks/:id/latest-review",
  "POST /clocks/:id/escapement-parts",
  "GET /adjustments",
  "GET /retests",
  "GET /reviews"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  db.clocks = db.clocks || [];
  db.adjustments = db.adjustments || [];
  db.retests = db.retests || [];
  db.reviews = db.reviews || [];
  db.partReplacements = db.partReplacements || [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// 按钟表串行化写操作：并发重复提交在锁内重读存档后即可沿用首次结果。
const clockLocks = new Map();
function withClockLock(clockId, task) {
  const prev = clockLocks.get(clockId) || Promise.resolve();
  const run = prev.then(() => task());
  clockLocks.set(clockId, run.catch(() => {}));
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

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    latestReview: latestValidReview(db, clock.id),
    pendingMaintenance: pendingMaintenance(db, clock.id),
    qualified: retest ? retest.qualified : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
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
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/clocks/pending-maintenance") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => clock.pendingMaintenance);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const partReplacements = db.partReplacements.filter((item) => item.clockId === clock.id);
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        reviews: reviewsOf(db, clock.id),
        partReplacements,
        latestRetest: latestRetest(db, clock.id),
        latestReview: latestValidReview(db, clock.id)
      }
    });
  }

  // 更正调校：新调校落库后，该钟表旧复核全部失效，后续复核按现有调校重算。
  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clockId = adjustmentMatch[1];
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    return withClockLock(clockId, async () => {
      const fresh = await readDb();
      const clock = findClock(fresh, clockId);
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      fresh.adjustments.push(adjustment);
      const invalidatedReviews = invalidateReviews(fresh, clock.id, `更正调校：${adjustment.id}`);
      await writeDb(fresh);
      return send(res, 201, { data: adjustment, invalidatedReviews });
    });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
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
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  // 复核入口：绑定钟表、当前调校与两名技师，登记三项量测；
  // 相同人员或并发重复提交沿用首次结果，否则经判定部分得出结论后落存档。
  const reviewMatch = pathname.match(/^\/clocks\/([^/]+)\/reviews$/);
  if (reviewMatch && req.method === "POST") {
    const clockId = reviewMatch[1];
    const body = await parseBody(req);
    return withClockLock(clockId, async () => {
      const fresh = await readDb();
      const clock = findClock(fresh, clockId);
      const draft = buildReviewDraft({
        clock,
        currentAdjustment: latestAdjustment(fresh, clockId),
        body,
        id: makeId("review")
      });
      const reusable = findReusableReview(fresh, draft);
      if (reusable) {
        return send(res, 200, {
          data: reusable,
          reused: true,
          message: "相同人员的复核沿用首次结果",
          clock: clockSummary(fresh, clock)
        });
      }
      const { result, reasons } = judgeReview(draft);
      const review = saveReview(fresh, {
        ...draft,
        result,
        reasons,
        valid: true,
        invalidatedAt: null,
        invalidateReason: null
      });
      await writeDb(fresh);
      return send(res, 201, { data: review, reused: false, clock: clockSummary(fresh, clock) });
    });
  }

  if (reviewMatch && req.method === "GET") {
    const clock = findClock(db, reviewMatch[1]);
    return send(res, 200, { data: reviewsOf(db, clock.id) });
  }

  const latestReviewMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-review$/);
  if (latestReviewMatch && req.method === "GET") {
    const clock = findClock(db, latestReviewMatch[1]);
    return send(res, 200, { data: latestValidReview(db, clock.id) });
  }

  // 更换擒纵部件：登记部件更换，该钟表旧复核全部失效。
  const partsMatch = pathname.match(/^\/clocks\/([^/]+)\/escapement-parts$/);
  if (partsMatch && req.method === "POST") {
    const clockId = partsMatch[1];
    const body = await parseBody(req);
    required(body, ["part"]);
    return withClockLock(clockId, async () => {
      const fresh = await readDb();
      const clock = findClock(fresh, clockId);
      const replacement = {
        id: makeId("part"),
        clockId: clock.id,
        part: body.part,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      fresh.partReplacements.push(replacement);
      const invalidatedReviews = invalidateReviews(fresh, clock.id, `更换擒纵部件：${body.part}`);
      await writeDb(fresh);
      return send(res, 201, { data: replacement, invalidatedReviews, clock: clockSummary(fresh, clock) });
    });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  // 复核存档查询：含已失效记录，历史始终可查。
  if (req.method === "GET" && pathname === "/reviews") {
    const clockId = url.searchParams.get("clockId");
    const result = url.searchParams.get("result");
    const valid = url.searchParams.get("valid");
    const data = db.reviews.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchResult = !result || item.result === result;
      const matchValid = valid === null || (item.valid !== false) === (valid === "true");
      return matchClock && matchResult && matchValid;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
