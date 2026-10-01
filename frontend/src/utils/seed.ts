import { db } from './db';
import { HERB_ORIGINS, type HerbMaterial } from '../types/herb-material';
import { METHOD_NAMES, type ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch, ProcessDegree, ProcessPot } from '../types/process-batch';
import { CABINETS, type RetainSample } from '../types/retain-sample';
import { summarizePots } from './pots';
import { judgeDegree, expectedYieldOf } from './degree';

/** 首次打开时写入的示例台账，便于直接查看各页面效果 */
export const SEED_HERBS: HerbMaterial[] = [
  { id: 'herb-001', name: '白术', origin: '植物', part: '根', batchNo: 'BT-2401', feedKg: 120, receivedAt: '2025-08-02T09:00:00.000Z', remark: '浙江磐安产' },
  { id: 'herb-002', name: '白芍', origin: '植物', part: '根', batchNo: 'BS-2402', feedKg: 80, receivedAt: '2025-08-05T09:00:00.000Z' },
  { id: 'herb-003', name: '当归', origin: '植物', part: '根', batchNo: 'DG-2403', feedKg: 60, receivedAt: '2025-08-06T09:00:00.000Z', remark: '甘肃岷县产' },
  { id: 'herb-004', name: '陈皮', origin: '植物', part: '果实', batchNo: 'CP-2404', feedKg: 45, receivedAt: '2025-08-08T09:00:00.000Z' },
  { id: 'herb-005', name: '黄芪', origin: '植物', part: '根', batchNo: 'HQ-2405', feedKg: 200, receivedAt: '2025-08-11T09:00:00.000Z' },
  { id: 'herb-006', name: '牡蛎', origin: '矿物', part: '果实', batchNo: 'ML-2406', feedKg: 150, receivedAt: '2025-08-12T09:00:00.000Z', remark: '煅用' },
  { id: 'herb-007', name: '全蝎', origin: '动物', part: '茎', batchNo: 'QX-2407', feedKg: 12, receivedAt: '2025-08-14T09:00:00.000Z' },
  { id: 'herb-008', name: '杜仲', origin: '植物', part: '茎', batchNo: 'DZ-2408', feedKg: 90, receivedAt: '2025-08-15T09:00:00.000Z', remark: '盐炙用' },
  { id: 'herb-009', name: '桑叶', origin: '植物', part: '叶', batchNo: 'SY-2409', feedKg: 55, receivedAt: '2025-08-18T09:00:00.000Z' },
  { id: 'herb-010', name: '甘草', origin: '植物', part: '根', batchNo: 'GC-2410', feedKg: 130, receivedAt: '2025-08-20T09:00:00.000Z' },
];

