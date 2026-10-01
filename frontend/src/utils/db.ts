import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch, ProcessPot } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import { applyPotSummary } from './pots';

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
          .modify((row: { locked?: boolean }) => {
            if (typeof row.locked !== 'boolean') {
              row.locked = false;
            }
          });
      });

    // v3：批次拆分可追溯锅次。
    // - 新增 pots 表：每锅独立记投料、辅料、产出；留样精确到锅（retained / reworkOfPotId）。
    // - samples 增加 potId 索引；batches 增加 potsVersion 索引（并发分锅的乐观锁）。
    // - 历史批次每批迁移为一个常规锅，并按留样回填 potId / retained。
    // 升级前请在「导出备份」中导出 JSON。
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, potsVersion',
        pots: 'id, batchId, herbId, methodId, seq, kind, retained, reworkOfPotId',
        samples: 'id, sampleNo, batchId, potId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const legacyBatches = (await tx.table('batches').toArray()) as Array<
          // v3 迁移读取的是历史（v2 及更早）结构，此时 ProcessBatch 已去掉 locked/fireLevel 等字段
          Record<string, unknown> & {
            id: string;
            batchNo: string;
            herbId: string;
            methodId: string;
            feedKg: number;
            auxUsedKg: number;
            outputKg?: number;
            yieldRate: number;
            degree: ProcessBatch['degree'];
            startedAt: string;
            endedAt: string;
            remark?: string;
            fireLevel?: ProcessPot['fireLevel'];
            locked?: boolean;
            operator?: string;
          }
        >;
        const legacySamples = (await tx.table('samples').toArray()) as Array<
          RetainSample & { potId?: string }
        >;

        const newPots: ProcessPot[] = [];
        const retainedPotIds = new Set(legacySamples.filter((s) => s.potId).map((s) => s.potId as string));
        const newSamples: RetainSample[] = [];

        for (const batch of legacyBatches) {
          const potId = `pot-${batch.id}-mig`;
          const feedKg = Number(batch.feedKg) || 0;
          const outputKg =
            Number((batch as { outputKg?: number }).outputKg) ||
            Number(((feedKg * Number(batch.yieldRate || 0)) / 100).toFixed(1));
          newPots.push({
            id: potId,
            batchId: batch.id,
            herbId: batch.herbId,
            methodId: batch.methodId,
            seq: 1,
            kind: 'normal',
            // 历史数据无锅容量记录，以本锅投料为容量上限，保证迁移后不触发超量
            capacityKg: feedKg > 0 ? feedKg : 0,
            feedKg,
            auxUsedKg: Number(batch.auxUsedKg) || 0,
            outputKg,
            fireLevel: batch.fireLevel ?? '文火',
            temp: 100,
            duration: 12,
            startedAt: batch.startedAt,
            endedAt: batch.endedAt,
            degree: batch.degree,
            operator: batch.operator ?? '历史数据',
            retained: retainedPotIds.has(potId) || batch.locked === true,
          });
        }

        for (const sample of legacySamples) {
          const potId = sample.potId ?? `pot-${sample.batchId}-mig`;
          retainedPotIds.add(potId);
          newSamples.push({ ...sample, potId });
        }

        // 按回填的留样集合刷新锅次 retained 标记
        newPots.forEach((pot) => {
          if (retainedPotIds.has(pot.id)) {
            pot.retained = true;
          }
        });

        // 批次记录改写为锅次汇总（去掉 v2 的 locked 等字段）
        const newBatches = legacyBatches.map((legacy) => {
          const pot = newPots.find((p) => p.batchId === legacy.id)!;
          const migrated: ProcessBatch = {
            id: legacy.id,
            batchNo: legacy.batchNo,
            herbId: legacy.herbId,
            methodId: legacy.methodId,
            feedKg: 0,
            auxUsedKg: 0,
            outputKg: 0,
            yieldRate: 0,
            degree: legacy.degree,
            startedAt: legacy.startedAt,
            endedAt: legacy.endedAt,
            potCount: 1,
            potsVersion: 1,
            remark: legacy.remark,
          };
          return applyPotSummary(migrated, [pot]);
        });

        await tx.table('pots').bulkPut(newPots);
        await tx.table('batches').clear();
        await tx.table('batches').bulkPut(newBatches);
        await tx.table('samples').clear();
        await tx.table('samples').bulkPut(newSamples);
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
