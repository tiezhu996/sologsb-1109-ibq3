import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { applyPotSnapshot, nextPotNo, POT_CAPACITY_KG } from '../utils/pots';
import { replacePotsInStore, usePotStore } from './potStore';
import { broadcastChange } from '../utils/sync';
import type { FireLevel } from '../types/processing-method';
import type { ProcessBatch, ProcessDegree, ProcessPot, PotKind } from '../types/process-batch';

/** 提交用的单锅草稿 */
export interface PotDraft {
  id?: string;
  kind: PotKind;
  sourcePotId?: string;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  startedAt: string;
  endedAt: string;
  operator: string;
  remark?: string;
}

export interface BatchCommitInput {
  batchNo: string;
  herbId: string;
  methodId: string;
  fireLevel: FireLevel;
  degree: ProcessDegree;
  remark?: string;
  pots: PotDraft[];
}

/** 提交失败原因（页面据此提示，事务已整体回滚，不会留半锅记录） */
export class BatchCommitError extends Error {
  code: 'EMPTY_POTS' | 'OVER_CAPACITY' | 'OVER_REMAIN' | 'REWORK_SOURCE' | 'FROZEN_POT' | 'VERSION_CONFLICT' | 'NOT_FOUND' | 'INVALID_TIME';

  constructor(code: BatchCommitError['code'], message: string) {
    super(message);
    this.name = 'BatchCommitError';
    this.code = code;
  }
}

