/**
 * 跨标签页数据变更通知：一个标签页提交事务后广播，
 * 其他标签页收到后从 IndexedDB 重新装载，避免按旧余量分锅。
 * 不支持 BroadcastChannel 的环境退化为仅在窗口重新聚焦时刷新。
 */

export type StoreSyncMessage = 'pots-changed' | 'samples-changed' | 'all-changed';

const CHANNEL_NAME = 'gbherbprocess-sync';

let channel: BroadcastChannel | undefined;

export function broadcastChange(message: StoreSyncMessage): void {
  try {
    channel ??= new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(message satisfies StoreSyncMessage);
  } catch {
    // 浏览器不支持时静默降级
  }
}

export function onStoreChange(handler: (message: StoreSyncMessage) => void): () => void {
  let disposed = false;
  let ch: BroadcastChannel | undefined;
  try {
    ch = new BroadcastChannel(CHANNEL_NAME);
    ch.onmessage = (event: MessageEvent<StoreSyncMessage>) => {
      if (!disposed) handler(event.data);
    };
  } catch {
    // 忽略：降级为聚焦刷新
  }

  const onFocus = () => {
    if (!disposed) handler('all-changed');
  };
  window.addEventListener('focus', onFocus);

  return () => {
    disposed = true;
    ch?.close();
    window.removeEventListener('focus', onFocus);
  };
}
