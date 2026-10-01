import { create } from 'zustand';
import { db } from '../utils/db';
import { broadcastChange } from '../utils/sync';
import type { ProcessBatch, ProcessDegree } from '../types/process-batch';

interface BatchState {
  batches: ProcessBatch[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 更新批次级信息（批号、关联药材/方法、备注）；关联关系变更会同步到锅次 */
  updateBatchMeta: (
    id: string,
    patch: Partial<Pick<ProcessBatch, 'batchNo' | 'herbId' | 'methodId' | 'remark'>>,
  ) => Promise<boolean>;
  /** 删除批次：有留样（任意锅次已留样）时拒绝；同时清理锅次 */
  removeBatch: (id: string, hasRetainedPot: boolean) => Promise<boolean>;
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

  updateBatchMeta: async (id, patch) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return false;
    }
    const next: ProcessBatch = {
      ...current,
      ...(patch.batchNo !== undefined ? { batchNo: patch.batchNo.trim() } : {}),
      ...(patch.herbId !== undefined ? { herbId: patch.herbId } : {}),
      ...(patch.methodId !== undefined ? { methodId: patch.methodId } : {}),
      ...(patch.remark !== undefined ? { remark: patch.remark?.trim() || undefined } : {}),
    };
    const relink = patch.herbId !== undefined || patch.methodId !== undefined;
    await db.transaction('rw', db.batches, db.pots, async () => {
      await db.batches.put(next);
      if (relink) {
        const pots = await db.pots.where('batchId').equals(id).toArray();
        await db.pots.bulkPut(
          pots.map((p) => ({
            ...p,
            herbId: next.herbId,
            methodId: next.methodId,
          })),
        );
      }
    });
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    if (relink) {
      broadcastChange('pots');
    }
    broadcastChange('batches');
    return true;
  },

  removeBatch: async (id, hasRetainedPot) => {
    if (hasRetainedPot) {
      // 留样来源锅次必须可追溯，禁止整批删除
      return false;
    }
    await db.transaction('rw', db.batches, db.pots, db.samples, async () => {
      const samples = await db.samples.where('batchId').equals(id).toArray();
      if (samples.length > 0) {
        throw new Error('该批次存在留样记录，不能删除');
      }
      await db.pots.where('batchId').equals(id).delete();
      await db.batches.delete(id);
    });
    set({ batches: get().batches.filter((b) => b.id !== id) });
    broadcastChange('pots');
    broadcastChange('batches');
    return true;
  },

  degreeCount: () => {
    const result: Record<ProcessDegree, number> = { 不及: 0, 适中: 0, 太过: 0 };
    get().batches.forEach((b) => {
      result[b.degree] += 1;
    });
    return result;
  },

  pendingBatches: () => get().batches,

  batchesOfHerb: (herbId) => get().batches.filter((b) => b.herbId === herbId),
}));
