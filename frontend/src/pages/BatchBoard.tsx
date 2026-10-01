import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import { InfoCircleOutlined } from '@ant-design/icons';
import FilterBar from '../components/common/FilterBar';
import FireLevelTag from '../components/common/FireLevelTag';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHerbFilter } from '../hooks/useHerbFilter';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useBatchStore } from '../stores/batchStore';
import { usePotStore, type PotDraft, type ReworkDraft } from '../stores/potStore';
import { HERB_ORIGINS, HERB_PARTS } from '../types/herb-material';
import { FIRE_LEVELS, type FireLevel, type ProcessingMethod } from '../types/processing-method';
import {
  POT_KIND_LABEL,
  PROCESS_DEGREES,
  type ProcessBatch,
  type ProcessDegree,
  type ProcessPot,
} from '../types/process-batch';
import { DEGREE_RULES, judgeDegree, suggestedValues } from '../utils/degree';
import {
  HerbRemainingError,
  PotCapacityError,
  PotRetainedError,
  PotsConflictError,
  ReworkSourceError,
  herbRemaining,
  round1,
  splitFeedByCapacity,
} from '../utils/pots';
import { uid } from '../utils/id';

const { Title, Paragraph, Text } = Typography;

/** 新建批次表单中的单锅行（火候/时间/操作人同批共用，在批次表头统一录） */
interface PotFormItem {
  capacityKg: number;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  temp: number;
  duration: number;
}

interface BatchFormValues {
  batchNo: string;
  herbId: string;
  methodId: string;
  capacityKg: number;
  /** 待分锅的总投料量，按锅容量自动拆分 */
  totalFeedKg: number;
  fireLevel: FireLevel;
  startedAt: Dayjs;
  endedAt: Dayjs;
  operator: string;
  remark?: string;
  pots: PotFormItem[];
}

interface PotFormValues {
  capacityKg: number;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  fireLevel: FireLevel;
  temp: number;
  duration: number;
  startedAt: Dayjs;
  endedAt: Dayjs;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
}

type PotModalState =
  | { mode: 'edit'; batch: ProcessBatch; pot: ProcessPot }
  | { mode: 'rework'; batch: ProcessBatch; source: ProcessPot };

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

/** 默认产出系数（蜜炙辅料被吸收，得率可超 100%） */
function outputFactor(method?: ProcessingMethod): number {
  return method?.name === '蜜炙' ? 1.08 : 0.94;
}

