# 中草药炮制工序记录台（gbherbprocess）

面向中药饮片厂炮制班组与质检员：登记药材批次、按炮制方法折算辅料比例与火力时间、逐批判定炮制程度、管理留样观察台账。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21809>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条路由） |
| 状态 | Zustand（herbStore / methodStore / batchStore / potStore / sampleStore） |
| 存储 | IndexedDB（Dexie，库名 `gbherbprocess-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21809
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # herb-material / processing-method / process-batch（批次+锅次） / retain-sample
│       ├── stores/            # herbStore / methodStore / batchStore / potStore / sampleStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useHerbFilter / useRatio
│       ├── pages/             # ProcessBoard / HerbList / MethodList / BatchBoard / SampleLedger
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / pots.ts（分锅/汇总/余量） / sync.ts（标签页广播） / degree.ts / export.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 炮制批次（分锅汇总）、留样到期提示、最近工序时间线、综合得率（总产出÷总投料） |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/batches` | 工序记录台 | 按锅容量分批炮制：每锅记投料/辅料/产出，自动分锅、重算总量得率、返工锅次 |
| `/samples` | 留样台账 | 留样来源精确到锅次（留样即冻结该锅）、柜位网格、到期提醒、追加观察记录 |

## 分锅炮制与追溯规则

- **批次拆分锅次**：药材批次受锅容量限制时按锅分次炮制（可「自动分锅」），每锅独立记录投料量、辅料实际用量、产出、火候/锅温/时长与程度判定；批次记录是同源锅次的汇总。
- **汇总随锅重算**：任一锅新增/修改/删除后，批次总投料、总辅料、总产出与得率重算，**得率 = 总产出 / 总投料 × 100%**。
- **留样冻结来源锅**：留样登记精确选择来源锅次，留样台账标明「来源锅次」；该锅一旦留样，其投料、辅料、产出即冻结不可直接改，只能**新增返工锅次**（`kind: rework`，`reworkOfPotId` 指回原锅），原锅值原样保留。返工锅投料来自原锅产出的中间品，不重复占用药材余量。
- **余量与容量**：同药材全部常规锅投料合计不得超过药材来量；单锅投料不得超过该锅容量。返工锅不占用药材余量。
- **并发分锅（两个标签页）**：批次带 `potsVersion` 乐观锁版本，分锅用量改动在单个 IndexedDB 读写事务内校验余量/容量并提交；版本冲突或超余量时整体失败回滚，**不留半锅记录**。提交成功后通过 `BroadcastChannel` 通知其他标签页重新水合最新余量。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`pots`、`samples`、`meta`。
- `db.version(1)` 建表；`version(2)` 为 `batches` 增加 `locked` 索引；`version(3)` 新增 `pots` 表、`samples` 增加 `potId` 索引、`batches` 增加 `potsVersion` 索引，并把历史批次每批迁移为一个常规锅（`pot-{batchId}-mig`），按留样/旧 `locked` 回填锅次 `retained` 与留样 `potId`。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`，含按锅容量自动分锅的多锅示例），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