export const SEED_METHODS: ProcessingMethod[] = [
  { id: 'method-001', name: '清炒', auxiliary: '无', auxRatio: 0, fireLevel: '文火', tempRange: [90, 120], duration: 12, criterion: '表面微黄、气香、断面颜色加深', criterionDimension: '色泽', applicable: '白术、桑叶、陈皮' },
  { id: 'method-002', name: '麸炒', auxiliary: '麦麸', auxRatio: 10, fireLevel: '中火', tempRange: [130, 160], duration: 10, criterion: '色转深黄、麸皮焦香、无焦斑', criterionDimension: '色泽', applicable: '白术、黄芪、甘草' },
  { id: 'method-003', name: '酒炙', auxiliary: '黄酒', auxRatio: 10, fireLevel: '文火', tempRange: [100, 130], duration: 15, criterion: '色泽加深、酒气尽、断面棕黄', criterionDimension: '气味', applicable: '当归、白芍、黄芪' },
  { id: 'method-004', name: '醋炙', auxiliary: '米醋', auxRatio: 15, fireLevel: '文火', tempRange: [100, 130], duration: 14, criterion: '表面微亮、醋气尽、无焦糊', criterionDimension: '气味', applicable: '柴胡、延胡索' },
  { id: 'method-005', name: '盐炙', auxiliary: '食盐', auxRatio: 2, fireLevel: '文火', tempRange: [110, 140], duration: 12, criterion: '色泽加深、咸味均匀、断面油润', criterionDimension: '断面', applicable: '杜仲、黄柏' },
  { id: 'method-006', name: '蜜炙', auxiliary: '蜂蜜', auxRatio: 25, fireLevel: '中火', tempRange: [120, 150], duration: 16, criterion: '表面金黄有光泽、不粘手、蜜气香', criterionDimension: '色泽', applicable: '甘草、黄芪、桑叶' },
  { id: 'method-007', name: '蒸', auxiliary: '黄酒', auxRatio: 20, fireLevel: '武火', tempRange: [100, 110], duration: 120, criterion: '内外均呈黑褐色、断面油润光亮', criterionDimension: '断面', applicable: '何首乌、地黄' },
  { id: 'method-008', name: '煮', auxiliary: '米醋', auxRatio: 20, fireLevel: '中火', tempRange: [95, 100], duration: 60, criterion: '无白心、断面角质样、有醋香', criterionDimension: '断面', applicable: '延胡索、乌头' },
  { id: 'method-009', name: '燀', auxiliary: '无', auxRatio: 0, fireLevel: '武火', tempRange: [95, 100], duration: 5, criterion: '种皮易脱落、仁无白心', criterionDimension: '断面', applicable: '苦杏仁、桃仁' },
  { id: 'method-010', name: '煅', auxiliary: '无', auxRatio: 0, fireLevel: '武火', tempRange: [300, 500], duration: 45, criterion: '质酥脆、无光泽、断面灰白', criterionDimension: '断面', applicable: '牡蛎、龙骨' },
  { id: 'method-011', name: '麸炒', auxiliary: '麦麸', auxRatio: 12, fireLevel: '文火', tempRange: [120, 150], duration: 9, criterion: '色黄、麸香明显、无焦斑', criterionDimension: '色泽', applicable: '苍术（派生）', derivedFrom: 'method-002' },
  { id: 'method-012', name: '酒炙', auxiliary: '黄酒', auxRatio: 15, fireLevel: '文火', tempRange: [100, 130], duration: 18, criterion: '酒气尽、断面棕褐、色泽均匀', criterionDimension: '断面', applicable: '川芎（派生）', derivedFrom: 'method-003' },
];

interface SeedPlan {
  batchNo: string;
  herbId: string;
  methodId: string;
  /** 各正常锅投料量（锅容量 100kg，超出的批次拆锅） */
  feeds: number[];
  duration: number;
  fireLevel: ProcessBatch['fireLevel'];
  operator: string;
  remark: string;
  /** 返工锅：[来源锅序号（0 基）, 投料kg] */
  rework?: [number, number];
}

