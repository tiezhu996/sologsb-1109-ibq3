import { create } from 'zustand';
import { db } from '../utils/db';
import type { ProcessPot } from '../types/process-batch';

interface PotState {
  pots: ProcessPot[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 某批次的全部锅次（正常锅在前、返工锅在后，各自按锅号排序） */
  potsOfBatch: (batchId: string) => ProcessPot[];
  potById: (id: string) => ProcessPot | undefined;
}

function sortPots(pots: ProcessPot[]): ProcessPot[] {
  return [...pots].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'normal' ? -1 : 1;
    return a.potNo - b.potNo;
  });
}

export const usePotStore = create<PotState>()((set, get) => ({
  pots: [],
  hydrated: false,

  hydrate: async () => {
    const pots = await db.pots.toArray();
    set({ pots: sortPots(pots), hydrated: true });
  },

  potsOfBatch: (batchId) => sortPots(get().pots.filter((p) => p.batchId === batchId)),

  potById: (id) => get().pots.find((p) => p.id === id),
}));

/** 供事务提交后同步锅次状态（batchStore / sampleStore 调用，避免循环依赖） */
export function replacePotsInStore(next: ProcessPot[]): void {
  usePotStore.setState({ pots: sortPots(next) });
}
