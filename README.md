# 机械钟表擒纵调校API · 擒纵叉瓦锁值复核台

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化钟表档案、调校记录、走时复测记录，以及擒纵叉瓦锁值复核记录。

## 启动

```bash
PORT=3021 node server.js
```

## 测试

```bash
PORT=3099 node server.js &
PORT=3099 node test/smoke.js
```

冒烟测试覆盖：双人绑定、边界值判定、缺项/超差转待保养、同人员与并发重复提交沿用首次结果、更正调校与更换擒纵部件后的失效与重算、历史可查。

## 业务结构（三个业务部分）

| 部分 | 模块 | 职责 |
| --- | --- | --- |
| 入口 | `lib/intake.js` | 绑定钟表、当前调校与两名技师；解析登记数据；同人员重复提交与并发重复提交沿用首次结果 |
| 判定 | `lib/judgment.js` | 纯函数判定：缺项、锁值 0.02–0.05mm（含边界）、牵引角 ≥10° |
| 存档 | `lib/archive.js` | 复核落库、历史查询；更换擒纵部件或更正调校后软失效旧复核 |

复核规则：

- 每次复核绑定一个钟表、它的**当前调校**（最新调校记录）与**两名不同技师**，登记：
  - `capJewelClearanceMm` 托钻间隙（毫米）
  - `lockValueMm` 锁值（毫米，须在 0.02–0.05 之间）
  - `drawAngleDegrees` 牵引角（度，不得低于 10）
- 任一测量缺项、非数值，或锁值/牵引角不合格：记录照常保留，结论为 `pending-maintenance`（转待保养），返回 200；
- 判定结论只属于复核本身，**绝不改变**钟表由走时复测得出的 `qualified` 状态；
- 同一钟表 + 当前调校 + 同两名技师（顺序无关）已有有效复核时，沿用首次结果（响应中 `reused: true`）；
- 并发重复提交合并到在途的首次提交；也支持 `Idempotency-Key` 请求头/`idempotencyKey` 字段；
- 更换擒纵部件或新增调校（更正调校）后，该钟表原有效复核置为失效（`valid:false`，带 `supersededReason`），历史仍可查；按现有调校重新提交复核即为重算。

## 主要接口

- `GET /health`
- `GET/POST /clocks`
- `GET /clocks/not-qualified` — 走时不合格
- `GET /clocks/pending-maintenance` — 当前复核待保养
- `GET /clocks/:id/history` — 含走时复测与复核全量历史（含已失效）
- `POST /clocks/:id/adjustments` — 更正调校，旧复核失效
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `POST /clocks/:id/escapement-replacements` — 更换擒纵部件，旧复核失效
- `POST /clocks/:id/lock-reviews` — 提交锁值复核
- `GET /clocks/:id/lock-reviews/current` — 当前调校下的有效复核
- `GET /clocks/:id/lock-reviews/:reviewId` — 单条复核（含已失效）
- `GET /lock-reviews?clockId=&status=&valid=` — 复核存档总览
- `GET/POST /technicians`

## 闭环示例

```bash
# 合格复核
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/lock-reviews \
  -H 'Content-Type: application/json' \
  -d '{"capJewelClearanceMm":0.015,"lockValueMm":0.035,"drawAngleDegrees":12,
       "leadTechnicianId":"tech_wang","assistantTechnicianId":"tech_lin",
       "note":"托钻间隙偏小但锁值与牵引合格"}'

# 缺项/超差 -> 待保养，走时合格状态不变
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/lock-reviews \
  -H 'Content-Type: application/json' \
  -d '{"lockValueMm":0.06,"drawAngleDegrees":8,
       "leadTechnicianId":"tech_chen","assistantTechnicianId":"tech_lin"}'

# 同人员重复提交 -> reused:true，沿用首次结果
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/lock-reviews \
  -H 'Content-Type: application/json' \
  -d '{"capJewelClearanceMm":0.015,"lockValueMm":0.035,"drawAngleDegrees":12,
       "leadTechnicianId":"tech_wang","assistantTechnicianId":"tech_lin"}'

# 更正调校 -> 旧复核失效
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":25,"direction":"慢针方向","amount":"继续微调0.2格"}'

# 更换擒纵部件 -> 旧复核失效
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/escapement-replacements \
  -H 'Content-Type: application/json' \
  -d '{"partsChanged":"擒纵叉,叉瓦","reason":"叉瓦磨损","technicianId":"tech_chen"}'

# 历史（含已失效复核与部件更换事件）
curl http://127.0.0.1:3021/clocks/clock_demo/history
```
