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
│       ├── types/             # herb-material / processing-method / process-batch(批次+锅次) / retain-sample
│       ├── stores/            # herbStore / methodStore / batchStore / potStore / sampleStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useHerbFilter / useRatio
│       ├── pages/             # ProcessBoard / HerbList / MethodList / BatchBoard / SampleLedger
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / degree.ts / export.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 待炮制批次、留样到期提示、最近工序时间线、平均得率 |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/batches` | 工序记录台 | 按锅容量（100kg/锅）分批炮制：每锅记投料/辅料/产出，同源锅次总量与得率随任一锅变更重算；留样冻结后只能新增返工锅 |
| `/samples` | 留样台账 | 留样标注来源锅次、柜位网格、到期提醒、按日期追加观察记录 |

## 分锅炮制与追溯规则

- 药材批次锅容量不足时必须拆成多个**锅次（pots 表）**，单锅投料不得超过 100kg；每锅独立记录投料、辅料实际用量与产出。
- 批次的总投料、总辅料、总产出与得率均为锅次**派生日快照**：任一锅变更后在同一 IndexedDB 事务内重算，得率 = 总产出 ÷ 总投料（不是各锅得率平均）。
- **返工锅**：锅次留样后其投料与产出冻结（界面禁用、事务内强校验），纠正只能新增来源指向该锅的返工锅，原锅原值保留；返工投料受来源锅剩余可返工量约束。
- **留样追溯**：留样必须选择来源锅次（`samples.potId`），留样台账展示锅次号与该锅投料/产出；留样/删样在事务内同步锅次冻结标记。
- **跨标签页并发**：提交在单个 Dexie 读写事务内完成「重新读取批次→版本号乐观锁校验→余量重算→写入」；超药材批次余量、版本冲突、超锅容量、冻结锅篡改等失败均整体回滚，不留半锅记录。提交成功后通过 BroadcastChannel 通知其他标签页重新装载。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`pots`、`samples`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填历史数据；`db.version(3).upgrade(...)` 把历史批次迁移为单锅记录、留样补 `potId`、回填批次派生快照与 `version`。升级前可用顶栏「导出备份」导出全量 JSON（备份含 `pots`）。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