const SEED_PLANS: SeedPlan[] = [
  { batchNo: 'PZ-25081', herbId: 'herb-001', methodId: 'method-002', feeds: [80, 40], duration: 10, fireLevel: '中火', operator: '陈玉兰', remark: '麸炒白术' },
  { batchNo: 'PZ-25082', herbId: 'herb-002', methodId: 'method-003', feeds: [80], duration: 15, fireLevel: '文火', operator: '陈玉兰', remark: '酒炙白芍' },
  { batchNo: 'PZ-25083', herbId: 'herb-003', methodId: 'method-003', feeds: [60], duration: 15, fireLevel: '文火', operator: '刘建国', remark: '酒炙当归，首锅色泽不及返酒复炙', rework: [0, 5] },
  { batchNo: 'PZ-25084', herbId: 'herb-004', methodId: 'method-001', feeds: [45], duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒陈皮' },
  { batchNo: 'PZ-25085', herbId: 'herb-005', methodId: 'method-006', feeds: [100, 100], duration: 16, fireLevel: '中火', operator: '王丽', remark: '蜜炙黄芪' },
  { batchNo: 'PZ-25086', herbId: 'herb-006', methodId: 'method-010', feeds: [100, 50], duration: 45, fireLevel: '武火', operator: '王丽', remark: '煅牡蛎' },
  { batchNo: 'PZ-25087', herbId: 'herb-008', methodId: 'method-005', feeds: [90], duration: 12, fireLevel: '文火', operator: '陈玉兰', remark: '盐炙杜仲' },
  { batchNo: 'PZ-25088', herbId: 'herb-009', methodId: 'method-001', feeds: [55], duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒桑叶' },
  { batchNo: 'PZ-25089', herbId: 'herb-010', methodId: 'method-006', feeds: [100, 30], duration: 16, fireLevel: '中火', operator: '王丽', remark: '蜜炙甘草' },
  { batchNo: 'PZ-25090', herbId: 'herb-007', methodId: 'method-002', feeds: [12], duration: 10, fireLevel: '中火', operator: '王丽', remark: '麸炒全蝎' },
];

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** 生成批次与其锅次（总量/得率为锅次派生快照） */
function buildSeedBatchesAndPots(): { batches: ProcessBatch[]; pots: ProcessPot[] } {
  const batches: ProcessBatch[] = [];
  const pots: ProcessPot[] = [];

  SEED_PLANS.forEach((plan, index) => {
    const method = SEED_METHODS.find((m) => m.id === plan.methodId)!;
    const batchId = `batch-${String(index + 1).padStart(3, '0')}`;
    const expected = expectedYieldOf(method);
    // 各锅结束时间顺序排开
    const endBase = Date.now() - 45 * (index + 1) * 60_000;

    const normalPots: ProcessPot[] = plan.feeds.map((feed, potIndex) => {
      const yieldBias = (((index + potIndex) % 5) - 2) * 0.8;
      const output = Number((feed * ((expected + yieldBias) / 100)).toFixed(3));
      const endedAt = new Date(endBase - potIndex * (plan.duration + 5) * 60_000).toISOString();
      const startedAt = new Date(new Date(endedAt).getTime() - plan.duration * 60_000).toISOString();
      return {
        id: `${batchId}-pot-${String(potIndex + 1).padStart(2, '0')}`,
        batchId,
        potNo: potIndex + 1,
        kind: 'normal' as const,
        feedKg: feed,
        auxUsedKg: Number(((feed * method.auxRatio) / 100).toFixed(3)),
        outputKg: output,
        startedAt,
        endedAt,
        operator: plan.operator,
        sampled: false,
      };
    });

    let allPots = [...normalPots];
    if (plan.rework) {
      const [sourceIndex, reworkFeed] = plan.rework;
      const source = normalPots[sourceIndex];
      const endedAt = new Date(new Date(source.endedAt).getTime() + 25 * 60_000).toISOString();
      const startedAt = new Date(new Date(endedAt).getTime() - plan.duration * 60_000).toISOString();
      allPots.push({
        id: `${batchId}-pot-rw01`,
        batchId,
        potNo: 1,
        kind: 'rework',
        sourcePotId: source.id,
        feedKg: reworkFeed,
        auxUsedKg: Number(((reworkFeed * method.auxRatio) / 100).toFixed(3)),
        outputKg: Number((reworkFeed * (expected / 100)).toFixed(3)),
        startedAt,
        endedAt,
        operator: plan.operator,
        sampled: false,
        remark: '首锅色泽不及，取部分产出返炙，原锅投料/产出保留',
      });
    }

    const totals = summarizePots(allPots);
    const verdict = judgeDegree({
      method,
      fireLevel: plan.fireLevel,
      duration: plan.duration,
      temp: Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
      yieldRate: totals.yieldRate,
    });
    const locked = index >= 2;
    const lastEnded = allPots.map((p) => p.endedAt).sort().at(-1)!;

    batches.push({
      id: batchId,
      batchNo: plan.batchNo,
      herbId: plan.herbId,
      methodId: plan.methodId,
      fireLevel: plan.fireLevel,
      feedKg: totals.feedKg,
      auxUsedKg: totals.auxUsedKg,
      outputKg: totals.outputKg,
      yieldRate: totals.yieldRate,
      degree: verdict.degree as ProcessDegree,
      operator: plan.operator,
      locked,
      lockedAt: locked ? new Date(new Date(lastEnded).getTime() + 30 * 60_000).toISOString() : undefined,
      qcBy: locked ? '质检员 · 赵敏' : undefined,
      potCount: allPots.length,
      reworkCount: allPots.filter((p) => p.kind === 'rework').length,
      startedAt: allPots.map((p) => p.startedAt).sort()[0],
      endedAt: lastEnded,
      version: 1,
      remark: plan.remark,
    });
    pots.push(...allPots);
  });

  return { batches, pots };
}

function buildSeedSamples(batches: ProcessBatch[], pots: ProcessPot[]): RetainSample[] {
  const logs = (date: string, color: string, odor: string, mold: string, observer: string): RetainSample['observeLogs'][number] => ({
    id: `log-${date}-${Math.random().toString(36).slice(2, 7)}`,
    date,
    color,
    odor,
    mold,
    observer,
  });

  return batches.slice(0, 6).map((batch, index) => {
    const retainMonths = [6, 12, 18, 24][index % 4];
    const retainedAt = new Date(Date.now() - (index * 37 + 8) * 86_400_000).toISOString();
    const batchPots = pots.filter((p) => p.batchId === batch.id);
    // 默认从首锅留样；PZ-25085（index 4，两锅各 100kg）从第二锅留样，演示锅次来源差异
    const sourcePot = batchPots[index === 4 ? 1 : 0];
    return {
      id: `sample-${String(index + 1).padStart(3, '0')}`,
      sampleNo: `LY-${batch.batchNo}-${sourcePot.kind === 'rework' ? 'RW' : sourcePot.potNo}`,
      batchId: batch.id,
      potId: sourcePot.id,
      amountG: [200, 300, 500][index % 3],
      retainMonths,
      cabinet: CABINETS[(index * 5) % CABINETS.length],
      retainedAt,
      observeLogs: [
        logs(new Date(retainedAt).toISOString().slice(0, 10), '色泽符合标准', '气味正常', '无霉变', '赵敏'),
        logs(new Date(Date.now() - (index * 11 + 2) * 86_400_000).toISOString().slice(0, 10), '色泽略深', '气味正常', '无霉变', '赵敏'),
      ],
    };
  });
}

/** 首次打开（表内无数据）时写入示例数据；已有数据则不动 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) {
    return;
  }
  const herbCount = await db.herbs.count();
  const methodCount = await db.methods.count();
  const batchCount = await db.batches.count();
  const potCount = await db.pots.count();
  const sampleCount = await db.samples.count();

  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.pots, db.samples, db.meta], async () => {
    if (herbCount === 0) {
      await db.herbs.bulkPut(SEED_HERBS.filter((h) => HERB_ORIGINS.includes(h.origin)));
    }
    if (methodCount === 0) {
      await db.methods.bulkPut(SEED_METHODS.filter((m) => METHOD_NAMES.includes(m.name)));
    }
    const { batches, pots } = buildSeedBatchesAndPots();
    if (batchCount === 0) {
      await db.batches.bulkPut(batches);
    }
    if (potCount === 0 && batchCount === 0) {
      await db.pots.bulkPut(pots);
    }
    if (sampleCount === 0 && batchCount === 0) {
      const samples = buildSeedSamples(batches, pots);
      // 留样锅次回写冻结标记
      const frozen = new Set(samples.map((s) => s.potId));
      await db.pots.toCollection().modify((pot) => {
        if (frozen.has(pot.id)) {
          pot.sampled = true;
        }
      });
      pots.forEach((p) => {
        if (frozen.has(p.id)) p.sampled = true;
      });
      await db.samples.bulkPut(samples);
    }
    await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
  });
}

/** 清空全部本地数据（用于重置演示环境） */
export async function resetAll(): Promise<void> {
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.pots, db.samples, db.meta], async () => {
    await Promise.all([db.herbs.clear(), db.methods.clear(), db.batches.clear(), db.pots.clear(), db.samples.clear(), db.meta.clear()]);
  });
  await seedIfEmpty();
}
