import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import FilterBar from '../components/common/FilterBar';
import FireLevelTag from '../components/common/FireLevelTag';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHerbFilter } from '../hooks/useHerbFilter';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useBatchStore, BatchCommitError, type PotDraft } from '../stores/batchStore';
import { usePotStore } from '../stores/potStore';
import { useSampleStore } from '../stores/sampleStore';
import { HERB_ORIGINS, HERB_PARTS } from '../types/herb-material';
import { FIRE_LEVELS, type FireLevel } from '../types/processing-method';
import { PROCESS_DEGREES, potLabel, type ProcessBatch, type ProcessDegree, type ProcessPot } from '../types/process-batch';
import { DEGREE_RULES, judgeDegree, suggestedValues } from '../utils/degree';
import { POT_CAPACITY_KG, summarizePots } from '../utils/pots';

const { Title, Paragraph, Text } = Typography;

interface PotRowValues {
  key: string;
  kind: 'normal' | 'rework';
  sourcePotKey?: string;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  startedAt: Dayjs;
  endedAt: Dayjs;
  operator: string;
  remark?: string;
  /** 已存在锅次 id（编辑时） */
  potId?: string;
  /** 已留样冻结（仅回显，用 tag 展示） */
  sampled?: boolean;
}

interface BatchFormValues {
  batchNo: string;
  herbId: string;
  methodId: string;
  fireLevel: FireLevel;
  temp: number;
  duration: number;
  operator: string;
  degree: ProcessDegree;
  remark?: string;
  pots: PotRowValues[];
}

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

let rowSeq = 0;
const newRowKey = () => `row-${Date.now().toString(36)}-${++rowSeq}`;