/** 工序记录台：药材批次按锅容量分批炮制，每锅可追溯投料、辅料与产出 */
export default function BatchBoard() {
  const { message } = AntApp.useApp();
  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const batches = useBatchStore((s) => s.batches);
  const removeBatch = useBatchStore((s) => s.removeBatch);
  const updateBatchMeta = useBatchStore((s) => s.updateBatchMeta);
  const pots = usePotStore((s) => s.pots);
  const createBatchWithPots = usePotStore((s) => s.createBatchWithPots);
  const updatePot = usePotStore((s) => s.updatePot);
  const addReworkPot = usePotStore((s) => s.addReworkPot);
  const removePot = usePotStore((s) => s.removePot);

  const herbFilter = useHerbFilter();
  const [params] = useSearchParams();
  const degreeParam = params.get('degree') ?? '';

  const [createOpen, setCreateOpen] = useState(false);
  const [metaTarget, setMetaTarget] = useState<ProcessBatch | null>(null);
  const [potModal, setPotModal] = useState<PotModalState | null>(null);
  const [showRules, setShowRules] = useState(false);
  const submittingRef = useRef(false);

  const [createForm] = Form.useForm<BatchFormValues>();
  const [metaForm] = Form.useForm<{ batchNo: string; remark?: string }>();
  const [potForm] = Form.useForm<PotFormValues>();

  const watchedCreate = Form.useWatch([], createForm) as Partial<BatchFormValues> | undefined;
  const createMethod = methods.find((m) => m.id === watchedCreate?.methodId);
  const createHerb = herbs.find((h) => h.id === watchedCreate?.herbId);
  const createPots = watchedCreate?.pots ?? [];

  const degreeOfRow = (row: PotFormItem, fireLevel: FireLevel | undefined, method: ProcessingMethod | undefined): ProcessDegree | undefined => {
    if (!method) return undefined;
    const feed = Number(row.feedKg) || 0;
    const out = Number(row.outputKg) || 0;
    if (feed <= 0) return undefined;
    return judgeDegree({
      method,
      fireLevel: fireLevel ?? method.fireLevel,
      duration: Number(row.duration) || method.duration,
      temp: Number(row.temp) || Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
      yieldRate: round1((out / feed) * 100),
    }).degree;
  };

  /** 新建表单内药材余量（尚未创建的批次不占用排除项） */
  const createRemaining = useMemo(() => {
    if (!createHerb) return 0;
    const planned = createPots.reduce((s, p) => s + (Number(p?.feedKg) || 0), 0);
    return round1(herbRemaining(createHerb, pots) - planned);
  }, [createHerb, pots, createPots]);

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

  // ---------- 新建批次（含多锅） ----------

  const openCreate = () => {
    const firstHerb = herbs[0];
    const firstMethod = methods[0];
    const now = dayjs();
    const capacity = 50;
    const totalFeed = Math.min(firstHerb?.feedKg ?? 100, capacity);
    createForm.resetFields();
    createForm.setFieldsValue({
      batchNo: `PZ-${dayjs().format('YYMMDD')}-${String(batches.length + 1).padStart(2, '0')}`,
      herbId: firstHerb?.id,
      methodId: firstMethod?.id,
      capacityKg: capacity,
      totalFeedKg: totalFeed,
      fireLevel: firstMethod?.fireLevel ?? '文火',
      startedAt: now.subtract(20, 'minute'),
      endedAt: now,
      operator: '陈玉兰',
      pots: [
        {
          capacityKg: capacity,
          feedKg: totalFeed,
          auxUsedKg: Number(((totalFeed * (firstMethod?.auxRatio ?? 0)) / 100).toFixed(2)),
          outputKg: Number((totalFeed * outputFactor(firstMethod)).toFixed(1)),
          temp: firstMethod ? Math.round((firstMethod.tempRange[0] + firstMethod.tempRange[1]) / 2) : 100,
          duration: firstMethod?.duration ?? 12,
        },
      ],
    } as unknown as BatchFormValues);
    setCreateOpen(true);
  };

  /** 按总投料 + 锅容量自动分锅，逐锅折算辅料与产出 */
  const autoSplit = () => {
    const values = createForm.getFieldsValue();
    const totalFeed = Number(values.totalFeedKg) || 0;
    const capacity = Number(values.capacityKg) || 0;
    const method = methods.find((m) => m.id === values.methodId);
    const parts = splitFeedByCapacity(totalFeed, capacity);
    if (parts.length === 0) {
      message.warning('请先填写有效的总投料量与锅容量');
      return;
    }
    const rows: PotFormItem[] = parts.map((feedKg) => ({
      capacityKg: capacity,
      feedKg,
      auxUsedKg: Number(((feedKg * (method?.auxRatio ?? 0)) / 100).toFixed(2)),
      outputKg: Number((feedKg * outputFactor(method)).toFixed(1)),
      temp: method ? Math.round((method.tempRange[0] + method.tempRange[1]) / 2) : 100,
      duration: method?.duration ?? 12,
    }));
    createForm.setFieldsValue({ pots: rows } as unknown as Partial<BatchFormValues>);
    message.success(`已按锅容量 ${capacity}kg 分为 ${rows.length} 锅`);
  };

  const submitCreate = async () => {
    if (submittingRef.current) return;
    const values = await createForm.validateFields();
    const rows = (values.pots ?? []).map((p) => ({
      ...p,
      feedKg: Number(p.feedKg) || 0,
      auxUsedKg: Number(p.auxUsedKg) || 0,
      outputKg: Number(p.outputKg) || 0,
      capacityKg: Number(p.capacityKg) || 0,
    }));
    if (rows.length === 0) {
      message.error('至少录入一个锅次');
      return;
    }
    if (rows.some((p) => p.feedKg <= 0)) {
      message.error('每锅投料量必须大于 0');
      return;
    }
    const overCap = rows.find((p) => p.feedKg > p.capacityKg + 0.005);
    if (overCap) {
      message.error(`存在锅次投料 ${overCap.feedKg}kg 超过锅容量 ${overCap.capacityKg}kg`);
      return;
    }
    const method = methodOf(values.methodId);
    const drafts: PotDraft[] = rows.map((p) => ({
      capacityKg: p.capacityKg,
      feedKg: p.feedKg,
      auxUsedKg: p.auxUsedKg,
      outputKg: p.outputKg,
      fireLevel: values.fireLevel,
      temp: Number(p.temp) || 0,
      duration: Number(p.duration) || 0,
      startedAt: values.startedAt.toISOString(),
      endedAt: values.endedAt.toISOString(),
      degree: degreeOfRow(p, values.fireLevel, method) ?? '适中',
      operator: values.operator,
      remark: undefined,
      kind: 'normal',
    }));
    submittingRef.current = true;
    try {
      // 多锅在同一事务提交：超余量/超容量时整体回滚，不留半锅记录
      await createBatchWithPots(
        {
          id: uid('batch'),
          batchNo: values.batchNo,
          herbId: values.herbId,
          methodId: values.methodId,
          remark: values.remark,
        },
        drafts,
      );
      message.success(`已登记 ${values.batchNo}：${drafts.length} 锅，总投料 ${drafts.reduce((s, d) => s + d.feedKg, 0)}kg`);
      setCreateOpen(false);
    } catch (error) {
      message.error(describeError(error));
    } finally {
      submittingRef.current = false;
    }
  };

  // ---------- 锅次编辑 / 返工 ----------

  const openPotEdit = (batch: ProcessBatch, pot: ProcessPot) => {
    setPotModal({ mode: 'edit', batch, pot });
    potForm.resetFields();
    potForm.setFieldsValue({
      capacityKg: pot.capacityKg,
      feedKg: pot.feedKg,
      auxUsedKg: pot.auxUsedKg,
      outputKg: pot.outputKg,
      fireLevel: pot.fireLevel,
      temp: pot.temp,
      duration: pot.duration,
      startedAt: dayjs(pot.startedAt),
      endedAt: dayjs(pot.endedAt),
      degree: pot.degree,
      operator: pot.operator,
      remark: pot.remark,
    } as unknown as PotFormValues);
  };

  const openRework = (batch: ProcessBatch, source: ProcessPot) => {
    setPotModal({ mode: 'rework', batch, source });
    const method = methodOf(batch.methodId);
    const suggestion = suggestedValues(method!);
    const feed = source.outputKg;
    const now = dayjs();
    potForm.resetFields();
    potForm.setFieldsValue({
      capacityKg: source.capacityKg,
      feedKg: feed,
      auxUsedKg: Number(((feed * (method?.auxRatio ?? 0)) / 100).toFixed(2)),
      outputKg: Number((feed * outputFactor(method)).toFixed(1)),
      fireLevel: method?.fireLevel ?? source.fireLevel,
      temp: suggestion.temp,
      duration: suggestion.duration,
      startedAt: now.subtract(method?.duration ?? 12, 'minute'),
      endedAt: now,
      degree: '适中',
      operator: source.operator,
    } as unknown as PotFormValues);
  };

  /** 留样锅弹窗只展示只读信息，并引导去开返工锅 */
  const switchToRework = () => {
    if (potModal?.mode === 'edit') {
      openRework(potModal.batch, potModal.pot);
    }
  };

  const watchedPot = Form.useWatch([], potForm) as Partial<PotFormValues> | undefined;
  const potVerdict = useMemo(() => {
    if (!potModal) return undefined;
    const method =
      potModal.mode === 'edit' ? methodOf(potModal.pot.methodId) : methodOf(potModal.batch.methodId);
    if (!method) return undefined;
    const feed = Number(watchedPot?.feedKg) || 0;
    const out = Number(watchedPot?.outputKg) || 0;
    if (feed <= 0) return undefined;
    return judgeDegree({
      method,
      fireLevel: (watchedPot?.fireLevel ?? method.fireLevel) as FireLevel,
      duration: Number(watchedPot?.duration) || method.duration,
      temp: Number(watchedPot?.temp) || Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
      yieldRate: round1((out / feed) * 100),
    });
  }, [potModal, watchedPot, methods]);

  const submitPot = async () => {
    if (!potModal) return;
    if (submittingRef.current) return;
    const values = await potForm.validateFields();
    const feedKg = Number(values.feedKg) || 0;
    if (feedKg <= 0) {
      message.error('投料量必须大于 0');
      return;
    }
    const draft: PotDraft = {
      capacityKg: Number(values.capacityKg) || 0,
      feedKg,
      auxUsedKg: Number(values.auxUsedKg) || 0,
      outputKg: Number(values.outputKg) || 0,
      fireLevel: values.fireLevel,
      temp: Number(values.temp) || 0,
      duration: Number(values.duration) || 0,
      startedAt: values.startedAt.toISOString(),
      endedAt: values.endedAt.toISOString(),
      degree: potVerdict?.degree ?? values.degree,
      operator: values.operator,
      remark: values.remark,
    };
    submittingRef.current = true;
    try {
      if (potModal.mode === 'edit') {
        if (potModal.pot.retained) {
          throw new PotRetainedError(potModal.pot.id);
        }
        await updatePot(potModal.batch.id, potModal.pot.id, potModal.batch.potsVersion, draft);
        message.success(`第 ${potModal.pot.seq} 锅已更新，批次总量与得率已重算`);
      } else {
        const reworkDraft: ReworkDraft = { ...draft, reworkOfPotId: potModal.source.id };
        await addReworkPot(potModal.batch.id, potModal.source.id, potModal.batch.potsVersion, reworkDraft);
        message.success(`已新增返工锅次，原第 ${potModal.source.seq} 锅投料/产出原值保留`);
      }
      setPotModal(null);
    } catch (error) {
      if (error instanceof PotsConflictError) {
        message.error(error.message);
      } else {
        message.error(describeError(error));
      }
    } finally {
      submittingRef.current = false;
    }
  };

  // ---------- 批次级信息（批号/备注；药材与方法在创建后不可变以保证追溯） ----------

  const openMetaEdit = (batch: ProcessBatch) => {
    setMetaTarget(batch);
    metaForm.resetFields();
    metaForm.setFieldsValue({ batchNo: batch.batchNo, remark: batch.remark });
  };

  const submitMeta = async () => {
    if (!metaTarget) return;
    const values = await metaForm.validateFields();
    const ok = await updateBatchMeta(metaTarget.id, { batchNo: values.batchNo, remark: values.remark });
    if (ok) {
      message.success('批次信息已更新');
      setMetaTarget(null);
    } else {
      message.error('批次不存在，请刷新后重试');
    }
  };

  const handleDeleteBatch = async (batch: ProcessBatch) => {
    const hasRetainedPot = pots.some((p) => p.batchId === batch.id && p.retained);
    const ok = await removeBatch(batch.id, hasRetainedPot);
    if (ok) {
      message.success(`已删除批次 ${batch.batchNo} 及其锅次`);
    } else {
      message.error('该批次已有锅次留样，留样来源须可追溯，不能删除');
    }
  };

  const handleDeletePot = async (batch: ProcessBatch, pot: ProcessPot) => {
    try {
      await removePot(batch.id, pot.id, batch.potsVersion);
      message.success(`已删除第 ${pot.seq} 锅并重新汇总`);
      setPotModal(null);
    } catch (error) {
      message.error(describeError(error));
    }
  };

  // ---------- 表格 ----------

  const potColumns = (batch: ProcessBatch): TableColumnsType<ProcessPot> => [
    {
      title: '锅次',
      width: 110,
      render: (_, pot) => (
        <Space size={4} direction="vertical">
          <Text strong>第 {pot.seq} 锅</Text>
          <Tag color={pot.kind === 'rework' ? 'purple' : 'default'}>{POT_KIND_LABEL[pot.kind]}</Tag>
        </Space>
      ),
    },
    { title: '锅容量(kg)', dataIndex: 'capacityKg', width: 90, align: 'right' },
    { title: '投料(kg)', dataIndex: 'feedKg', width: 90, align: 'right' },
    { title: '辅料(kg)', dataIndex: 'auxUsedKg', width: 90, align: 'right' },
    { title: '产出(kg)', dataIndex: 'outputKg', width: 90, align: 'right' },
    {
      title: '得率(%)',
      width: 90,
      align: 'right',
      render: (_, pot) => {
        const v = pot.feedKg > 0 ? round1((pot.outputKg / pot.feedKg) * 100) : 0;
        return <Text type={v < 85 ? 'danger' : undefined}>{v}</Text>;
      },
    },
    {
      title: '火候',
      width: 170,
      render: (_, pot) => <FireLevelTag level={pot.fireLevel} tempRange={methodOf(pot.methodId)?.tempRange} duration={pot.duration} />,
    },
    { title: '锅温(℃)', dataIndex: 'temp', width: 80, align: 'right' },
    {
      title: '程度',
      dataIndex: 'degree',
      width: 80,
      render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag>,
    },
    {
      title: '留样',
      width: 130,
      render: (_, pot) =>
        pot.retained ? (
          <Tag color="blue">已留样{pot.kind === 'rework' ? '' : ' · 冻结'}</Tag>
        ) : (
          <Tag>未留样</Tag>
        ),
    },
    {
      title: '返工来源',
      width: 100,
      render: (_, pot) => {
        if (!pot.reworkOfPotId) return '-';
        const src = pots.find((p) => p.id === pot.reworkOfPotId);
        return <Tag color="purple">{src ? `源自第 ${src.seq} 锅` : '原锅已删'}</Tag>;
      },
    },
    { title: '操作人', dataIndex: 'operator', width: 90 },
    {
      title: '操作',
      width: 170,
      fixed: 'right',
      render: (_, pot) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openPotEdit(batch, pot)}>
            {pot.retained ? '查看/返工' : '编辑'}
          </Button>
          {pot.retained ? (
            <Button size="small" type="link" onClick={() => openRework(batch, pot)}>
              新增返工锅
            </Button>
          ) : (
            <Popconfirm
              title={`删除第 ${pot.seq} 锅？`}
              description="删除后同源总量与得率自动重算"
              onConfirm={() => handleDeletePot(batch, pot)}
            >
              <Button size="small" type="link" danger>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const columns: TableColumnsType<ProcessBatch> = [
    { title: '生产批号', dataIndex: 'batchNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: '药材', dataIndex: 'herbId', width: 90, render: (id: string) => herbName(id) },
    { title: '方法', dataIndex: 'methodId', width: 90, render: (id: string) => methodOf(id)?.name ?? '-' },
    {
      title: '锅次',
      dataIndex: 'potCount',
      width: 110,
      align: 'right',
      render: (count: number, record) => {
        const retained = pots.filter((p) => p.batchId === record.id && p.retained).length;
        return (
          <Tooltip title={`已留样 ${retained} 锅${retained > 0 ? '，留样锅已冻结' : ''}`}>
            <Tag color="geekblue">
              {count} 锅{retained > 0 ? ` · ${retained} 留样` : ''}
            </Tag>
          </Tooltip>
        );
      },
    },
    { title: '总投料(kg)', dataIndex: 'feedKg', width: 100, align: 'right' },
    { title: '总辅料(kg)', dataIndex: 'auxUsedKg', width: 100, align: 'right' },
    { title: '总产出(kg)', dataIndex: 'outputKg', width: 100, align: 'right' },
    { title: '得率(%)', dataIndex: 'yieldRate', width: 90, align: 'right', render: (v: number) => <Text type={v < 85 ? 'danger' : undefined}>{v}</Text> },
    { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
    {
      title: '操作',
      width: 170,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openMetaEdit(record)}>
            批号信息
          </Button>
          <Popconfirm
            title={`确认删除批次 ${record.batchNo}？`}
            description="将同时删除其全部锅次；已留样批次不可删除"
            onConfirm={() => handleDeleteBatch(record)}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const retainedEdit = potModal?.mode === 'edit' ? potModal.pot.retained : false;
  const potModalMethod =
    potModal?.mode === 'edit' ? methodOf(potModal.pot.methodId) : potModal ? methodOf(potModal.batch.methodId) : undefined;

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        炮制工序记录台
      </Title>
      <Paragraph type="secondary">
        药材批次受锅容量限制时按锅分次炮制：每锅独立记录投料、辅料与产出，留样来源精确到锅次；同源锅次的总投料、总辅料与得率（总产出÷总投料）随任一锅变更自动重算。已留样锅次冻结，只能新增返工锅次保留原值。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={openCreate}>
          新建分锅炮制
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
        <EmptyPanel description="没有符合条件的工序记录" actionText="新建分锅炮制" onAction={openCreate} />
      ) : (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={visibleBatches}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 1200 }}
          expandable={{
            expandedRowRender: (batch) => (
              <Table
                rowKey="id"
                size="small"
                columns={potColumns(batch)}
                dataSource={pots.filter((p) => p.batchId === batch.id)}
                pagination={false}
                scroll={{ x: 1300 }}
              />
            ),
            rowExpandable: () => true,
          }}
        />
      )}

      {/* 新建分锅炮制 */}
      <Modal
        open={createOpen}
        title="新建分锅炮制"
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        okText="提交（多锅同事务，失败整体回滚）"
        cancelText="取消"
        width={960}
      >
        <Form
          form={createForm}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('herbId' in changed) {
              const herb = herbs.find((h) => h.id === changed.herbId);
              if (herb) {
                const remaining = herbRemaining(herb, pots);
                const capacity = Number(createForm.getFieldValue('capacityKg')) || 50;
                const total = Math.max(0, Math.min(remaining, capacity));
                createForm.setFieldsValue({ totalFeedKg: total } as unknown as Partial<BatchFormValues>);
              }
            }
            if ('methodId' in changed) {
              const method = methods.find((m) => m.id === changed.methodId);
              if (method) {
                const rows = createForm.getFieldValue('pots') ?? [];
                createForm.setFieldsValue({
                  fireLevel: method.fireLevel,
                  pots: rows.map((p: PotFormItem) => ({
                    ...p,
                    auxUsedKg: Number((((Number(p.feedKg) || 0) * method.auxRatio) / 100).toFixed(2)),
                    temp: Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
                    duration: method.duration,
                  })),
                } as unknown as Partial<BatchFormValues>);
              }
            }
            if ('capacityKg' in changed) {
              const capacity = Number(changed.capacityKg) || 0;
              const rows = createForm.getFieldValue('pots') ?? [];
              createForm.setFieldsValue({
                pots: rows.map((p: PotFormItem) => ({ ...p, capacityKg: capacity })),
              } as unknown as Partial<BatchFormValues>);
            }
            // 手工改某锅投料时，按当前方法比例联动该锅辅料
            if (changed.pots) {
              const changedRows = changed.pots as Array<Partial<PotFormItem> | undefined>;
              const method = methods.find((m) => m.id === createForm.getFieldValue('methodId'));
              if (method && Array.isArray(changedRows)) {
                const changedIndex = changedRows.findIndex((r) => r && 'feedKg' in r);
                if (changedIndex >= 0) {
                  const rows = createForm.getFieldValue('pots') ?? [];
                  const row = rows[changedIndex];
                  const feed = Number(row?.feedKg) || 0;
                  rows[changedIndex] = {
                    ...row,
                    auxUsedKg: Number(((feed * method.auxRatio) / 100).toFixed(2)),
                  };
                  createForm.setFieldsValue({ pots: rows } as unknown as Partial<BatchFormValues>);
                }
              }
            }
          }}
        >
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]} style={{ flex: 1 }}>
              <Input maxLength={24} />
            </Form.Item>
            <Form.Item name="herbId" label="药材批次" rules={[{ required: true, message: '请选择药材' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                optionFilterProp="label"
                options={herbs.map((h) => {
                  const remaining = herbRemaining(h, pots);
                  return {
                    label: `${h.name} · ${h.batchNo}（来量 ${h.feedKg}kg / 余量 ${remaining}kg）`,
                    value: h.id,
                  };
                })}
              />
            </Form.Item>
            <Form.Item name="methodId" label="炮制方法" rules={[{ required: true, message: '请选择炮制方法' }]} style={{ flex: 1 }}>
              <Select options={methods.map((m) => ({ label: `${m.name} · ${m.auxiliary} ${m.auxRatio}kg/100kg`, value: m.id }))} />
            </Form.Item>
          </Space>

          {createMethod ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                <Space wrap size={8}>
                  <span>辅料比例 {createMethod.auxRatio}kg/100kg</span>
                  <FireLevelTag level={createMethod.fireLevel} tempRange={createMethod.tempRange} duration={createMethod.duration} />
                  <Tag>{createMethod.criterionDimension}</Tag>
                  <Tag color={createRemaining < 0 ? 'red' : 'green'}>
                    药材余量：提交后剩余 {round1(createRemaining)} kg
                  </Tag>
                </Space>
              }
              description={`判断标准：${createMethod.criterion}；适用药材：${createMethod.applicable}`}
            />
          ) : null}

          <Card size="small" title="按锅容量分锅" style={{ marginBottom: 12 }}
            extra={
              <Space>
                <span style={{ color: '#6b7a70' }}>总投料(kg)</span>
                <Form.Item name="totalFeedKg" noStyle>
                  <InputNumber min={0} step={0.5} style={{ width: 110 }} />
                </Form.Item>
                <span style={{ color: '#6b7a70' }}>锅容量(kg)</span>
                <Form.Item name="capacityKg" noStyle>
                  <InputNumber min={1} style={{ width: 100 }} />
                </Form.Item>
                <Button type="primary" ghost onClick={autoSplit}>
                  自动分锅
                </Button>
              </Space>
            }
          >
            <Form.List name="pots">
              {(fields, { add, remove }) => (
                <>
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={false}
                    dataSource={fields}
                    columns={[
                      { title: '锅次', width: 70, render: (_, __, index) => `第 ${index + 1} 锅` },
                      {
                        title: '锅容量(kg)',
                        width: 110,
                        render: (_, field) => (
                          <Form.Item name={[field.name, 'capacityKg']} noStyle rules={[{ required: true }]}>
                            <InputNumber min={1} size="small" style={{ width: 100 }} />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '投料(kg)',
                        width: 120,
                        render: (_, field) => (
                          <Form.Item name={[field.name, 'feedKg']} noStyle rules={[{ required: true }]}>
                            <InputNumber min={0} step={0.5} size="small" style={{ width: 110 }} />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '辅料(kg)',
                        width: 120,
                        render: (_, field) => (
                          <Form.Item name={[field.name, 'auxUsedKg']} noStyle rules={[{ required: true }]}>
                            <InputNumber min={0} step={0.1} size="small" style={{ width: 110 }} />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '产出(kg)',
                        width: 120,
                        render: (_, field) => (
                          <Form.Item name={[field.name, 'outputKg']} noStyle rules={[{ required: true }]}>
                            <InputNumber min={0} step={0.5} size="small" style={{ width: 110 }} />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '锅温(℃)',
                        width: 110,
                        render: (_, field) => (
                          <Form.Item name={[field.name, 'temp']} noStyle rules={[{ required: true }]}>
                            <InputNumber min={0} max={800} size="small" style={{ width: 100 }} />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '时长(min)',
                        width: 110,
                        render: (_, field) => (
                          <Form.Item name={[field.name, 'duration']} noStyle rules={[{ required: true }]}>
                            <InputNumber min={0} size="small" style={{ width: 100 }} />
                          </Form.Item>
                        ),
                      },
                      {
                        title: '程度',
                        width: 90,
                        render: (_, __, index) => {
                          const row = createPots[index];
                          const degree = row && createMethod ? degreeOfRow(row as PotFormItem, watchedCreate?.fireLevel, createMethod) : undefined;
                          return degree ? <Tag color={DEGREE_COLOR[degree]}>{degree}</Tag> : '-';
                        },
                      },
                      {
                        title: '',
                        width: 60,
                        render: (_, field) =>
                          fields.length > 1 ? (
                            <Button size="small" type="link" danger onClick={() => remove(field.name)}>
                              删
                            </Button>
                          ) : null,
                      },
                    ]}
                  />
                  <Button
                    size="small"
                    style={{ marginTop: 8 }}
                    onClick={() =>
                      add({
                        capacityKg: Number(createForm.getFieldValue('capacityKg')) || 50,
                        feedKg: 0,
                        auxUsedKg: 0,
                        outputKg: 0,
                        temp: createMethod ? Math.round((createMethod.tempRange[0] + createMethod.tempRange[1]) / 2) : 100,
                        duration: createMethod?.duration ?? 12,
                      })
                    }
                  >
                    增加一锅
                  </Button>
                </>
              )}
            </Form.List>
          </Card>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="fireLevel" label="火力（同批共用）" rules={[{ required: true }]}>
              <Select style={{ width: 120 }} options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="startedAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
              <DatePicker showTime style={{ width: 190 }} />
            </Form.Item>
            <Form.Item name="endedAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}>
              <DatePicker showTime style={{ width: 190 }} />
            </Form.Item>
            <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
              <Input style={{ width: 140 }} maxLength={16} />
            </Form.Item>
          </Space>

          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批号信息 */}
      <Modal open={Boolean(metaTarget)} title={`批次信息 · ${metaTarget?.batchNo ?? ''}`} onCancel={() => setMetaTarget(null)} onOk={submitMeta} okText="保存" cancelText="取消" width={520}>
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="药材、炮制方法与锅次记录为追溯依据，创建后不可更改；如需调整请新增返工锅次。" />
        <Form form={metaForm} layout="vertical">
          <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]}>
            <Input maxLength={24} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={3} maxLength={80} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 锅次编辑 / 返工 */}
      <Modal
        open={Boolean(potModal)}
        title={
          potModal
            ? potModal.mode === 'edit'
              ? `第 ${potModal.pot.seq} 锅 · ${potModal.batch.batchNo}`
              : `新增返工锅（源自第 ${potModal.source.seq} 锅）· ${potModal.batch.batchNo}`
            : ''
        }
        onCancel={() => setPotModal(null)}
        onOk={submitPot}
        okText={potModal?.mode === 'rework' ? '提交返工锅（保留原锅值）' : '保存并重算批次'}
        cancelText="取消"
        width={640}
        okButtonProps={{ disabled: retainedEdit }}
      >
        {potModal ? (
          <Form
            form={potForm}
            layout="vertical"
            disabled={retainedEdit}
            onValuesChange={(changed) => {
              if ('feedKg' in changed && potModalMethod) {
                const feed = Number(changed.feedKg) || 0;
                potForm.setFieldsValue({
                  auxUsedKg: Number(((feed * potModalMethod.auxRatio) / 100).toFixed(2)),
                  outputKg: Number((feed * outputFactor(potModalMethod)).toFixed(1)),
                } as unknown as PotFormValues);
              }
              if (potVerdict && ('feedKg' in changed || 'outputKg' in changed || 'temp' in changed || 'duration' in changed || 'fireLevel' in changed)) {
                potForm.setFieldsValue({ degree: potVerdict.degree } as unknown as PotFormValues);
              }
            }}
          >
            {retainedEdit ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="该锅次已留样，投料、辅料与产出已冻结，不能直接修改"
                description="如需纠正，请保留本锅原值，新增一个返工锅次记录再处理。"
                action={
                  <Button size="small" type="primary" onClick={switchToRework}>
                    新增返工锅
                  </Button>
                }
              />
            ) : null}
            {potModal.mode === 'rework' ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={`返工投料来自原锅产出（${potModal.source.outputKg}kg 中间品），不重复占用药材余量；原第 ${potModal.source.seq} 锅记录原样保留。`}
              />
            ) : null}

            {potModalMethod ? (
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 12 }}
                message={
                  <Space wrap size={8}>
                    <span>辅料比例 {potModalMethod.auxRatio}kg/100kg</span>
                    <FireLevelTag level={potModalMethod.fireLevel} tempRange={potModalMethod.tempRange} duration={potModalMethod.duration} />
                  </Space>
                }
              />
            ) : null}

            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item name="capacityKg" label="锅容量(kg)" rules={[{ required: true, message: '请输入锅容量' }]}>
                <InputNumber min={1} style={{ width: 150 }} addonAfter="kg" />
              </Form.Item>
              <Form.Item name="feedKg" label={potModal.mode === 'rework' ? '返工投料(kg)' : '投料量(kg)'} rules={[{ required: true, message: '请输入投料量' }]}>
                <InputNumber min={0} step={0.5} style={{ width: 150 }} addonAfter="kg" />
              </Form.Item>
              <Form.Item name="auxUsedKg" label="辅料实际(kg)" rules={[{ required: true, message: '请输入辅料用量' }]}>
                <InputNumber min={0} step={0.1} style={{ width: 150 }} addonAfter="kg" />
              </Form.Item>
              <Form.Item name="outputKg" label="炮制后产出(kg)" rules={[{ required: true, message: '请输入产出重量' }]}>
                <InputNumber min={0} step={0.5} style={{ width: 150 }} addonAfter="kg" />
              </Form.Item>
            </Space>

            <Alert
              type={potVerdict?.degree === '适中' ? 'success' : potVerdict?.degree === '太过' ? 'error' : 'warning'}
              showIcon
              style={{ marginBottom: 12 }}
              message={`系统判定：${potVerdict?.degree ?? '待录入火候与得率'}（本锅得率 ${
                watchedPot?.feedKg && watchedPot?.outputKg
                  ? round1((Number(watchedPot.outputKg) / Number(watchedPot.feedKg)) * 100)
                  : 0
              }%，预期 ${potVerdict?.expectedYield ?? '-'}%）`}
            />

            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item name="fireLevel" label="火力" rules={[{ required: true }]}>
                <Select style={{ width: 120 }} options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
              <Form.Item name="temp" label="实际锅温(℃)" rules={[{ required: true, message: '请输入实际锅温' }]}>
                <InputNumber min={0} max={800} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="duration" label="炮制时长(min)" rules={[{ required: true, message: '请输入时长' }]}>
                <InputNumber min={0} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="degree" label="程度判定" rules={[{ required: true }]}>
                <Select style={{ width: 110 }} options={PROCESS_DEGREES.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
            </Space>

            <Space size={12} style={{ display: 'flex' }} align="start">
              <Form.Item name="startedAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
                <DatePicker showTime style={{ width: 190 }} />
              </Form.Item>
              <Form.Item name="endedAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}>
                <DatePicker showTime style={{ width: 190 }} />
              </Form.Item>
              <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
                <Input style={{ width: 140 }} maxLength={16} />
              </Form.Item>
            </Space>

            <Form.Item name="remark" label="备注">
              <Input.TextArea rows={2} maxLength={80} />
            </Form.Item>

            <Text type="secondary">
              <InfoCircleOutlined /> 提交时携带批次分锅版本号，若另一标签页已改动分锅用量（余量变化），本次提交将失败并整体回滚，请刷新后重试。
            </Text>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}

function describeError(error: unknown): string {
  if (
    error instanceof HerbRemainingError ||
    error instanceof PotCapacityError ||
    error instanceof PotRetainedError ||
    error instanceof PotsConflictError ||
    error instanceof ReworkSourceError
  ) {
    return error.message;
  }
  return (error as Error)?.message ?? '操作失败，已回滚';
}
