import { Empty, Tag, Timeline, Typography } from 'antd';
import type { HerbMaterial } from '../../types/herb-material';
import type { ProcessingMethod } from '../../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../../types/process-batch';
import { formatDate } from '../../utils/degree';

const { Text } = Typography;

export interface ProcessTimelineProps {
  batches: ProcessBatch[];
  herbs: HerbMaterial[];
  methods: ProcessingMethod[];
  /** 各批已留样锅次数（batchId -> 数量），用于状态展示 */
  retainedCountByBatch?: Record<string, number>;
  limit?: number;
}

const DEGREE_COLOR: Record<ProcessDegree, string> = {
  不及: 'orange',
  适中: 'green',
  太过: 'red',
};

/** 炮制工序时间线（首页复用），展示最近批次的锅次数、方法与得率 */
export default function ProcessTimeline({ batches, herbs, methods, retainedCountByBatch = {}, limit = 6 }: ProcessTimelineProps) {
  const rows = batches.slice(0, limit);
  if (rows.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无炮制工序记录" />;
  }

  return (
    <Timeline
      items={rows.map((batch) => {
        const herb = herbs.find((h) => h.id === batch.herbId);
        const method = methods.find((m) => m.id === batch.methodId);
        const retained = retainedCountByBatch[batch.id] ?? 0;
        return {
          color: batch.degree === '适中' ? 'green' : batch.degree === '太过' ? 'red' : 'orange',
          children: (
            <div>
              <Text strong>{batch.batchNo}</Text>
              <Tag style={{ marginLeft: 8 }} color={DEGREE_COLOR[batch.degree]}>
                {batch.degree}
              </Tag>
              <Tag color="geekblue">{batch.potCount} 锅</Tag>
              {retained > 0 ? <Tag color="blue">{retained} 锅已留样</Tag> : <Tag>未留样</Tag>}
              <div style={{ fontSize: 12, color: '#6b7a70' }}>
                {herb?.name ?? '未知药材'} · {method?.name ?? '未知方法'} · 总投料 {batch.feedKg}kg ·{' '}
                {formatDate(batch.startedAt)} · 得率 {batch.yieldRate}%
              </div>
            </div>
          ),
        };
      })}
    />
  );
}
