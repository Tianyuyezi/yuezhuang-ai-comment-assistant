import { EXTENSION_VERSION } from './extensionVersion';
import { isXhsRestrictionUrl } from './xhs';

type Connection = { ok: boolean; version: string; instance: string; sourceUrl: string; reason?: string };
const connecting = new Map<number, Promise<Connection>>();
const restriction = /account_restricted|login_required|security_challenge|platform_rate_limited/;
const connectionError = '页面连接未恢复。请确认扩展已重载且获准访问小红书；必要时手动刷新当前小红书页后重试。不会自动刷新、重开页面或重发互动。';
function supportedPage(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' && url.hostname === 'www.xiaohongshu.com') ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
}
async function pageUrl(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !supportedPage(tab.url)) throw new Error('请先打开小红书首页或搜索页；不能连接其他网站或 Chrome 内部页面。');
  if (isXhsRestrictionUrl(tab.url)) throw new Error('account_restricted');
  return tab.url;
}
async function probe(tabId: number): Promise<Connection | null> {
  try { return await chrome.tabs.sendMessage(tabId, { type: 'ASSISTANT_CONTENT_STATUS' }, { frameId: 0 }) as Connection | null; }
  catch { return null; } // Only a read-only handshake may be retried, never an action message.
}
function ready(result: Connection | null): result is Connection {
  return Boolean(result?.ok && result.version === EXTENSION_VERSION && typeof result.instance === 'string' && result.instance && typeof result.sourceUrl === 'string');
}
function guard(result: Connection | null) {
  if (result?.reason && restriction.test(result.reason)) throw new Error(result.reason);
}
async function connect(tabId: number): Promise<Connection> {
  const url = await pageUrl(tabId);
  let status = await probe(tabId); guard(status);
  if (!ready(status)) {
    if (await pageUrl(tabId) !== url) throw new Error('连接检查期间页面已变化，请在当前页面重新启动。');
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' });
    } catch { throw new Error(connectionError); }
    status = await probe(tabId); guard(status);
  }
  if (!ready(status)) throw new Error(connectionError);
  if (await pageUrl(tabId) !== url || status.sourceUrl !== url) throw new Error('连接检查期间页面已变化，请在当前页面重新启动。');
  return status;
}
export async function ensurePageConnection(tabId: number): Promise<Connection> {
  const existing = connecting.get(tabId); if (existing) return existing;
  const pending = connect(tabId); connecting.set(tabId, pending);
  try { return await pending; }
  finally { if (connecting.get(tabId) === pending) connecting.delete(tabId); }
}
export async function connectedPageMessage<T = any>(tabId: number, message: object): Promise<T> {
  const status = await ensurePageConnection(tabId);
  let result: any;
  try {
    result = await chrome.tabs.sendMessage(tabId, { ...message, connectionVersion: EXTENSION_VERSION, connectionInstance: status.instance }, { frameId: 0 });
  } catch {
    // A lost response can mean the action happened. Preserve callers' existing unknown-result locks.
    throw new Error('页面消息响应中断，未重发操作。请重新连接；若涉及关注、点赞或评论，请先核对原帖状态。');
  }
  if (!result) throw new Error('页面脚本未响应，未重发操作。请先重新连接并核对原帖状态。');
  return result as T;
}
