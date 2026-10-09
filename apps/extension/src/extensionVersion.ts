import manifest from '../public/manifest.json';

export const EXTENSION_VERSION = manifest.version;
const reloadNotice = '插件页面与后台版本未同步。请关闭侧边栏，在 Chrome 扩展页重新加载插件后再打开；现有记录保留。';

export async function ensureBackgroundVersion(sendMessage: (message: { type: string }) => Promise<unknown> = message => chrome.runtime.sendMessage(message)): Promise<void> {
  let response: unknown;
  try { response = await sendMessage({ type: 'EXTENSION_VERSION' }); }
  catch { throw new Error(reloadNotice); }
  if (!response || typeof response !== 'object' || !('version' in response) || response.version !== EXTENSION_VERSION) throw new Error(reloadNotice);
}