/** 工序记录台：药材批次按锅容量拆成可追溯锅次，每锅记投料/辅料/产出 */
export default function BatchBoard() {
  const { message } = AntApp.useApp();
  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const batches = useBatchStore((s) => s.batches);
  const commitBatch = useBatchStore((s) => s.commitBatch);
  const addReworkPot = useBatchStore((s) => s.addReworkPot);
  const lockBatch = useBatchStore((s) => s.lockBatch);
  const unlockAsQc = useBatchStore((s) => s.unlockAsQc);
  const removeBatch = useBatchStore((s) => s.removeBatch);
  const pots = usePotStore((s) => s.pots);
  const sampleCountOfPot = useSampleStore((s) => s.sampleCountOfPot);

  const herbFilter = useHerbFilter();
  const [params] = useSearchParams();
  const degreeParam = params.get('degree') ?? '';

  const [form] = Form.useForm<BatchFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessBatch | null>(null);
  const [qcMode, setQcMode] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reworkTarget, setReworkTarget] = useState<ProcessBatch | null>(null);
  const [reworkForm] = Form.useForm<{ sourcePotId: string; feedKg: number; auxUsedKg: number; outputKg: number; operator: string; remark?: string }>();
  const [reworkSubmitting, setReworkSubmitting] = useState(false);

  const watched = Form.useWatch([], form) as Partial<BatchFormValues> | undefined;
  const watchedRows = watched?.pots ?? [];
  const watchedMethod = methods.find((m) => m.id === (watched?.methodId ?? ''));
  const watchedHerb = herbs.find((h) => h.id === (watched?.herbId ?? ''));

  /** 表单内锅次的实时合计（同源锅次总量与得率随任一锅变更重算） */
  const watchedTotals = useMemo(() => {
    const draft: ProcessPot[] = watchedRows.map((r, i) => ({
      id: r.potId ?? r.key ?? `tmp-${i}`,
      batchId: editing?.id ?? 'tmp',
      potNo: i + 1,
      kind: r.kind,
      feedKg: Number(r.feedKg) || 0,
      auxUsedKg: Number(r.auxUsedKg) || 0,
      outputKg: Number(r.outputKg) || 0,
      startedAt: r.startedAt?.toISOString?.() ?? '',
      endedAt: r.endedAt?.toISOString?.() ?? '',
      operator: r.operator ?? '',
      sampled: Boolean(r.sampled),
    }));
    return summarizePots(draft);
  }, [watchedRows, editing?.id]);

  /** 药材批次余量：总量 − 其他炮制批次的正常锅占用（编辑时排除本批） */
  const herbRemain = useMemo(() => {
    if (!watchedHerb) return 0;
    const otherNormalFeed = pots
      .filter((p) => p.kind === 'normal')
      .filter((p) => p.batchId !== editing?.id)
      .filter((p) => batches.some((b) => b.id === p.batchId && b.herbId === watchedHerb.id))
      .reduce((sum, p) => sum + p.feedKg, 0);
    return Number((watchedHerb.feedKg - otherNormalFeed).toFixed(3));
  }, [watchedHerb, pots, batches, editing?.id]);

  const watchedNormalFeed = watchedRows.filter((r) => r.kind === 'normal').reduce((s, r) => s + (Number(r.feedKg) || 0), 0);
  const overRemain = watchedNormalFeed > herbRemain + 1e-9;
  const overCapacityRows = watchedRows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.kind === 'normal' && (Number(r.feedKg) || 0) > POT_CAPACITY_KG + 1e-9);

  const watchedYieldRate = watchedTotals.yieldRate;

  const verdict = useMemo(() => {
    if (!watchedMethod) return undefined;
    return judgeDegree({
      method: watchedMethod,
      fireLevel: (watched?.fireLevel ?? watchedMethod.fireLevel) as FireLevel,
      duration: Number(watched?.duration) || watchedMethod.duration,
      temp: Number(watched?.temp) || Math.round((watchedMethod.tempRange[0] + watchedMethod.tempRange[1]) / 2),
      yieldRate: watchedYieldRate,
    });
  }, [watchedMethod, watched?.fireLevel, watched?.duration, watched?.temp, watchedYieldRate]);

  const visibleHerbs = useMemo(() => herbFilter.apply(herbs), [herbs, herbFilter]);
  const visibleBatches = useMemo(() => {
    const ids = new Set(visibleHerbs.map((h) => h.id));
    return batches.filter((b) => {
      if (!ids.has(b.herbId)) return false;
      if (degreeParam && b.degree !== degreeParam) return false;
      return true;
    });
  }, [batches, visibleHerbs, degreeParam]);

  const herbName = (id: string) => herbs.find((h) => h.id === id)?.name ?? '未知药材';
  const methodOf = (id: string) => methods.find((m) => m.id === id);

  /** 按锅容量自动拆分剩余投料为多锅 */
  const splitByCapacity = (totalKg: number): number[] => {
    const total = Number(totalKg) || 0;
    if (total <= 0) return [];
    const result: number[] = [];
    let rest = total;
    while (rest > POT_CAPACITY_KG + 1e-9) {
      result.push(POT_CAPACITY_KG);
      rest = Number((rest - POT_CAPACITY_KG).toFixed(3));
    }
    if (rest > 1e-9) result.push(Number(rest.toFixed(3)));
    return result;
  };

  const buildRow = (partial: Partial<PotRowValues> & Pick<PotRowValues, 'kind' | 'feedKg'>): PotRowValues => {
    const now = dayjs();
    const method = watchedMethod;
    const feed = Number(partial.feedKg) || 0;
    return {
      key: newRowKey(),
      kind: partial.kind,
      sourcePotKey: partial.sourcePotKey,
      feedKg: feed,
      auxUsedKg: partial.auxUsedKg ?? (method ? Number(((feed * method.auxRatio) / 100).toFixed(2)) : 0),
      outputKg: partial.outputKg ?? Number((feed * (method?.name === '蜜炙' ? 1.08 : 0.94)).toFixed(3)),
      startedAt: partial.startedAt ?? now.subtract(20, 'minute'),
      endedAt: partial.endedAt ?? now,
      operator: partial.operator ?? watched?.operator ?? '陈玉兰',
      remark: partial.remark,
      potId: partial.potId,
      sampled: partial.sampled,
    };
  };

  const openCreate = () => {
    setEditing(null);
    setQcMode(false);
    const firstHerb = herbs[0];
    const firstMethod = methods[0];
    const now = dayjs();
    const feed = firstHerb?.feedKg ?? 100;
    form.setFieldsValue({
      batchNo: `PZ-${dayjs().format('YYMMDD')}-${String(batches.length + 1).padStart(2, '0')}`,
      herbId: firstHerb?.id,
      methodId: firstMethod?.id,
      fireLevel: firstMethod?.fireLevel ?? '文火',
      temp: firstMethod ? Math.round((firstMethod.tempRange[0] + firstMethod.tempRange[1]) / 2) : 100,
      duration: firstMethod?.duration ?? 12,
      operator: '陈玉兰',
      degree: '适中',
      pots: splitByCapacity(feed).map((kg) =>
        buildRow({
          kind: 'normal',
          feedKg: kg,
          auxUsedKg: firstMethod ? Number(((kg * firstMethod.auxRatio) / 100).toFixed(2)) : 0,
          outputKg: Number((kg * (firstMethod?.name === '蜜炙' ? 1.08 : 0.94)).toFixed(3)),
          startedAt: now.subtract(20, 'minute'),
          endedAt: now,
        }),
      ),
    } as unknown as BatchFormValues);
    setOpen(true);
  };

  const openEdit = (record: ProcessBatch) => {
    setEditing(record);
    setQcMode(false);
    const method = methodOf(record.methodId);
    const batchPots = usePotStore.getState().potsOfBatch(record.id);
    const rows: PotRowValues[] = batchPots.map((pot) => ({
      key: newRowKey(),
      kind: pot.kind,
      feedKg: pot.feedKg,
      auxUsedKg: pot.auxUsedKg,
      outputKg: pot.outputKg,
      startedAt: dayjs(pot.startedAt),
      endedAt: dayjs(pot.endedAt),
      operator: pot.operator,
      remark: pot.remark,
      potId: pot.id,
      sampled: pot.sampled,
    }));
    rows.forEach((row) => {
      const pot = batchPots.find((p) => p.id === row.potId);
      if (pot?.sourcePotId) {
        const sourceRow = rows.find((r) => r.potId === pot.sourcePotId);
        if (sourceRow) row.sourcePotKey = sourceRow.key;
      }
    });
    form.setFieldsValue({
      batchNo: record.batchNo,
      herbId: record.herbId,
      methodId: record.methodId,
      fireLevel: record.fireLevel,
      temp: method ? Math.round((method.tempRange[0] + method.tempRange[1]) / 2) : 100,
      duration: method?.duration ?? 12,
      operator: record.operator,
      degree: record.degree,
      remark: record.remark,
      pots: rows,
    } as unknown as BatchFormValues);
    setOpen(true);
  };

  /** 把表单锅次行转为提交草稿；已留样锅维持其原 id */
  const rowsToDrafts = (rows: PotRowValues[]): PotDraft[] =>
    rows.map((row) => {
      const sourceId = row.kind === 'rework' ? rows.find((r) => r.key === row.sourcePotKey)?.potId : undefined;
      return {
        id: row.potId,
        kind: row.kind,
        sourcePotId: sourceId,
        feedKg: Number(row.feedKg) || 0,
        auxUsedKg: Number(row.auxUsedKg) || 0,
        outputKg: Number(row.outputKg) || 0,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt.toISOString(),
        operator: row.operator,
        remark: row.remark,
      };
    });

  const submit = async () => {
    const values = await form.validateFields();
    if (!values.pots?.length) {
      message.error('至少需要一口锅次');
      return;
    }
    if (overRemain) {
      message.error(`分锅投料合计 ${watchedNormalFeed}kg 已超出药材批次余量 ${herbRemain}kg，请调整后再提交`);
      return;
    }
    if (overCapacityRows.length) {
      message.error(`存在单锅投料超过锅容量 ${POT_CAPACITY_KG}kg 的锅次，请继续分锅`);
      return;
    }

    setSubmitting(true);
    try {
      await commitBatch(
        {
          batchNo: values.batchNo,
          herbId: values.herbId,
          methodId: values.methodId,
          fireLevel: values.fireLevel,
          degree: values.degree,
          remark: values.remark,
          pots: rowsToDrafts(values.pots),
        },
        editing?.id,
        editing?.version,
      );
      message.success(
        editing
          ? `已保存 ${values.batchNo}：${watchedTotals.potCount} 锅，总投料 ${watchedTotals.feedKg}kg，得率 ${watchedTotals.yieldRate}%`
          : `已提交 ${values.batchNo}：${watchedTotals.potCount} 锅，总投料 ${watchedTotals.feedKg}kg，得率 ${watchedTotals.yieldRate}%`,
      );
      setOpen(false);
    } catch (error) {
      if (error instanceof BatchCommitError) {
        message.error(error.message);
      } else {
        message.error(`提交失败，已回滚：${(error as Error).message}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openRework = (record: ProcessBatch) => {
    setReworkTarget(record);
    const batchPots = usePotStore.getState().potsOfBatch(record.id);
    const firstNormal = batchPots.find((p) => p.kind === 'normal');
    const method = methodOf(record.methodId);
    const feed = firstNormal ? Math.min(10, firstNormal.outputKg) : 10;
    reworkForm.resetFields();
    reworkForm.setFieldsValue({
      sourcePotId: firstNormal?.id,
      feedKg: Number(feed.toFixed(3)),
      auxUsedKg: method ? Number(((feed * method.auxRatio) / 100).toFixed(2)) : 0,
      outputKg: Number((feed * 0.94).toFixed(3)),
      operator: record.operator,
      remark: '留样后返工，原锅投料/产出保留',
    });
  };

  const submitRework = async () => {
    if (!reworkTarget) return;
    const values = await reworkForm.validateFields();
    setReworkSubmitting(true);
    try {
      await addReworkPot(
        reworkTarget.id,
        {
          sourcePotId: values.sourcePotId,
          feedKg: Number(values.feedKg) || 0,
          auxUsedKg: Number(values.auxUsedKg) || 0,
          outputKg: Number(values.outputKg) || 0,
          startedAt: dayjs().subtract(20, 'minute').toISOString(),
          endedAt: dayjs().toISOString(),
          operator: values.operator,
          remark: values.remark,
        },
        reworkTarget.version,
      );
      message.success(`已为 ${reworkTarget.batchNo} 新增返工锅，同源总量与得率已重算`);
      setReworkTarget(null);
    } catch (error) {
      message.error(error instanceof BatchCommitError ? error.message : `返工锅提交失败，已回滚：${(error as Error).message}`);
    } finally {
      setReworkSubmitting(false);
    }
  };

  const expandedRowRender = (record: ProcessBatch) => {
    const batchPots = usePotStore.getState().potsOfBatch(record.id);
    const totals = summarizePots(batchPots);
    const columns: TableColumnsType<ProcessPot> = [
      { title: '锅次', width: 80, render: (_, p) => (p.kind === 'rework' ? <Tag color="purple">返{p.potNo}</Tag> : <Tag color="geekblue">#{p.potNo}</Tag>) },
      {
        title: '来源锅',
        width: 90,
        render: (_, p) => {
          if (p.kind !== 'rework') return <Text type="secondary">-</Text>;
          const source = batchPots.find((q) => q.id === p.sourcePotId);
          return source ? potLabel(source) : '已删除';
        },
      },
      { title: '投料(kg)', dataIndex: 'feedKg', width: 100, align: 'right' },
      { title: '辅料(kg)', dataIndex: 'auxUsedKg', width: 100, align: 'right' },
      { title: '产出(kg)', dataIndex: 'outputKg', width: 100, align: 'right' },
      {
        title: '锅得率(%)',
        width: 100,
        align: 'right',
        render: (_, p) => (p.feedKg > 0 ? <Text type={((p.outputKg / p.feedKg) * 100) < 85 ? 'danger' : undefined}>{((p.outputKg / p.feedKg) * 100).toFixed(1)}</Text> : '-'),
      },
      { title: '操作人', dataIndex: 'operator', width: 90 },
      {
        title: '留样',
        width: 150,
        render: (_, p) => (p.sampled ? <Tag color="blue">已留样（{sampleCountOfPot(p.id)} 份，投料/产出冻结）</Tag> : <Tag>未留样</Tag>),
      },
      { title: '备注', dataIndex: 'remark', render: (v?: string) => v ?? '-' },
    ];
    return (
      <div>
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={batchPots}
          pagination={false}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={2}>
                  <Text strong>同源锅次合计（{totals.potCount} 锅{totals.reworkCount > 0 ? `，含返工 ${totals.reworkCount} 锅` : ''}）</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right"><Text strong>{totals.feedKg}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right"><Text strong>{totals.auxUsedKg}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right"><Text strong>{totals.outputKg}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  <Text strong type={totals.yieldRate < 85 ? 'danger' : undefined}>{totals.yieldRate}%</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} colSpan={3}>
                  <Text type="secondary">得率 = 总产出 {totals.outputKg}kg ÷ 总投料 {totals.feedKg}kg</Text>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </div>
    );
  };

  const columns: TableColumnsType<ProcessBatch> = [
    { title: '生产批号', dataIndex: 'batchNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: '药材', dataIndex: 'herbId', width: 90, render: (id: string) => herbName(id) },
    { title: '方法', dataIndex: 'methodId', width: 90, render: (id: string) => methodOf(id)?.name ?? '-' },
    {
      title: '锅次',
      width: 110,
      render: (_, record) => (
        <Space size={4}>
          <Tag color="geekblue">{record.potCount} 锅</Tag>
          {record.reworkCount > 0 ? <Tag color="purple">返工 {record.reworkCount}</Tag> : null}
        </Space>
      ),
    },
    {
      title: '火候',
      dataIndex: 'fireLevel',
      width: 170,
      render: (v: FireLevel, record) => <FireLevelTag level={v} tempRange={methodOf(record.methodId)?.tempRange} duration={methodOf(record.methodId)?.duration} />,
    },
    { title: '总投料(kg)', dataIndex: 'feedKg', width: 100, align: 'right' },
    { title: '总辅料(kg)', dataIndex: 'auxUsedKg', width: 100, align: 'right' },
    { title: '总产出(kg)', dataIndex: 'outputKg', width: 100, align: 'right' },
    { title: '得率(%)', dataIndex: 'yieldRate', width: 90, align: 'right', render: (v: number) => <Text type={v < 85 ? 'danger' : undefined}>{v}</Text> },
    { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
    {
      title: '状态',
      dataIndex: 'locked',
      width: 100,
      render: (locked: boolean, record) =>
        locked ? <Tag color="blue">已锁定{record.qcBy ? ` · ${record.qcBy}` : ''}</Tag> : <Tag>待判定</Tag>,
    },
    {
      title: '操作',
      width: 260,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            {record.locked ? '质检改判' : '分锅编辑'}
          </Button>
          <Button size="small" type="link" onClick={() => openRework(record)}>
            返工
          </Button>
          {!record.locked ? (
            <Button size="small" type="link" onClick={() => lockBatch(record.id).then(() => message.success('已锁定该批'))}>
              锁定
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => unlockAsQc(record.id, '质检员 · 赵敏').then(() => message.success('质检员已放行，可重新编辑'))}>
              放行
            </Button>
          )}
          <Popconfirm title={`确认删除 ${record.batchNo}？其锅次将一并删除`} onConfirm={() => removeBatch(record.id).then(() => message.success('已删除')).catch((e) => message.error((e as Error).message))}>
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  /** 弹窗内锅次编辑表 */
  const renderPotEditor = () => {
    const rows = (watched?.pots ?? []) as PotRowValues[];
    const frozen = frozenDisabled();

    /** 同类型锅次序号（正常锅、返工锅各自计数） */
    const potOrdinal = (index: number) => rows.slice(0, index + 1).filter((r) => r.kind === rows[index].kind).length;

    const editableColumns: TableColumnsType<PotRowValues> = [
      {
        title: '锅次',
        width: 64,
        render: (_: unknown, row: PotRowValues, index: number) =>
          row.kind === 'rework' ? <Tag color="purple">返{potOrdinal(index)}</Tag> : <Tag color="geekblue">#{potOrdinal(index)}</Tag>,
      },
      {
        title: '来源锅',
        width: 120,
        render: (_: unknown, row: PotRowValues, index: number) => {
          if (row.kind !== 'rework') return <Text type="secondary">药材分锅</Text>;
          return (
            <Form.Item name={['pots', index, 'sourcePotKey']} noStyle rules={[{ required: true, message: '选来源锅' }]}>
              <Select
                size="small"
                style={{ width: 100 }}
                options={rows
                  .filter((r) => r.key !== row.key)
                  .map((r, i) => ({ label: r.kind === 'rework' ? `返${potOrdinal(i)}` : `#${potOrdinal(i)}`, value: r.key }))}
              />
            </Form.Item>
          );
        },
      },
      {
        title: '投料(kg)',
        width: 130,
        render: (_: unknown, row: PotRowValues, index: number) => {
          const overCap = row.kind === 'normal' && (Number(row.feedKg) || 0) > POT_CAPACITY_KG + 1e-9;
          return (
            <Form.Item
              name={['pots', index, 'feedKg']}
              noStyle
              rules={[{ required: true, message: '必填' }]}
              validateStatus={overCap ? 'error' : undefined}
              help={overCap ? `超锅容量 ${POT_CAPACITY_KG}kg` : undefined}
            >
              <InputNumber min={0} step={1} size="small" style={{ width: 110 }} disabled={Boolean(row.sampled) || frozen} status={overCap ? 'error' : undefined} />
            </Form.Item>
          );
        },
      },
      {
        title: '辅料(kg)',
        width: 120,
        render: (_: unknown, __: PotRowValues, index: number) => (
          <Form.Item name={['pots', index, 'auxUsedKg']} noStyle rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={0} step={0.1} size="small" style={{ width: 100 }} disabled={frozen} />
          </Form.Item>
        ),
      },
      {
        title: '产出(kg)',
        width: 120,
        render: (_: unknown, row: PotRowValues, index: number) => (
          <Form.Item name={['pots', index, 'outputKg']} noStyle rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={0} step={0.5} size="small" style={{ width: 100 }} disabled={Boolean(row.sampled) || frozen} />
          </Form.Item>
        ),
      },
      {
        title: '锅得率',
        width: 80,
        align: 'right',
        render: (_: unknown, row: PotRowValues) => {
          const rate = row.feedKg > 0 ? Number(((row.outputKg / row.feedKg) * 100).toFixed(1)) : 0;
          return <Text type={rate < 85 ? 'danger' : undefined}>{rate}%</Text>;
        },
      },
      {
        title: '操作人/时间',
        width: 300,
        render: (_: unknown, __: PotRowValues, index: number) => (
          <Space size={4} wrap>
            <Form.Item name={['pots', index, 'operator']} noStyle rules={[{ required: true, message: '操作人' }]}>
              <Input size="small" style={{ width: 80 }} maxLength={16} disabled={frozen} />
            </Form.Item>
            <Form.Item name={['pots', index, 'startedAt']} noStyle rules={[{ required: true, message: '开始' }]}>
              <DatePicker showTime size="small" style={{ width: 168 }} disabled={frozen} />
            </Form.Item>
            <Text type="secondary">至</Text>
            <Form.Item name={['pots', index, 'endedAt']} noStyle rules={[{ required: true, message: '结束' }]}>
              <DatePicker showTime size="small" style={{ width: 168 }} disabled={frozen} />
            </Form.Item>
          </Space>
        ),
      },
      {
        title: '留样/备注',
        width: 220,
        render: (_: unknown, row: PotRowValues, index: number) => (
          <Space size={4} wrap>
            {row.sampled ? <Tag color="blue">已留样冻结</Tag> : null}
            <Form.Item name={['pots', index, 'remark']} noStyle>
              <Input size="small" style={{ width: 190 }} placeholder="备注" maxLength={60} disabled={frozen} />
            </Form.Item>
          </Space>
        ),
      },
      {
        title: '操作',
        width: 80,
        render: (_: unknown, row: PotRowValues) => (
          <Button
            size="small"
            type="link"
            danger
            disabled={Boolean(row.sampled) || frozen}
            onClick={() => {
              const next = form.getFieldValue('pots') as PotRowValues[];
              form.setFieldsValue({ pots: next.filter((r) => r.key !== row.key) } as unknown as Partial<BatchFormValues>);
            }}
          >
            删锅
          </Button>
        ),
      },
    ];

    return (
      <div>
        <Space style={{ marginBottom: 8 }} wrap>
          <Button
            size="small"
            disabled={frozen || overRemain}
            onClick={() => {
              const current = (form.getFieldValue('pots') ?? []) as PotRowValues[];
              const room = Number((herbRemain - current.filter((r) => r.kind === 'normal').reduce((s, r) => s + (Number(r.feedKg) || 0), 0)).toFixed(3));
              const feed = Math.min(POT_CAPACITY_KG, room > 0 ? room : 0);
              form.setFieldsValue({ pots: [...current, buildRow({ kind: 'normal', feedKg: Number(feed.toFixed(3)) })] } as unknown as Partial<BatchFormValues>);
            }}
          >
            加一口锅
          </Button>
          <Button
            size="small"
            disabled={frozen || rows.length === 0}
            onClick={() => {
              const current = (form.getFieldValue('pots') ?? []) as PotRowValues[];
              const first = current.find((r) => r.kind === 'normal') ?? current[0];
              form.setFieldsValue({
                pots: [...current, buildRow({ kind: 'rework', feedKg: 10, sourcePotKey: first?.key })],
              } as unknown as Partial<BatchFormValues>);
            }}
          >
            加返工锅
          </Button>
          <Text type="secondary">
            锅容量 {POT_CAPACITY_KG}kg/锅；药材批次余量 <Text strong type={overRemain ? 'danger' : undefined}>{herbRemain}kg</Text>
            （{watchedHerb?.name ?? '-'} {watchedHerb?.batchNo ?? '-'} 共 {watchedHerb?.feedKg ?? 0}kg）
          </Text>
          {overRemain ? <Tag color="red">正常锅投料合计 {watchedNormalFeed}kg 已超余量</Tag> : null}
        </Space>

        <Table
          rowKey="key"
          size="small"
          columns={editableColumns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1200 }}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={2}>
                  <Text strong>同源合计（{watchedTotals.potCount} 锅{watchedTotals.reworkCount > 0 ? `，含返工 ${watchedTotals.reworkCount}` : ''}）</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right"><Text strong>{watchedTotals.feedKg}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right"><Text strong>{watchedTotals.auxUsedKg}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right"><Text strong>{watchedTotals.outputKg}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  <Text strong type={watchedTotals.yieldRate < 85 ? 'danger' : undefined}>{watchedTotals.yieldRate}%</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} colSpan={3}>
                  <Text type="secondary">得率 = {watchedTotals.outputKg} ÷ {watchedTotals.feedKg} × 100%；正常锅投料 {watchedNormalFeed}kg / 余量 {herbRemain}kg</Text>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </div>
    );
  };

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        炮制工序记录台
      </Title>
      <Paragraph type="secondary">
        药材批次按锅容量（{POT_CAPACITY_KG}kg/锅）拆成可追溯锅次，每锅独立记录投料、辅料与产出；同源锅次总投料、总辅料与得率随任一锅变更重算（得率=总产出÷总投料）。锅次留样后投料与产出冻结，只能新增返工锅次。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={openCreate}>
          新建分锅炮制记录
        </Button>
        <Button onClick={() => setShowRules((v) => !v)}>{showRules ? '收起程度判定规则' : '查看程度判定规则'}</Button>
      </Space>

      {showRules ? (
        <Card size="small" style={{ marginBottom: 12 }} title="炮制程度判定规则">
          <Table
            rowKey="degree"
            size="small"
            pagination={false}
            dataSource={DEGREE_RULES}
            columns={[
              { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
              { title: '判定条件', dataIndex: 'condition' },
              { title: '处置', dataIndex: 'action', width: 280 },
            ]}
          />
        </Card>
      ) : null}

      <FilterBar
        fields={[
          { key: 'origin', label: '基原', options: HERB_ORIGINS, width: 110 },
          { key: 'part', label: '药用部位', options: HERB_PARTS, width: 110 },
          { key: 'degree', label: '程度', options: PROCESS_DEGREES, width: 110 },
        ]}
        resultCount={visibleBatches.length}
        totalCount={batches.length}
        keywordPlaceholder="搜索药材名 / 批号"
      />

      {visibleBatches.length === 0 ? (
        <EmptyPanel description="没有符合条件的工序记录" actionText="新建分锅炮制记录" onAction={openCreate} />
      ) : (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={visibleBatches}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 1500 }}
          expandable={{ expandedRowRender, rowExpandable: () => true }}
        />
      )}

      <Modal
        open={open}
        title={editing ? `分锅编辑 · ${editing.batchNo}` : '新建分锅炮制记录'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText={editing ? '保存（事务提交，失败回滚）' : '提交'}
        cancelText="取消"
        width={1280}
        confirmLoading={submitting}
        okButtonProps={{ danger: overRemain || overCapacityRows.length > 0 }}
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('methodId' in changed) {
              const method = methods.find((m) => m.id === changed.methodId);
              if (method) {
                const suggestion = suggestedValues(method);
                form.setFieldsValue({
                  fireLevel: method.fireLevel,
                  temp: suggestion.temp,
                  duration: suggestion.duration,
                } as unknown as Partial<BatchFormValues>);
                // 更换方法后按新辅料比例折算每口未冻结锅的辅料
                const rows = (form.getFieldValue('pots') ?? []) as PotRowValues[];
                form.setFieldsValue({
                  pots: rows.map((r) =>
                    r.sampled
                      ? r
                      : { ...r, auxUsedKg: Number(((Number(r.feedKg) || 0) * method.auxRatio / 100).toFixed(2)) },
                  ),
                } as unknown as Partial<BatchFormValues>);
              }
            }
            if (verdict && ('temp' in changed || 'duration' in changed)) {
              form.setFieldsValue({ degree: verdict.degree } as unknown as Partial<BatchFormValues>);
            }
            // 任一锅投料/产出变更时，按总量重算建议程度（得率来自同源合计）
            if (changed.pots && verdict) {
              form.setFieldsValue({ degree: verdict.degree } as unknown as Partial<BatchFormValues>);
            }
          }}
        >
          {editing?.locked ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="该批得率与程度已锁定，仅质检员可改；已留样锅次的投料/产出任何情况下都不能直接改"
              action={<Switch checkedChildren="质检员改判" unCheckedChildren="只读" checked={qcMode} onChange={setQcMode} />}
            />
          ) : null}

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]} style={{ flex: 1 }}>
              <Input maxLength={24} disabled={frozenDisabled()} />
            </Form.Item>
            <Form.Item name="herbId" label="药材批次" rules={[{ required: true, message: '请选择药材' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={frozenDisabled()}
                options={herbs.map((h) => {
                  const used = pots
                    .filter((p) => p.kind === 'normal')
                    .filter((p) => batches.some((b) => b.id === p.batchId && b.herbId === h.id && b.id !== editing?.id))
                    .reduce((s, p) => s + p.feedKg, 0);
                  return { label: `${h.name} · ${h.batchNo}（${h.feedKg}kg，余量 ${Number((h.feedKg - used).toFixed(1))}kg）`, value: h.id };
                })}
              />
            </Form.Item>
            <Form.Item name="methodId" label="炮制方法" rules={[{ required: true, message: '请选择炮制方法' }]} style={{ flex: 1 }}>
              <Select
                disabled={frozenDisabled()}
                options={methods.map((m) => ({ label: `${m.name} · ${m.auxiliary} ${m.auxRatio}kg/100kg`, value: m.id }))}
              />
            </Form.Item>
          </Space>

          {watchedMethod ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                <Space wrap size={8}>
                  <span>辅料比例 {watchedMethod.auxRatio}kg/100kg</span>
                  <FireLevelTag level={watchedMethod.fireLevel} tempRange={watchedMethod.tempRange} duration={watchedMethod.duration} />
                  <Tag>{watchedMethod.criterionDimension}</Tag>
                </Space>
              }
              description={`判断标准：${watchedMethod.criterion}；适用药材：${watchedMethod.applicable}`}
            />
          ) : null}

          <Card size="small" title="锅次明细（每锅投料 / 辅料 / 产出独立可追溯）" style={{ marginBottom: 12 }}>
            {renderPotEditor()}
          </Card>

          <Space size={12} style={{ display: 'flex', marginTop: 4 }} align="start">
            <Form.Item name="fireLevel" label="火力" rules={[{ required: true, message: '请选择火力' }]}>
              <Select style={{ width: 120 }} disabled={frozenDisabled()} options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="temp" label="实际锅温(℃)" rules={[{ required: true, message: '请输入实际锅温' }]}>
              <InputNumber min={0} max={800} style={{ width: 140 }} disabled={frozenDisabled()} />
            </Form.Item>
            <Form.Item name="duration" label="炮制时长(min)" rules={[{ required: true, message: '请输入炮制时长' }]}>
              <InputNumber min={0} style={{ width: 140 }} disabled={frozenDisabled()} />
            </Form.Item>
          </Space>

          <Alert
            type={verdict?.degree === '适中' ? 'success' : verdict?.degree === '太过' ? 'error' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`系统判定：${verdict?.degree ?? '待录入火候与得率'}（同源总得率 ${watchedYieldRate}%，预期 ${verdict?.expectedYield ?? '-'}%）`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(verdict?.reasons ?? ['选择方法并录入锅温、时长、各锅产出后自动判定']).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />

          <Form.Item name="degree" label="程度判定（可按判断标准复核后修改）" rules={[{ required: true, message: '请选择程度' }]}>
            <Select disabled={frozenDisabled()} style={{ maxWidth: 240 }} options={PROCESS_DEGREES.map((v) => ({ label: v, value: v }))} />
          </Form.Item>

          <Form.Item name="remark" label="批次备注">
            <Input.TextArea rows={2} maxLength={80} disabled={frozenDisabled()} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 留样后新增返工锅次（原锅投料/产出保留） */}
      <Modal
        open={Boolean(reworkTarget)}
        title={reworkTarget ? `新增返工锅次 · ${reworkTarget.batchNo}` : ''}
        onCancel={() => setReworkTarget(null)}
        onOk={submitRework}
        okText="提交返工锅（事务提交，失败回滚）"
        cancelText="取消"
        width={640}
        confirmLoading={reworkSubmitting}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="返工锅用于留样冻结后的纠正：来源锅次的投料与产出保留原值；返工投料取自来源锅产出，不能超过其剩余可返工量。"
        />
        <Form form={reworkForm} layout="vertical">
          <Form.Item name="sourcePotId" label="来源锅次" rules={[{ required: true, message: '请选择来源锅次' }]}>
            <Select
              options={reworkTarget
                ? usePotStore.getState().potsOfBatch(reworkTarget.id).map((p) => {
                    const reworked = usePotStore
                      .getState()
                      .potsOfBatch(reworkTarget.id)
                      .filter((q) => q.kind === 'rework' && q.sourcePotId === p.id)
                      .reduce((s, q) => s + q.feedKg, 0);
                    return {
                      label: `${potLabel(p)} · 产出 ${p.outputKg}kg，可返工 ${Number((p.outputKg - reworked).toFixed(3))}kg${p.sampled ? '（已留样）' : ''}`,
                      value: p.id,
                    };
                  })
                : []}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="feedKg" label="返工投料(kg)" rules={[{ required: true, message: '请输入返工投料' }]}>
              <InputNumber min={0} step={0.5} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="auxUsedKg" label="辅料(kg)" rules={[{ required: true, message: '请输入辅料' }]}>
              <InputNumber min={0} step={0.1} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="outputKg" label="返工产出(kg)" rules={[{ required: true, message: '请输入返工产出' }]}>
              <InputNumber min={0} step={0.5} style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
            <Input style={{ maxWidth: 200 }} maxLength={16} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );

  function frozenDisabled() {
    return Boolean(editing?.locked) && !qcMode;
  }
}
