import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch, ProcessPot } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import { applyPotSnapshot } from './pots';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class HerbProcessDB extends Dexie {
  herbs!: Table<HerbMaterial, string>;
  methods!: Table<ProcessingMethod, string>;
  batches!: Table<ProcessBatch, string>;
  pots!: Table<ProcessPot, string>;
  samples!: Table<RetainSample, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      herbs: 'id, name, origin, part, batchNo, receivedAt',
      methods: 'id, name, auxiliary, fireLevel',
      batches: 'id, batchNo, herbId, methodId, degree, startedAt',
      samples: 'id, sampleNo, batchId, cabinet, retainedAt',
      meta: 'key',
    });

    // v2：批次表增加 locked 索引（锁定/质检放行查询更快），并回填历史数据的 locked 字段。
    // 升级前请在「导出备份」中导出 JSON。
    this.version(2)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('batches')
          .toCollection()
          .modify((row: ProcessBatch) => {
            if (typeof row.locked !== 'boolean') {
              row.locked = false;
            }
          });
      });

    // v3：批次拆锅——新增 pots 表；每锅独立记投料/辅料/产出，批次总量与得率改为派生快照。
    // 历史批次迁移为「单锅」记录，留样补 potId（锅次可追溯）。
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        pots: 'id, batchId, kind, sourcePotId, sampled, potNo',
        samples: 'id, sampleNo, batchId, potId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const oldBatches = await tx.table<ProcessBatch, string>('batches').toArray();
        const oldSamples = await tx.table<RetainSample, string>('samples').toArray();
        const newPots: ProcessPot[] = [];
        const batchPots = new Map<string, ProcessPot>();

        oldBatches.forEach((batch) => {
          const outputKg =
            typeof (batch as Partial<ProcessBatch>).outputKg === 'number'
              ? (batch as Partial<ProcessBatch>).outputKg!
              : Number(((batch.feedKg * batch.yieldRate) / 100).toFixed(3));
          const pot: ProcessPot = {
            id: `pot-${batch.id}`,
            batchId: batch.id,
            potNo: 1,
            kind: 'normal',
            feedKg: batch.feedKg,
            auxUsedKg: batch.auxUsedKg,
            outputKg,
            startedAt: batch.startedAt,
            endedAt: batch.endedAt,
            operator: batch.operator,
            sampled: oldSamples.some((s) => s.batchId === batch.id),
          };
          newPots.push(pot);
          batchPots.set(batch.id, pot);
        });

        if (newPots.length > 0) {
          await tx.table('pots').bulkPut(newPots);
        }

        // 留样补来源锅次；批次回填拆锅派生字段与乐观锁版本
        await tx
          .table('samples')
          .toCollection()
          .modify((sample: RetainSample) => {
            const pot = batchPots.get(sample.batchId);
            if (pot && !sample.potId) {
              sample.potId = pot.id;
            }
          });

        await tx
          .table('batches')
          .toCollection()
          .modify((batch: ProcessBatch) => {
            const pot = batchPots.get(batch.id);
            const migrated = applyPotSnapshot(batch, pot ? [pot] : [], 0);
            batch.feedKg = migrated.feedKg;
            batch.auxUsedKg = migrated.auxUsedKg;
            batch.outputKg = migrated.outputKg;
            batch.yieldRate = migrated.yieldRate;
            batch.potCount = migrated.potCount;
            batch.reworkCount = 0;
            batch.operator = migrated.operator;
            batch.startedAt = migrated.startedAt;
            batch.endedAt = migrated.endedAt;
            if (typeof batch.version !== 'number') {
              batch.version = 0;
            }
          });
      });
  }
}

export const db = new HerbProcessDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
