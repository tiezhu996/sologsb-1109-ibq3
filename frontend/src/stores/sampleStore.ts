import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { buildExpiryList, dueSamples, todayStr } from '../utils/degree';
import { replacePotsInStore, usePotStore } from './potStore';
import { broadcastChange } from '../utils/sync';
import type { ObserveLog, RetainSample, SampleExpiry } from '../types/retain-sample';

/** 留样来源不存在或已被删除时抛出（事务整体回滚） */
export class SampleSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleSourceError';
  }
}

export interface SampleInput {
  sampleNo: string;
  batchId: string;
  /** 来源锅次 id */
  potId: string;
  amountG: number;
  retainMonths: number;
  cabinet: string;
  retainedAt?: string;
}

export interface ObserveInput {
  date: string;
  color: string;
  odor: string;
  mold: string;
  observer: string;
  note?: string;
}

interface SampleState {
  samples: RetainSample[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 登记留样：校验来源锅次存在，并把该锅标记为已留样（冻结投料/产出） */
  createSample: (input: SampleInput) => Promise<RetainSample>;
  removeSample: (id: string) => Promise<void>;
  /** 观察记录按日期追加 */
  appendObserveLog: (sampleId: string, input: ObserveInput) => Promise<void>;
  /** 到期派生清单（按剩余天数升序） */
  expiryList: (warnDays?: number) => SampleExpiry[];
  /** 到期前 30 天提醒清单 */
  dueList: (warnDays?: number) => SampleExpiry[];
  usedCabinets: () => string[];
  /** 某锅次的留样份数 */
  sampleCountOfPot: (potId: string) => number;
}

export const useSampleStore = create<SampleState>()((set, get) => ({
  samples: [],
  hydrated: false,

  hydrate: async () => {
    const samples = await db.samples.toArray();
    set({ samples, hydrated: true });
  },

  createSample: async (input) => {
    const sample: RetainSample = {
      id: uid('sample'),
      sampleNo: input.sampleNo.trim(),
      batchId: input.batchId,
      potId: input.potId,
      amountG: Number(input.amountG) || 0,
      retainMonths: Number(input.retainMonths) || 6,
      cabinet: input.cabinet,
      retainedAt: input.retainedAt ?? new Date().toISOString(),
      observeLogs: [],
    };

    await db.transaction('rw', db.samples, db.pots, async () => {
      const pot = await db.pots.get(input.potId);
      if (!pot || pot.batchId !== input.batchId) {
        throw new SampleSourceError('来源锅次不存在，请刷新后重新选择');
      }
      await db.samples.put(sample);
      if (!pot.sampled) {
        await db.pots.put({ ...pot, sampled: true });
      }
    });

    const frozenPot = usePotStore.getState().pots.find((p) => p.id === input.potId);
    if (frozenPot) {
      replacePotsInStore(
        usePotStore.getState().pots.map((p) => (p.id === frozenPot.id ? { ...p, sampled: true } : p)),
      );
    }
    set({ samples: [...get().samples, sample] });
    broadcastChange('samples-changed');
    return sample;
  },

  removeSample: async (id) => {
    const current = get().samples.find((s) => s.id === id);
    if (!current) {
      return;
    }

    await db.transaction('rw', db.samples, db.pots, async () => {
      await db.samples.delete(id);
      const rest = await db.samples.where('potId').equals(current.potId).count();
      if (rest === 0) {
        const pot = await db.pots.get(current.potId);
        if (pot?.sampled) {
          await db.pots.put({ ...pot, sampled: false });
        }
      }
    });

    const stillFrozen = useSampleStore.getState().samples.some((s) => s.id !== id && s.potId === current.potId);
    if (!stillFrozen) {
      replacePotsInStore(
        usePotStore.getState().pots.map((p) => (p.id === current.potId ? { ...p, sampled: false } : p)),
      );
    }
    set({ samples: get().samples.filter((s) => s.id !== id) });
    broadcastChange('samples-changed');
  },

  appendObserveLog: async (sampleId, input) => {
    const current = get().samples.find((s) => s.id === sampleId);
    if (!current) {
      return;
    }
    const log: ObserveLog = {
      id: uid('log'),
      date: input.date || todayStr(),
      color: input.color,
      odor: input.odor,
      mold: input.mold,
      observer: input.observer,
      note: input.note?.trim() || undefined,
    };
    const logs = [...current.observeLogs, log].sort((a, b) => a.date.localeCompare(b.date));
    const next: RetainSample = { ...current, observeLogs: logs };
    await db.samples.put(next);
    set({ samples: get().samples.map((s) => (s.id === sampleId ? next : s)) });
    broadcastChange('samples-changed');
  },

  expiryList: (warnDays = 30) => buildExpiryList(get().samples, warnDays),

  dueList: (warnDays = 30) => dueSamples(get().samples, warnDays),

  usedCabinets: () => Array.from(new Set(get().samples.map((s) => s.cabinet))),

  sampleCountOfPot: (potId) => get().samples.filter((s) => s.potId === potId).length,
}));
