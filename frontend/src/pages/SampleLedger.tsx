import { useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import StatBadge from '../components/common/StatBadge';
import CabinetGrid from '../components/common/CabinetGrid';
import EmptyPanel from '../components/common/EmptyPanel';
import { useSampleStore } from '../stores/sampleStore';
import { useBatchStore } from '../stores/batchStore';
import { usePotStore } from '../stores/potStore';
import { useHerbStore } from '../stores/herbStore';
import { CABINETS, type ObserveLog, type RetainSample, type SampleExpiry } from '../types/retain-sample';
import { POT_KIND_LABEL } from '../types/process-batch';
import { buildExpiryList, formatDate, todayStr } from '../utils/degree';

const { Title, Paragraph, Text } = Typography;

interface SampleFormValues {
  sampleNo: string;
  batchId: string;
  potId: string;
  amountG: number;
  retainMonths: number;
  cabinet: string;
  retainedAt: Dayjs;
}

interface ObserveFormValues {
  date: Dayjs;
  color: string;
  odor: string;
  mold: string;
  observer: string;
  note?: string;
}

const STATE_COLOR: Record<SampleExpiry['state'], string> = { 已到期: 'red', 临期: 'orange', 观察中: 'green' };

/** 留样与观察台账：留样来源精确到锅次，按柜位网格查看并追加观察记录 */
export default function SampleLedger() {
  const { message } = AntApp.useApp();
  const samples = useSampleStore((s) => s.samples);
  const createSample = useSampleStore((s) => s.createSample);
  const removeSample = useSampleStore((s) => s.removeSample);
  const appendObserveLog = useSampleStore((s) => s.appendObserveLog);
  const batches = useBatchStore((s) => s.batches);
  const pots = usePotStore((s) => s.pots);
  const herbs = useHerbStore((s) => s.herbs);

  const [selectedCabinet, setSelectedCabinet] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<SampleFormValues>();
  const [observeTarget, setObserveTarget] = useState<RetainSample | null>(null);
  const [observeForm] = Form.useForm<ObserveFormValues>();

  const expiryList = useMemo(() => buildExpiryList(samples, 30), [samples]);
  const dueList = useMemo(() => expiryList.filter((item) => item.daysLeft <= 30), [expiryList]);
  const expired = useMemo(() => expiryList.filter((item) => item.daysLeft < 0), [expiryList]);

  const visible = useMemo(
    () => (selectedCabinet ? expiryList.filter((item) => item.sample.cabinet === selectedCabinet) : expiryList),
    [expiryList, selectedCabinet],
  );

  const potOf = (potId: string) => pots.find((p) => p.id === potId);
  const batchOf = (batchId: string) => batches.find((b) => b.id === batchId);

  const sampleSourceLabel = (sample: RetainSample) => {
    const batch = batchOf(sample.batchId);
    const herb = herbs.find((h) => h.id === batch?.herbId);
    const pot = potOf(sample.potId);
    const batchText = batch ? `${batch.batchNo} · ${herb?.name ?? '未知药材'}` : '未知批次';
    if (!pot) {
      // 兼容历史数据：锅次记录缺失时仍标出 potId
      return `${batchText} · 来源锅 ${sample.potId ?? '缺失'}`;
    }
    return `${batchText} · 第 ${pot.seq} 锅（${POT_KIND_LABEL[pot.kind]}，投料 ${pot.feedKg}kg / 产出 ${pot.outputKg}kg）`;
  };

  const formBatchId = Form.useWatch('batchId', form);
  const formPots = useMemo(
    () => pots.filter((p) => p.batchId === formBatchId).sort((a, b) => a.seq - b.seq),
    [pots, formBatchId],
  );

  const openCreate = () => {
    const nextIndex = samples.length + 1;
    const batch = batches[0];
    const firstPots = batch ? pots.filter((p) => p.batchId === batch.id).sort((a, b) => a.seq - b.seq) : [];
    form.resetFields();
    form.setFieldsValue({
      sampleNo: `LY-${batch?.batchNo ?? 'NEW'}-${String(nextIndex).padStart(2, '0')}`,
      batchId: batch?.id,
      potId: firstPots[0]?.id,
      amountG: 300,
      retainMonths: 12,
      cabinet: CABINETS.find((c) => !expiryList.some((item) => item.sample.cabinet === c)) ?? CABINETS[0],
      retainedAt: dayjs(),
    } as unknown as SampleFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (!values.potId) {
      message.error('请选择留样来源锅次');
      return;
    }
    const occupied = expiryList.some((item) => item.sample.cabinet === values.cabinet);
    if (occupied) {
      message.warning(`柜位 ${values.cabinet} 已有留样，仍将并存放置`);
    }
    await createSample({
      sampleNo: values.sampleNo,
      batchId: values.batchId,
      potId: values.potId,
      amountG: values.amountG,
      retainMonths: values.retainMonths,
      cabinet: values.cabinet,
      retainedAt: values.retainedAt.toISOString(),
    });
    const pot = potOf(values.potId);
    message.success(`已登记留样 ${values.sampleNo}，来源：第 ${pot?.seq ?? '?'} 锅；该锅投料与产出已冻结`);
    setOpen(false);
  };

  const openObserve = (record: RetainSample) => {
    setObserveTarget(record);
    observeForm.resetFields();
    observeForm.setFieldsValue({ date: dayjs(), color: '色泽符合标准', odor: '气味正常', mold: '无霉变', observer: '赵敏' } as unknown as ObserveFormValues);
  };

  const submitObserve = async () => {
    if (!observeTarget) return;
    const values = await observeForm.validateFields();
    await appendObserveLog(observeTarget.id, {
      date: values.date.format('YYYY-MM-DD'),
      color: values.color,
      odor: values.odor,
      mold: values.mold,
      observer: values.observer,
      note: values.note,
    });
    const refreshed = useSampleStore.getState().samples.find((s) => s.id === observeTarget.id);
    if (refreshed) {
      setObserveTarget(refreshed);
    }
    message.success('观察记录已按日期追加');
  };

  const columns: TableColumnsType<SampleExpiry> = [
    { title: '留样编号', width: 170, render: (_, row) => <Text strong>{row.sample.sampleNo}</Text> },
    { title: '来源锅次', width: 340, render: (_, row) => sampleSourceLabel(row.sample) },
    { title: '留样量(g)', width: 100, align: 'right', render: (_, row) => row.sample.amountG },
    { title: '留样期(月)', width: 100, align: 'right', render: (_, row) => row.sample.retainMonths },
    { title: '柜位', width: 80, render: (_, row) => <Tag color="green">{row.sample.cabinet}</Tag> },
    { title: '留样日期', width: 110, render: (_, row) => formatDate(row.sample.retainedAt) },
    { title: '到期日', width: 110, render: (_, row) => row.expireAt },
    {
      title: '剩余天数',
      width: 110,
      align: 'right',
      render: (_, row) => (
        <Text type={row.daysLeft < 0 ? 'danger' : row.daysLeft <= 30 ? 'warning' : undefined}>
          {row.daysLeft < 0 ? `过期 ${Math.abs(row.daysLeft)} 天` : `${row.daysLeft} 天`}
        </Text>
      ),
    },
    { title: '状态', width: 90, render: (_, row) => <Tag color={STATE_COLOR[row.state]}>{row.state}</Tag> },
    { title: '观察记录', width: 100, align: 'right', render: (_, row) => `${row.sample.observeLogs.length} 条` },
    {
      title: '操作',
      width: 160,
      fixed: 'right',
      render: (_, row) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openObserve(row.sample)}>
            追加观察
          </Button>
          <Popconfirm
            title={`确认删除留样 ${row.sample.sampleNo}？`}
            description="若该锅无其他留样，锅次将解除冻结"
            onConfirm={() => removeSample(row.sample.id).then(() => message.success('已删除，锅次留样状态已同步'))}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const observeColumns: TableColumnsType<ObserveLog> = [
    { title: '观察日期', dataIndex: 'date', width: 110 },
    { title: '色泽', dataIndex: 'color', width: 140 },
    { title: '气味', dataIndex: 'odor', width: 120 },
    { title: '霉变', dataIndex: 'mold', width: 120 },
    { title: '观察人', dataIndex: 'observer', width: 90 },
    { title: '备注', dataIndex: 'note', render: (v?: string) => v ?? '-' },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        留样与观察台账
      </Title>
      <Paragraph type="secondary">
        留样来源精确到炮制锅次，登记留样后该锅投料、辅料与产出即冻结，只能新增返工锅次；按柜位网格查看占用与到期状态，观察记录按日期追加；到期前 30 天进入提醒清单。
      </Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <StatBadge label="留样总数" value={samples.length} unit="份" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="观察中" value={expiryList.length - dueList.length} unit="份" status="success" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="30 天内到期" value={dueList.length - expired.length} unit="份" status="warning" />
        </Col>
        <Col xs={12} md={6}>
          <StatBadge label="已到期" value={expired.length} unit="份" status={expired.length ? 'error' : 'success'} />
        </Col>
      </Row>

      <Card
        size="small"
        title="留样柜位网格"
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            {selectedCabinet ? <Tag color="green">已选柜位 {selectedCabinet}</Tag> : <Text type="secondary">点击柜位可筛选下方台账</Text>}
            {selectedCabinet ? <Button size="small" onClick={() => setSelectedCabinet(undefined)}>清除柜位筛选</Button> : null}
            <Button size="small" type="primary" onClick={openCreate}>
              登记留样
            </Button>
          </Space>
        }
      >
        <CabinetGrid expiryList={expiryList} selected={selectedCabinet} onSelect={(cabinet) => setSelectedCabinet(cabinet)} />
      </Card>

      {visible.length === 0 ? (
        <EmptyPanel description={selectedCabinet ? `柜位 ${selectedCabinet} 暂无留样` : '暂无留样记录'} actionText="登记留样" onAction={openCreate} />
      ) : (
        <Table rowKey={(row) => row.sample.id} size="small" columns={columns} dataSource={visible} pagination={{ pageSize: 8 }} scroll={{ x: 1500 }} />
      )}

      <Modal open={open} title="登记留样" onCancel={() => setOpen(false)} onOk={submit} okText="保存并冻结来源锅" cancelText="取消" width={600}>
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            // 切换批次时，来源锅次级联到该批第一锅，并同步留样编号
            if ('batchId' in changed) {
              const firstPot = pots
                .filter((p) => p.batchId === changed.batchId)
                .sort((a, b) => a.seq - b.seq)[0];
              const batch = batchOf(changed.batchId as string);
              form.setFieldsValue({
                potId: firstPot?.id,
                sampleNo: `LY-${batch?.batchNo ?? 'NEW'}-${String(samples.length + 1).padStart(2, '0')}`,
              } as unknown as SampleFormValues);
            }
          }}
        >
          <Form.Item name="sampleNo" label="留样编号" rules={[{ required: true, message: '请输入留样编号' }]}>
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item name="batchId" label="关联炮制批次" rules={[{ required: true, message: '请选择关联批次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={batches.map((b) => {
                const herb = herbs.find((h) => h.id === b.herbId);
                return { label: `${b.batchNo} · ${herb?.name ?? '未知药材'} · 得率 ${b.yieldRate}%`, value: b.id };
              })}
            />
          </Form.Item>
          <Form.Item name="potId" label="来源锅次（留样后该锅冻结）" rules={[{ required: true, message: '请选择来源锅次' }]}>
            <Select
              options={formPots.map((p) => ({
                label: `第 ${p.seq} 锅 · ${POT_KIND_LABEL[p.kind]} · 投料 ${p.feedKg}kg / 产出 ${p.outputKg}kg${p.retained ? '（已留样）' : ''}`,
                value: p.id,
              }))}
              placeholder={formBatchId ? undefined : '请先选择批次'}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="amountG" label="留样量(g)" rules={[{ required: true, message: '请输入留样量' }]}>
              <InputNumber min={0} style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="retainMonths" label="留样期(月)" rules={[{ required: true, message: '请选择留样期' }]}>
              <Select style={{ width: 150 }} options={[3, 6, 12, 18, 24, 36].map((m) => ({ label: `${m} 个月`, value: m }))} />
            </Form.Item>
          </Space>
          <Form.Item name="cabinet" label="柜位" rules={[{ required: true, message: '请选择柜位' }]}>
            <Select showSearch options={CABINETS.map((c) => ({ label: c, value: c }))} />
          </Form.Item>
          <Form.Item name="retainedAt" label="留样日期" rules={[{ required: true, message: '请选择留样日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(observeTarget)}
        title={`留样观察记录 · ${observeTarget?.sampleNo ?? ''}`}
        onCancel={() => setObserveTarget(null)}
        footer={null}
        width={760}
      >
        {observeTarget ? (
          <Paragraph type="secondary" style={{ marginBottom: 12 }}>
            来源：{sampleSourceLabel(observeTarget)}
          </Paragraph>
        ) : null}
        <Table
          rowKey="id"
          size="small"
          style={{ marginBottom: 12 }}
          columns={observeColumns}
          dataSource={observeTarget?.observeLogs ?? []}
          pagination={false}
          locale={{ emptyText: '暂无观察记录，请在下方追加' }}
        />
        <Form form={observeForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="date" label="观察日期" rules={[{ required: true, message: '请选择观察日期' }]}>
              <DatePicker style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="observer" label="观察人" rules={[{ required: true, message: '请输入观察人' }]}>
              <Input style={{ width: 140 }} maxLength={16} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="color" label="色泽" rules={[{ required: true, message: '请填写色泽观察' }]}>
              <Input style={{ width: 200 }} maxLength={30} />
            </Form.Item>
            <Form.Item name="odor" label="气味" rules={[{ required: true, message: '请填写气味观察' }]}>
              <Input style={{ width: 200 }} maxLength={30} />
            </Form.Item>
            <Form.Item name="mold" label="霉变" rules={[{ required: true, message: '请填写霉变观察' }]}>
              <Input style={{ width: 200 }} maxLength={30} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={80} />
          </Form.Item>
          <Space>
            <Button type="primary" onClick={submitObserve}>
              追加本次观察（{todayStr()}）
            </Button>
            <Button onClick={() => setObserveTarget(null)}>关闭</Button>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
