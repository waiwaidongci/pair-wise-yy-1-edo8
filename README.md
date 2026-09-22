# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录、擒纵叉瓦锁值复核记录和擒纵部件更换记录。

## 启动

```bash
PORT=3021 node server.js
```

## 擒纵叉瓦锁值复核台

复核业务分三个部分实现：

- **入口**（`src/reviewEntry.js`）：每次复核绑定钟表、当前调校和两名技师，登记托钻间隙、锁值与牵引角。
- **判定**（`src/reviewJudgment.js`）：缺项、锁值不在 0.02~0.05 毫米、牵引角低于 10 度 → 转待保养；记录保留，合格状态不变。
- **存档**（`src/reviewArchive.js`）：相同人员或并发重复提交沿用首次结果；更换擒纵部件或更正调校后旧复核失效，按现有调校重算，历史仍可查。

复核结论（合格/待保养）只决定钟表的待保养状态，不改变由复测得出的合格状态。

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/pending-maintenance`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`（更正调校后旧复核失效）
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `POST /clocks/:id/reviews`（提交复核）
- `GET /clocks/:id/reviews`（复核历史，含已失效）
- `GET /clocks/:id/latest-review`（最新有效复核）
- `POST /clocks/:id/escapement-parts`（登记擒纵部件更换，旧复核失效）
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /reviews?clockId=&result=&valid=`

## 复核闭环示例

```bash
# 提交复核：两名技师 + 托钻间隙/锁值/牵引角
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/reviews \
  -H 'Content-Type: application/json' \
  -d '{"technicians":["张工","李工"],"palletJewelClearanceMm":0.03,"lockValueMm":0.04,"drawAngleDegrees":12}'

# 锁值超差 → 保留记录并转待保养，合格状态不变
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/reviews \
  -H 'Content-Type: application/json' \
  -d '{"technicians":["王工","赵工"],"palletJewelClearanceMm":0.03,"lockValueMm":0.06,"drawAngleDegrees":12}'

# 待保养钟表
curl http://127.0.0.1:3021/clocks/pending-maintenance

# 更换擒纵部件 → 旧复核失效，历史仍可查
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/escapement-parts \
  -H 'Content-Type: application/json' \
  -d '{"part":"擒纵叉瓦","note":"更换进瓦"}'
curl 'http://127.0.0.1:3021/reviews?clockId=clock_demo&valid=false'
```

## 复测闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