interface BatchState {
  batches: ProcessBatch[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /**
   * 原子提交：新建批次（含全部锅次）或整体替换某批次的锅次。
   * 余量/容量/冻结/版本全部在同一个 IndexedDB 事务内校验，
   * 任一校验失败则抛 BatchCommitError，事务回滚，不留半锅记录。
   */
  commitBatch: (input: BatchCommitInput, editingId?: string, expectedVersion?: number) => Promise<ProcessBatch>;
  /** 仅新增一口返工锅（留样冻结后纠正的唯一入口，原锅原值保留） */
  addReworkPot: (batchId: string, draft: Omit<PotDraft, 'kind'>, expectedVersion?: number) => Promise<void>;
  lockBatch: (id: string) => Promise<void>;
  unlockAsQc: (id: string, qcBy: string) => Promise<void>;
  updateBatchMeta: (id: string, patch: Partial<Pick<ProcessBatch, 'degree' | 'remark' | 'fireLevel'>>, force?: boolean) => Promise<boolean>;
  /** 删除批次：先删锅次；任一锅次已留样则拒绝（需先删留样） */
  removeBatch: (id: string) => Promise<void>;
  degreeCount: () => Record<ProcessDegree, number>;
  pendingBatches: () => ProcessBatch[];
  batchesOfHerb: (herbId: string) => ProcessBatch[];
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  batches: [],
  hydrated: false,

  hydrate: async () => {
    const batches = await db.batches.orderBy('startedAt').reverse().toArray();
    set({ batches, hydrated: true });
  },

  commitBatch: async (input, editingId, expectedVersion) => {
    if (!input.pots.length) {
      throw new BatchCommitError('EMPTY_POTS', '至少需要一口锅次');
    }

    const result = await db.transaction('rw', db.batches, db.pots, db.samples, db.herbs, async () => {
      const now = new Date().toISOString();
      let batch: ProcessBatch;

      if (editingId) {
        const existing = await db.batches.get(editingId);
        if (!existing) {
          throw new BatchCommitError('NOT_FOUND', '炮制批次不存在或已被其他标签页删除');
        }
        if (typeof expectedVersion === 'number' && existing.version !== expectedVersion) {
          throw new BatchCommitError('VERSION_CONFLICT', '该批次锅次已被其他标签页修改，请刷新后按最新余量重新分配');
        }
        batch = {
          ...existing,
          batchNo: input.batchNo.trim(),
          herbId: input.herbId,
          methodId: input.methodId,
          fireLevel: input.fireLevel,
          degree: input.degree,
          remark: input.remark?.trim() || undefined,
        };
      } else {
        batch = {
          id: uid('batch'),
          batchNo: input.batchNo.trim(),
          herbId: input.herbId,
          methodId: input.methodId,
          fireLevel: input.fireLevel,
          feedKg: 0,
          auxUsedKg: 0,
          outputKg: 0,
          yieldRate: 0,
          degree: input.degree,
          locked: false,
          potCount: 0,
          reworkCount: 0,
          operator: '',
          startedAt: now,
          endedAt: now,
          version: 0,
          remark: input.remark?.trim() || undefined,
        };
      }

      const oldPots = await db.pots.where('batchId').equals(batch.id).toArray();
      const oldById = new Map(oldPots.map((p) => [p.id, p]));
      const draftIds = new Set(input.pots.map((p) => p.id).filter((v): v is string => Boolean(v)));

      // 被删除的锅次若已有留样则禁止删除
      const removed = oldPots.filter((p) => !draftIds.has(p.id));
      for (const pot of removed) {
        const sampleCount = await db.samples.where('potId').equals(pot.id).count();
        if (sampleCount > 0) {
          throw new BatchCommitError('FROZEN_POT', `锅次 #${pot.potNo} 已有留样，不能删除；如需纠正请新增返工锅次`);
        }
      }

      // 组装备提交的锅次
      const nextPots: ProcessPot[] = input.pots.map((draft) => {
        const feedKg = Number(draft.feedKg) || 0;
        const outputKg = Number(draft.outputKg) || 0;
        const auxUsedKg = Number(draft.auxUsedKg) || 0;
        if (feedKg <= 0) {
          throw new BatchCommitError('EMPTY_POTS', '每口锅的投料量必须大于 0');
        }
        if (outputKg < 0) {
          throw new BatchCommitError('EMPTY_POTS', '产出量不能为负数');
        }
        if (draft.startedAt > draft.endedAt) {
          throw new BatchCommitError('INVALID_TIME', '存在开始时间晚于结束时间的锅次');
        }
        // 单锅容量限制：超出必须分批炮制
        if (draft.kind === 'normal' && feedKg > POT_CAPACITY_KG + 1e-9) {
          throw new BatchCommitError('OVER_CAPACITY', `单锅投料 ${feedKg}kg 超过锅容量 ${POT_CAPACITY_KG}kg，请分批炮制`);
        }

        const previous = draft.id ? oldById.get(draft.id) : undefined;
        if (draft.id && !previous) {
          throw new BatchCommitError('NOT_FOUND', '锅次不存在或已被其他标签页删除，请刷新');
        }
        // 留样冻结：已留样锅次的投料/产出不可修改，只允许新增返工锅
        if (previous?.sampled && (previous.feedKg !== feedKg || previous.outputKg !== outputKg)) {
          throw new BatchCommitError(
            'FROZEN_POT',
            `锅次 #${previous.potNo} 已留样，投料 ${previous.feedKg}kg / 产出 ${previous.outputKg}kg 已冻结，只能新增返工锅次`,
          );
        }

        return {
          id: previous?.id ?? uid('pot'),
          batchId: batch.id,
          potNo: 0, // 编号在下方按类型统一编排
          kind: draft.kind,
          sourcePotId: draft.kind === 'rework' ? draft.sourcePotId : undefined,
          feedKg,
          auxUsedKg,
          outputKg,
          startedAt: draft.startedAt,
          endedAt: draft.endedAt,
          operator: draft.operator.trim(),
          sampled: previous?.sampled ?? false,
          remark: draft.remark?.trim() || undefined,
        } satisfies ProcessPot;
      });

      // 返工锅必须指向同批一口保留中的来源锅，且投料不超过来源锅产出
      for (const pot of nextPots.filter((p) => p.kind === 'rework')) {
        const source = nextPots.find((p) => p.id === pot.sourcePotId) ?? oldPots.find((p) => p.id === pot.sourcePotId);
        if (!source || source.batchId !== batch.id) {
          throw new BatchCommitError('REWORK_SOURCE', '返工锅必须选择本批次内的来源锅次');
        }
        const alreadyReworked = nextPots
          .filter((p) => p.kind === 'rework' && p.sourcePotId === source.id && p.id !== pot.id)
          .reduce((sum, p) => sum + p.feedKg, 0);
        const reworkable = source.outputKg - alreadyReworked;
        if (pot.feedKg > reworkable + 1e-9) {
          throw new BatchCommitError(
            'OVER_REMAIN',
            `返工投料 ${pot.feedKg}kg 超过来源锅剩余可返工量 ${Number(reworkable.toFixed(3))}kg（来源锅产出 ${source.outputKg}kg）`,
          );
        }
      }

      // 正常锅投料合计不得超过药材批次余量（其他标签页/其他炮制批次的占用在事务内实时统计）
      const normalFeed = nextPots.filter((p) => p.kind === 'normal').reduce((sum, p) => sum + p.feedKg, 0);
      const herb = await db.herbs.get(input.herbId);
      if (!herb) {
        throw new BatchCommitError('NOT_FOUND', '关联药材批次不存在');
      }
      const otherBatches = await db.batches.where('herbId').equals(input.herbId).toArray();
      const otherBatchIds = new Set(otherBatches.filter((b) => b.id !== batch.id).map((b) => b.id));
      let usedElsewhere = 0;
      if (otherBatchIds.size > 0) {
        const otherPots = await db.pots.where('batchId').anyOf(Array.from(otherBatchIds)).toArray();
        usedElsewhere = otherPots.filter((p) => p.kind === 'normal').reduce((sum, p) => sum + p.feedKg, 0);
      }
      const remain = herb.feedKg - usedElsewhere;
      if (normalFeed > remain + 1e-9) {
        throw new BatchCommitError(
          'OVER_REMAIN',
          `分锅投料合计 ${Number(normalFeed.toFixed(3))}kg 超过药材批次余量 ${Number(remain.toFixed(3))}kg（${herb.name} ${herb.batchNo} 共 ${herb.feedKg}kg，其他记录已占用 ${Number(usedElsewhere.toFixed(3))}kg）`,
        );
      }

      // 锅号按类型重新编排（保留锅相对顺序）
      let normalNo = 0;
      let reworkNo = 0;
      nextPots.forEach((pot) => {
        pot.potNo = pot.kind === 'normal' ? ++normalNo : ++reworkNo;
      });

      const nextVersion = (batch.version ?? 0) + 1;
      const saved = applyPotSnapshot(batch, nextPots, nextVersion);

      await db.batches.put(saved);
      if (removed.length > 0) {
        await db.pots.bulkDelete(removed.map((p) => p.id));
      }
      await db.pots.bulkPut(nextPots);

      // 内存状态与事务内结果保持一致（失败时不会执行到这里）
      const allPots = usePotStore.getState().pots.filter((p) => p.batchId !== saved.id);
      replacePotsInStore([...allPots, ...nextPots]);

      return saved;
    });

    const batches = get().batches;
    const idx = batches.findIndex((b) => b.id === result.id);
    set({ batches: idx >= 0 ? batches.map((b) => (b.id === result.id ? result : b)) : [result, ...batches] });
    broadcastChange('pots-changed');
    return result;
  },

  addReworkPot: async (batchId, draft, expectedVersion) => {
    const batch = get().batches.find((b) => b.id === batchId);
    const currentPots = usePotStore.getState().potsOfBatch(batchId);
    if (!batch) {
      throw new BatchCommitError('NOT_FOUND', '炮制批次不存在');
    }
    const reworkNo = nextPotNo(currentPots, 'rework');
    await get().commitBatch(
      {
        batchNo: batch.batchNo,
        herbId: batch.herbId,
        methodId: batch.methodId,
        fireLevel: batch.fireLevel,
        degree: batch.degree,
        remark: batch.remark,
        pots: [
          ...currentPots.map((p) => ({
            id: p.id,
            kind: p.kind,
            sourcePotId: p.sourcePotId,
            feedKg: p.feedKg,
            auxUsedKg: p.auxUsedKg,
            outputKg: p.outputKg,
            startedAt: p.startedAt,
            endedAt: p.endedAt,
            operator: p.operator,
            remark: p.remark,
          })),
          {
            kind: 'rework' as PotKind,
            sourcePotId: draft.sourcePotId,
            feedKg: draft.feedKg,
            auxUsedKg: draft.auxUsedKg,
            outputKg: draft.outputKg,
            startedAt: draft.startedAt,
            endedAt: draft.endedAt,
            operator: draft.operator,
            remark: draft.remark ?? `返工锅 ${reworkNo} 号（来源锅原值保留）`,
          },
        ],
      },
      batchId,
      expectedVersion ?? batch.version,
    );
  },

  lockBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current || current.locked) {
      return;
    }
    const potCount = usePotStore.getState().potsOfBatch(id).length;
    if (potCount === 0) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: true, lockedAt: new Date().toISOString() };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    broadcastChange('pots-changed');
  },

  unlockAsQc: async (id, qcBy) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: false, qcBy };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    broadcastChange('pots-changed');
  },

  updateBatchMeta: async (id, patch, force = false) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return false;
    }
    if (current.locked && !force) {
      return false;
    }
    const next: ProcessBatch = { ...current, ...patch, version: current.version + 1 };
    if (force) {
      next.qcBy = next.qcBy ?? '质检员 · 赵敏';
    }
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    broadcastChange('pots-changed');
    return true;
  },

  removeBatch: async (id) => {
    await db.transaction('rw', db.batches, db.pots, db.samples, async () => {
      const sampleCount = await db.samples.where('batchId').equals(id).count();
      if (sampleCount > 0) {
        throw new BatchCommitError('FROZEN_POT', `该批次已有 ${sampleCount} 份留样，请先在留样台账删除留样后再删批次`);
      }
      await db.pots.where('batchId').equals(id).delete();
      await db.batches.delete(id);
    });
    replacePotsInStore(usePotStore.getState().pots.filter((p) => p.batchId !== id));
    set({ batches: get().batches.filter((b) => b.id !== id) });
    broadcastChange('pots-changed');
  },

  degreeCount: () => {
    const result: Record<ProcessDegree, number> = { 不及: 0, 适中: 0, 太过: 0 };
    get().batches.forEach((b) => {
      result[b.degree] += 1;
    });
    return result;
  },

  pendingBatches: () => get().batches.filter((b) => !b.locked),

  batchesOfHerb: (herbId) => get().batches.filter((b) => b.herbId === herbId),
}));
