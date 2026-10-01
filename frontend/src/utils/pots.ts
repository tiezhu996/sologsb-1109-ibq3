import type { ProcessBatch, ProcessPot, PotKind } from '../types/process-batch';

/** 单锅最大容量（kg）：超出必须分批炮制 */
export const POT_CAPACITY_KG = 100;

/** 汇总结果：同源锅次总投料 / 总辅料 / 总产出 / 得率 */
export interface PotTotals {
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  /** 得率（%）= 总产出 / 总投料 × 100 */
  yieldRate: number;
  potCount: number;
  reworkCount: number;
}

function round1(v: number): number {
  return Number(v.toFixed(3));
}

/**
 * 同源锅次汇总：总投料、总辅料、总产出逐锅相加；
 * 得率按「总产出 ÷ 总投料」计算（不逐锅平均）。
 * 任一锅变更后由提交事务重新调用本函数。
 */
export function summarizePots(pots: ProcessPot[]): PotTotals {
  const feedKg = pots.reduce((sum, p) => sum + (Number(p.feedKg) || 0), 0);
  const auxUsedKg = pots.reduce((sum, p) => sum + (Number(p.auxUsedKg) || 0), 0);
  const outputKg = pots.reduce((sum, p) => sum + (Number(p.outputKg) || 0), 0);
  const yieldRate = feedKg > 0 ? Number(((outputKg / feedKg) * 100).toFixed(1)) : 0;
  return {
    feedKg: round1(feedKg),
    auxUsedKg: round1(auxUsedKg),
    outputKg: round1(outputKg),
    yieldRate,
    potCount: pots.length,
    reworkCount: pots.filter((p) => p.kind === 'rework').length,
  };
}

/** 下一锅次号：正常锅 / 返工锅各自顺序编号 */
export function nextPotNo(pots: ProcessPot[], kind: PotKind): number {
  return pots.filter((p) => p.kind === kind).length + 1;
}

/** 批次快照中首锅操作人与起止时间 */
export function potTiming(pots: ProcessPot[]): { operator: string; startedAt: string; endedAt: string } {
  if (pots.length === 0) {
    return { operator: '', startedAt: '', endedAt: '' };
  }
  const byStart = [...pots].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const byEnd = [...pots].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  return {
    operator: byStart[0].operator,
    startedAt: byStart[0].startedAt,
    endedAt: byEnd[0].endedAt,
  };
}

/** 把汇总与时间快照写回批次（派生字段统一在此处生成） */
export function applyPotSnapshot(batch: ProcessBatch, pots: ProcessPot[], version: number): ProcessBatch {
  const totals = summarizePots(pots);
  const timing = potTiming(pots);
  return {
    ...batch,
    feedKg: totals.feedKg,
    auxUsedKg: totals.auxUsedKg,
    outputKg: totals.outputKg,
    yieldRate: totals.yieldRate,
    potCount: totals.potCount,
    reworkCount: totals.reworkCount,
    operator: timing.operator,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    version,
  };
}

/**
 * 药材批次已被各炮制批次占用的正常锅投料合计（kg）。
 * 返工锅投料取自前锅产出，不再重复占用药材批次余量。
 */
export function herbUsedKg(
  herbId: string,
  pots: ProcessPot[],
  potBatchOf: (batchId: string) => ProcessBatch | undefined,
  excludeBatchId?: string,
): number {
  return pots
    .filter((p) => p.kind === 'normal')
    .filter((p) => {
      const batch = potBatchOf(p.batchId);
      return Boolean(batch && batch.herbId === herbId && batch.id !== excludeBatchId);
    })
    .reduce((sum, p) => sum + (Number(p.feedKg) || 0), 0);
}
