import type { FireLevel } from './processing-method';

/** 炮制程度 */
export type ProcessDegree = '不及' | '适中' | '太过';

/** 锅次类型：正常分锅 / 返工锅（留样冻结后纠正用，保留原锅原值） */
export type PotKind = 'normal' | 'rework';

/**
 * 单锅炮制记录（可追溯的最小生产单元）。
 * 药材批次锅容量不足时分批炮制，每锅独立记录投料、辅料与产出。
 */
export interface ProcessPot {
  id: string;
  /** 所属炮制批次 id */
  batchId: string;
  /** 锅次号：正常锅从 1 起编，返工锅独立从 1 起编 */
  potNo: number;
  /** 锅次类型 */
  kind: PotKind;
  /** 返工锅的来源锅次 id（kind=rework 必填） */
  sourcePotId?: string;
  /** 本锅投料量（kg） */
  feedKg: number;
  /** 本锅辅料实际用量（kg） */
  auxUsedKg: number;
  /** 本锅产出量（kg） */
  outputKg: number;
  /** 开始时间 ISO */
  startedAt: string;
  /** 结束时间 ISO */
  endedAt: string;
  /** 操作人 */
  operator: string;
  /** 留样后冻结：投料与产出不可再改，只能新增返工锅次 */
  sampled: boolean;
  /** 备注 */
  remark?: string;
}

/** 炮制工序记录（一个生产批号，由一至多个同源锅次组成） */
export interface ProcessBatch {
  id: string;
  /** 生产批号 */
  batchNo: string;
  /** 关联药材 */
  herbId: string;
  /** 采用方法 */
  methodId: string;
  /** 火候 */
  fireLevel: FireLevel;
  /** 总投料量（kg，派生日：同源锅次合计） */
  feedKg: number;
  /** 辅料实际总用量（kg，派生日：同源锅次合计） */
  auxUsedKg: number;
  /** 总产出量（kg，派生日：同源锅次合计） */
  outputKg: number;
  /** 得率（%，派生日：总产出 / 总投料 × 100） */
  yieldRate: number;
  /** 程度判定 */
  degree: ProcessDegree;
  /** 得率与程度提交后锁定，仅质检员可改 */
  locked: boolean;
  /** 锁定时间 */
  lockedAt?: string;
  /** 质检员放行/改判人 */
  qcBy?: string;
  /** 锅次数（含返工锅） */
  potCount: number;
  /** 返工锅次数 */
  reworkCount: number;
  /** 首锅操作人（快照，便于时间线等列表展示） */
  operator: string;
  /** 最早一锅开始时间 ISO（快照） */
  startedAt: string;
  /** 最晚一锅结束时间 ISO（快照） */
  endedAt: string;
  /** 乐观锁版本：任一锅次变更 +1，跨标签页并发提交时校验 */
  version: number;
  /** 备注 */
  remark?: string;
}

/** 程度判定规则说明 */
export interface DegreeRule {
  degree: ProcessDegree;
  condition: string;
  action: string;
}

export const PROCESS_DEGREES: ProcessDegree[] = ['不及', '适中', '太过'];

/** 锅次展示标签：正常锅 #1，返工锅 返1 */
export function potLabel(pot: Pick<ProcessPot, 'potNo' | 'kind'>): string {
  return pot.kind === 'rework' ? `返${pot.potNo}` : `#${pot.potNo}`;
}
