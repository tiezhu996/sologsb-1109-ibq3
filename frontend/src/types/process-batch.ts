import type { FireLevel } from './processing-method';

/** 炮制程度 */
export type ProcessDegree = '不及' | '适中' | '太过';

/** 锅次类型：normal 常规分锅，rework 留样后新增的返工锅次 */
export type PotKind = 'normal' | 'rework';

/**
 * 炮制锅次：药材批次受锅容量限制分批炮制的最小可追溯单位。
 * 每锅独立记录投料、辅料实际用量与产出，留样来源也精确到锅次。
 */
export interface ProcessPot {
  id: string;
  /** 所属炮制批次（同批锅次同药材、同方法） */
  batchId: string;
  /** 同源药材 */
  herbId: string;
  /** 炮制方法 */
  methodId: string;
  /** 锅次序号（同批内从 1 起，返工锅次顺延） */
  seq: number;
  /** 锅次类型 */
  kind: PotKind;
  /** 锅容量上限（kg），单锅投料不得超过 */
  capacityKg: number;
  /** 本锅投料量（kg）；返工锅的投料为待返工的中间品 */
  feedKg: number;
  /** 本锅辅料实际用量（kg） */
  auxUsedKg: number;
  /** 本锅炮制后产出（kg） */
  outputKg: number;
  /** 火候 */
  fireLevel: FireLevel;
  /** 实际锅温（℃） */
  temp: number;
  /** 炮制时长（min） */
  duration: number;
  /** 开始时间 ISO */
  startedAt: string;
  /** 结束时间 ISO */
  endedAt: string;
  /** 程度判定 */
  degree: ProcessDegree;
  /** 操作人 */
  operator: string;
  /** 是否已留样（留样后本锅投料/辅料/产出冻结，只能新增返工锅次） */
  retained: boolean;
  /** 返工锅次：被返工的原锅 id；常规锅次为空 */
  reworkOfPotId?: string;
  /** 备注 */
  remark?: string;
}

/** 炮制工序批次：同源锅次的分组汇总，总量与得率随锅次变更重算 */
export interface ProcessBatch {
  id: string;
  /** 生产批号 */
  batchNo: string;
  /** 关联药材 */
  herbId: string;
  /** 采用方法 */
  methodId: string;
  /** 总投料量（kg），同源锅次投料之和 */
  feedKg: number;
  /** 辅料实际总用量（kg），同源锅次辅料之和 */
  auxUsedKg: number;
  /** 总产出（kg），同源锅次产出之和 */
  outputKg: number;
  /** 得率（%）= 总产出 / 总投料 × 100，锅次变更时重算 */
  yieldRate: number;
  /** 汇总程度：存在太过即太过，否则存在不及即不及，否则适中 */
  degree: ProcessDegree;
  /** 开始时间 ISO（取最早下锅时间） */
  startedAt: string;
  /** 结束时间 ISO（取最晚出锅时间） */
  endedAt: string;
  /** 锅次数量 */
  potCount: number;
  /** 锅次数据版本号：任一锅次变更即 +1，两个标签页并发修改时用作乐观锁 */
  potsVersion: number;
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

export const POT_KIND_LABEL: Record<PotKind, string> = {
  normal: '常规锅',
  rework: '返工锅',
};
