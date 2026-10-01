import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { broadcastChange } from '../utils/sync';
import type { FireLevel } from '../types/processing-method';
import type { PotKind, ProcessDegree, ProcessPot } from '../types/process-batch';
import {
  HerbRemainingError,
  PotCapacityError,
  PotRetainedError,
  PotsConflictError,
  ReworkSourceError,
  applyPotSummary,
  assertWithinHerbRemaining,
  assertWithinPotCapacity,
  round1,
  sortPots,
} from '../utils/pots';
import type { HerbMaterial } from '../types/herb-material';

/** 锅次录入字段（不含批次归属与序号） */
export interface PotDraft {
  capacityKg: number;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  fireLevel: FireLevel;
  temp: number;
  duration: number;
  startedAt: string;
  endedAt: string;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
  /** 常规锅允许前端预占锅容量校验时使用（自动分锅），返工锅不传 */
  kind?: PotKind;
}

export interface ReworkDraft extends PotDraft {
  /** 被返工的原锅 */
  reworkOfPotId: string;
}

interface PotState {
  pots: ProcessPot[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 新建批次时一次提交多锅：全部成功或整体回滚，不留半锅记录 */
  createBatchWithPots: (
    batch: { id: string; batchNo: string; herbId: string; methodId: string; remark?: string },
    drafts: PotDraft[],
  ) => Promise<void>;
  /** 更新单个常规锅的投料/辅料/产出等（留样锅禁止），并重算同源汇总 */
  updatePot: (batchId: string, potId: string, expectedVersion: number, draft: PotDraft) => Promise<void>;
  /** 新增返工锅次：保留原锅原值，作为同批新锅参与汇总 */
  addReworkPot: (batchId: string, sourcePotId: string, expectedVersion: number, draft: ReworkDraft) => Promise<void>;
  /** 删除锅次（留样锅禁止；删空时返回的汇总为 null，由调用方决定批次去留） */
  removePot: (batchId: string, potId: string, expectedVersion: number) => Promise<void>;
  /** 批次删除后清理锅次 */
  removePotsOfBatch: (batchId: string) => Promise<void>;
  /** 留样登记/删除时同步锅次留样标记 */
  markPotRetained: (potId: string, retained: boolean) => Promise<void>;
  /** 查询某批的锅次（已排序） */
  potsOfBatch: (batchId: string) => ProcessPot[];
}

/** 锅次的身份/归属字段（与录入内容合并成完整锅次） */
type PotIdentity = Pick<
  ProcessPot,
  'id' | 'batchId' | 'herbId' | 'methodId' | 'seq' | 'kind' | 'reworkOfPotId'
>;

function toPot(draft: PotDraft, base: PotIdentity): ProcessPot {
  return {
    ...base,
    kind: draft.kind ?? base.kind,
    capacityKg: Number(draft.capacityKg) || 0,
    feedKg: Number(draft.feedKg) || 0,
    auxUsedKg: Number(draft.auxUsedKg) || 0,
    outputKg: Number(draft.outputKg) || 0,
    fireLevel: draft.fireLevel,
    temp: Number(draft.temp) || 0,
    duration: Number(draft.duration) || 0,
    startedAt: draft.startedAt,
    endedAt: draft.endedAt,
    degree: draft.degree,
    operator: draft.operator.trim(),
    remark: draft.remark?.trim() || undefined,
    retained: false,
  };
}

/** 同种下一序号（返工锅顺延） */
function nextSeq(pots: ProcessPot[]): number {
  return pots.reduce((max, p) => Math.max(max, p.seq), 0) + 1;
}

export const usePotStore = create<PotState>()((set, get) => ({
  pots: [],
  hydrated: false,

  hydrate: async () => {
    const pots = await db.pots.toArray();
    set({ pots: sortPots(pots), hydrated: true });
  },

  createBatchWithPots: async (batchMeta, drafts) => {
    if (drafts.length === 0) {
      throw new Error('至少需要一个锅次');
    }
    const now = new Date().toISOString();
    await db.transaction('rw', db.batches, db.pots, db.herbs, async () => {
      const herb = await db.herbs.get(batchMeta.herbId);
      if (!herb) {
        throw new Error('关联药材不存在，请刷新后重试');
      }
      const sameHerbPots = await db.pots.where('herbId').equals(batchMeta.herbId).toArray();

      // 构造锅次（创建时均为常规锅）
      let normalFeed = 0;
      const pots = drafts.map((draft, index) => {
        const pot = toPot(draft, {
          id: uid('pot'),
          batchId: batchMeta.id,
          herbId: batchMeta.herbId,
          methodId: batchMeta.methodId,
          seq: index + 1,
          kind: 'normal',
        });
        // 失败即抛错，事务整体回滚，不会留下半锅记录
        assertWithinPotCapacity(pot);
        normalFeed += pot.feedKg;
        return pot;
      });
      // 分锅用量合计不得超出药材余量
      assertWithinHerbRemaining(herb, normalFeed, sameHerbPots);

      const summary = applyPotSummary(
        {
          id: batchMeta.id,
          batchNo: batchMeta.batchNo.trim(),
          herbId: batchMeta.herbId,
          methodId: batchMeta.methodId,
          feedKg: 0,
          auxUsedKg: 0,
          outputKg: 0,
          yieldRate: 0,
          degree: '适中',
          startedAt: now,
          endedAt: now,
          potCount: 0,
          potsVersion: 1,
          remark: batchMeta.remark?.trim() || undefined,
        },
        pots,
      );

      await db.pots.bulkPut(pots);
      await db.batches.put(summary);
    });
    await get().hydrate();
    broadcastChange('pots');
    broadcastChange('batches');
  },

  updatePot: async (batchId, potId, expectedVersion, draft) => {
    await db.transaction('rw', db.batches, db.pots, db.herbs, async () => {
      const batch = await db.batches.get(batchId);
      if (!batch) {
        throw new Error('批次不存在，请刷新后重试');
      }
      // 乐观锁：另一标签页已改动分锅时，版本号对不上则整体失败
      if (batch.potsVersion !== expectedVersion) {
        throw new PotsConflictError();
      }
      const target = await db.pots.get(potId);
      if (!target || target.batchId !== batchId) {
        throw new Error('锅次不存在，请刷新后重试');
      }
      if (target.retained) {
        // 留样后不能直接改投料/辅料/产出，只能新增返工锅次保留原值
        throw new PotRetainedError(potId);
      }
      if (draft.kind === 'rework') {
        throw new ReworkSourceError('更新锅次不能改变锅次类型');
      }

      const changed = toPot(draft, {
        id: target.id,
        batchId: target.batchId,
        herbId: target.herbId,
        methodId: target.methodId,
        seq: target.seq,
        kind: target.kind,
        reworkOfPotId: target.reworkOfPotId,
      });
      changed.retained = target.retained;
      assertWithinPotCapacity(changed);

      const others = await db.pots.where('batchId').equals(batchId).toArray();
      if (changed.kind === 'normal') {
        const herb = await db.herbs.get(batch.herbId);
        const sameHerbPots = await db.pots.where('herbId').equals(batch.herbId).toArray();
        const otherNormalFeed = others
          .filter((p) => p.id !== potId && p.kind === 'normal')
          .reduce((s, p) => s + p.feedKg, 0);
        assertWithinHerbRemaining(herb, otherNormalFeed + changed.feedKg, sameHerbPots, batchId);
      }

      const nextPots = others.map((p) => (p.id === potId ? changed : p));
      await db.pots.put(changed);
      await db.batches.put({ ...applyPotSummary(batch, nextPots), potsVersion: batch.potsVersion + 1 });
    });
    await get().hydrate();
    broadcastChange('pots');
    broadcastChange('batches');
  },

  addReworkPot: async (batchId, sourcePotId, expectedVersion, draft) => {
    await db.transaction('rw', db.batches, db.pots, async () => {
      const batch = await db.batches.get(batchId);
      if (!batch) {
        throw new Error('批次不存在，请刷新后重试');
      }
      if (batch.potsVersion !== expectedVersion) {
        throw new PotsConflictError();
      }
      const source = await db.pots.get(sourcePotId);
      if (!source || source.batchId !== batchId) {
        throw new ReworkSourceError('被返工的原锅次不存在');
      }
      if (!source.retained) {
        throw new ReworkSourceError('仅留样锅次需要新增返工锅次，未留样锅可直接编辑');
      }

      const existing = await db.pots.where('batchId').equals(batchId).toArray();
      const rework = toPot(
        { ...draft, kind: 'rework' },
        {
          id: uid('pot'),
          batchId,
          herbId: batch.herbId,
          methodId: batch.methodId,
          seq: nextSeq(existing),
          kind: 'rework',
          reworkOfPotId: sourcePotId,
        },
      );
      if (rework.feedKg <= 0) {
        throw new ReworkSourceError('返工锅投料量必须大于 0');
      }
      // 返工投料来自原锅产出的中间品，不能多于原锅产出
      if (rework.feedKg > round1(source.outputKg) + 0.005) {
        throw new ReworkSourceError(`返工投料不能超过原锅产出 ${source.outputKg} kg`);
      }
      assertWithinPotCapacity(rework);

      await db.pots.put(rework);
      await db.batches.put({ ...applyPotSummary(batch, [...existing, rework]), potsVersion: batch.potsVersion + 1 });
    });
    await get().hydrate();
    broadcastChange('pots');
    broadcastChange('batches');
  },

  removePot: async (batchId, potId, expectedVersion) => {
    await db.transaction('rw', db.batches, db.pots, async () => {
      const batch = await db.batches.get(batchId);
      if (!batch) {
        throw new Error('批次不存在，请刷新后重试');
      }
      if (batch.potsVersion !== expectedVersion) {
        throw new PotsConflictError();
      }
      const target = await db.pots.get(potId);
      if (!target || target.batchId !== batchId) {
        throw new Error('锅次不存在，请刷新后重试');
      }
      if (target.retained) {
        throw new PotRetainedError(potId);
      }
      await db.pots.delete(potId);
      const rest = (await db.pots.where('batchId').equals(batchId).toArray()).filter((p) => p.id !== potId);
      if (rest.length === 0) {
        // 锅次清空时批次无存在意义，一并删除（调用方已通过留样校验，不会误删留样来源）
        await db.batches.delete(batchId);
      } else {
        // 序号重排，保持可追溯顺序连续
        const sortedRest = sortPots(rest);
        const reordered = sortedRest.map((p, index) => (p.seq === index + 1 ? p : { ...p, seq: index + 1 }));
        if (reordered.some((p, i) => p.seq !== sortedRest[i].seq)) {
          await db.pots.bulkPut(reordered);
        }
        await db.batches.put({ ...applyPotSummary(batch, reordered), potsVersion: batch.potsVersion + 1 });
      }
    });
    await get().hydrate();
    broadcastChange('pots');
    broadcastChange('batches');
  },

  removePotsOfBatch: async (batchId) => {
    await db.transaction('rw', db.pots, async () => {
      const pots = await db.pots.where('batchId').equals(batchId).toArray();
      await db.pots.bulkDelete(pots.map((p) => p.id));
    });
    set({ pots: get().pots.filter((p) => p.batchId !== batchId) });
    broadcastChange('pots');
  },

  markPotRetained: async (potId, retained) => {
    await db.transaction('rw', db.pots, async () => {
      const pot = await db.pots.get(potId);
      if (pot && pot.retained !== retained) {
        await db.pots.put({ ...pot, retained });
      }
    });
    set({
      pots: sortPots(get().pots.map((p) => (p.id === potId ? { ...p, retained } : p))),
    });
    broadcastChange('pots');
  },

  potsOfBatch: (batchId) => sortPots(get().pots.filter((p) => p.batchId === batchId)),
}));
