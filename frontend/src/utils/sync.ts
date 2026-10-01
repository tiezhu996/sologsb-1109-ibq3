/**
 * 本地数据变更广播。
 *
 * 分锅用量在两个标签页同时打开时，依靠 IndexedDB 事务串行化 + 乐观锁兜底；
 * 本通道只负责把「某个标签页已提交成功」的事实通知其他标签页重新水合，
 * 让它们看到最新的余量与 potsVersion，从而避免在过期数据上继续编辑。
 */
export type StoreChangeKind = 'herbs' | 'methods' | 'batches' | 'pots' | 'samples';

export interface StoreChangeMessage {
  kind: StoreChangeKind;
  /** 发送方标签页标识，避免自己收到自己的广播后重复水合 */
  source: string;
}

const CHANNEL_NAME = 'gbherbprocess-store-changes';

const tabId = Math.random().toString(36).slice(2, 10);

let channel: BroadcastChannel | undefined;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME);
}

export function currentTabId(): string {
  return tabId;
}

/** 广播一次数据变更（本标签页内部状态已自行更新，无需再水合） */
export function broadcastChange(kind: StoreChangeKind): void {
  channel?.postMessage({ kind, source: tabId } satisfies StoreChangeMessage);
}

/** 订阅其他标签页的数据变更 */
export function onStoreChange(handler: (kind: StoreChangeKind) => void): () => void {
  if (!channel) {
    return () => undefined;
  }
  const listener = (event: MessageEvent<StoreChangeMessage>) => {
    if (event.data?.source !== tabId) {
      handler(event.data.kind);
    }
  };
  channel.addEventListener('message', listener);
  return () => channel?.removeEventListener('message', listener);
}
