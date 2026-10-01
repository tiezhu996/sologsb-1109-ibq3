import type { HerbMaterial } from '../types/herb-material';
import type { ProcessBatch, ProcessDegree, ProcessPot } from '../types/process-batch';

/** 分锅用量超过药材余量 */
export class HerbRemainingError extends Error {
  constructor(public remainingKg: number) {
    super(`分锅投料合计超出药材余量（剩余 ${Number(remainingKg.toFixed(2))} kg），请减少投料`);
    this.name = 'HerbRemainingError';
  }
}

/** 单锅投料超过锅容量 */
export class PotCapacityError extends Error {
  constructor(public seq: number, public capacityKg: number) {
    super(`第 ${seq} 锅投料超过锅容量 ${capacityKg} kg，请分锅或下调投料`);
    this.name = 'PotCapacityError';
  }
}

/** 锅次留样后尝试直接修改投料/产出 */
export class PotRetainedError extends Error {
  constructor(public potId: string) {
    super('该锅次已留样，投料、辅料与产出不可直接修改；请新增返工锅次保留原值');
    this.name = 'PotRetainedError';
  }
}

/** 两个标签页并发修改同一批次分锅用量（乐观锁版本冲突） */
export class PotsConflictError extends Error {
  constructor() {
    super('分锅用量已在另一标签页被修改（余量已变化），请刷新后重试');
    this.name = 'PotsConflictError';
  }
}

/** 返工锅次参数问题 */
export class ReworkSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReworkSourceError';
  }
}

/** 浮点比较容差（kg），避免 0.1+0.2 类误差误判超量 */
export const KG_EPSILON = 0.005;

/** 同源锅次汇总：总投料、总辅料、总产出与得率（总产出 / 总投料） */
export interface PotSummary {
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  yieldRate: number;
  degree: ProcessDegree;
  potCount: number;
  startedAt: string;
  endedAt: string;
}

export function round1(v: number): number {
  return Number(v.toFixed(1));
}

export function round2(v: number): number {
  return Number(v.toFixed(2));
}

/**
 * 汇总同源锅次。任一锅次变更后重算：
 * 得率 = 总产出 / 总投料 × 100；程度按「太过优先于不及」聚合。
 */
export function summarizePots(pots: ProcessPot[]): PotSummary | null {
  if (pots.length === 0) {
    return null;
  }
  const feedKg = round2(pots.reduce((s, p) => s + p.feedKg, 0));
  const auxUsedKg = round2(pots.reduce((s, p) => s + p.auxUsedKg, 0));
  const outputKg = round2(pots.reduce((s, p) => s + p.outputKg, 0));
  const yieldRate = feedKg > 0 ? round1((outputKg / feedKg) * 100) : 0;
  const degree: ProcessDegree = pots.some((p) => p.degree === '太过')
    ? '太过'
    : pots.some((p) => p.degree === '不及')
      ? '不及'
      : '适中';
  const times = pots
    .flatMap((p) => [p.startedAt, p.endedAt])
    .filter(Boolean)
    .sort();
  return {
    feedKg,
    auxUsedKg,
    outputKg,
    yieldRate,
    degree,
    potCount: pots.length,
    startedAt: times[0] ?? new Date(0).toISOString(),
    endedAt: times[times.length - 1] ?? new Date(0).toISOString(),
  };
}

/** 按批次重算汇总字段（不改变身份字段） */
export function applyPotSummary(batch: ProcessBatch, pots: ProcessPot[]): ProcessBatch {
  const summary = summarizePots(pots);
  if (!summary) {
    return batch;
  }
  return {
    ...batch,
    feedKg: summary.feedKg,
    auxUsedKg: summary.auxUsedKg,
    outputKg: summary.outputKg,
    yieldRate: summary.yieldRate,
    degree: summary.degree,
    potCount: summary.potCount,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
  };
}

/** 同批锅次排序：先常规锅后返工锅，序号优先、再按开始时间 */
export function sortPots(pots: ProcessPot[]): ProcessPot[] {
  return [...pots].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.startedAt.localeCompare(b.startedAt);
  });
}

/**
 * 药材余量 = 药材来量 − 该药材在各批次常规锅中的投料合计。
 * 返工锅投的是中间品，不再占用药材余量；excludeBatchId 用于编辑时排除本批。
 */
export function herbRemaining(
  herb: HerbMaterial | undefined,
  allPots: ProcessPot[],
  excludeBatchId?: string,
): number {
  if (!herb) {
    return 0;
  }
  const used = allPots
    .filter((p) => p.herbId === herb.id && p.kind === 'normal' && p.batchId !== excludeBatchId)
    .reduce((s, p) => s + p.feedKg, 0);
  return round2(herb.feedKg - used);
}

/** 校验一组（待写入的）常规锅投料是否超出药材余量 */
export function assertWithinHerbRemaining(
  herb: HerbMaterial | undefined,
  nextNormalFeedKg: number,
  allPots: ProcessPot[],
  excludeBatchId?: string,
): void {
  const remaining = herbRemaining(herb, allPots, excludeBatchId);
  if (nextNormalFeedKg > remaining + KG_EPSILON) {
    throw new HerbRemainingError(remaining);
  }
}

/** 校验单锅投料不超锅容量 */
export function assertWithinPotCapacity(pot: Pick<ProcessPot, 'seq' | 'feedKg' | 'capacityKg'>): void {
  if (pot.feedKg > pot.capacityKg + KG_EPSILON) {
    throw new PotCapacityError(pot.seq, pot.capacityKg);
  }
}

/**
 * 按锅容量自动分锅：将 totalKg 切成每份不超过 capacityKg 的投料。
 * 末锅余数过小时并入上一锅（保证不超容量）。
 */
export function splitFeedByCapacity(totalKg: number, capacityKg: number): number[] {
  if (totalKg <= 0 || capacityKg <= 0) {
    return [];
  }
  const parts: number[] = [];
  let rest = round2(totalKg);
  while (rest > capacityKg + KG_EPSILON) {
    parts.push(capacityKg);
    rest = round2(rest - capacityKg);
  }
  if (rest > KG_EPSILON) {
    parts.push(rest);
  }
  // 末锅过小（不足容量 10%）且已有前锅时并入，避免极短一锅
  if (parts.length >= 2 && parts[parts.length - 1] < capacityKg * 0.1) {
    const last = parts.pop()!;
    parts[parts.length - 1] = round2(parts[parts.length - 1] + last);
  }
  return parts;
}
