// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ModelConfigUpdate, type PublicModelConfig } from '@yuezhuang/shared';
import { ModelSettings } from './ModelSettings';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const config = (): PublicModelConfig => ({ revision: 3, mode: 'real', baseUrl: 'https://api.example.test/prefix/v1', modelId: 'gateway-model', apiKeyConfigured: true, protocol: 'responses', persistent: true });
async function mount(options: { disabled?: boolean; readError?: string; saveError?: string; stopError?: string; probeMode?: 'real' | 'mock' } = {}) {
  const client = {
    read: vi.fn(async () => { if (options.readError) throw new Error(options.readError); return config(); }),
    save: vi.fn(async (value: ModelConfigUpdate) => { if (options.saveError) throw new Error(options.saveError); return { ...config(), revision: value.revision + 1, mode: value.mode, modelId: value.modelId, baseUrl: value.baseUrl, apiKeyConfigured: !value.clearApiKey }; }),
    probe: vi.fn(async () => ({ ok: true as const, mode: options.probeMode ?? 'real', modelId: 'gateway-model' }))
  };
  const beforeSave = vi.fn(async () => { if (options.stopError) throw new Error(options.stopError); }); const onSaved = vi.fn();
  await act(async () => root.render(<ModelSettings client={client} gatewayUrl="http://127.0.0.1:3417" beforeSave={beforeSave} onSaved={onSaved} disabled={options.disabled} />));
  return { client, beforeSave, onSaved };
}
async function input(id: string, value: string) {
  await act(async () => { const element = host.querySelector<HTMLInputElement>(`#${id}`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function mode(value: string) { await act(async () => { const element = host.querySelector<HTMLSelectElement>('#model-mode')!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); }
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }

describe('model settings page', () => {
  it('shows current address/model and credential status without revealing the saved key or probing', async () => {
    const { client } = await mount();
    expect(host.querySelector<HTMLInputElement>('#model-base-url')!.value).toBe(config().baseUrl);
    expect(host.querySelector<HTMLInputElement>('#model-api-key')!.type).toBe('password');
    expect(host.querySelector<HTMLInputElement>('#model-api-key')!.value).toBe('');
    expect(host.textContent).toContain('已配置，留空保留'); expect(host.textContent).toContain('https://api.example.test/prefix/v1/responses');
    expect(client.probe).not.toHaveBeenCalled(); expect(button('保存模型配置').disabled).toBe(true);
  });
  it('quiesces tasks before saving, keeps an omitted key and immediately reports success', async () => {
    const { client, beforeSave, onSaved } = await mount();
    await input('model-id', 'gateway-model-next'); await click('保存模型配置');
    expect(client.save).toHaveBeenCalledWith({ revision: 3, mode: 'real', baseUrl: config().baseUrl, modelId: 'gateway-model-next' });
    expect(beforeSave.mock.invocationCallOrder[0]).toBeLessThan(client.save.mock.invocationCallOrder[0]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 4, modelId: 'gateway-model-next' })); expect(host.textContent).toContain('立即生效');
  });
  it('sends an updated key once and clears it, without persisting into browser storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); const { client } = await mount();
    await input('model-api-key', 'ui-test-key'); await click('保存模型配置');
    expect(client.save.mock.calls[0][0].apiKey).toBe('ui-test-key'); expect(host.querySelector<HTMLInputElement>('#model-api-key')!.value).toBe('');
    expect(host.textContent).not.toContain('ui-test-key'); expect(storage).not.toHaveBeenCalled();
  });
  it('requires saving edits before a probe and distinguishes real vs mock tests', async () => {
    const { client } = await mount({ probeMode: 'mock' });
    await input('model-id', 'gateway-model-next'); expect(button('测试已保存的连接').disabled).toBe(true);
    await click('保存模型配置'); await click('测试已保存的连接');
    expect(client.probe).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('没有请求真实模型');
  });
  it('tests fixed-text connectivity only when explicitly clicked', async () => {
    const { client } = await mount(); await click('测试已保存的连接');
    expect(client.probe).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('未读取帖子、未点赞、未关注、未评论');
  });
  it('does not save if the background cannot safely stop the current task', async () => {
    const { client } = await mount({ stopError: 'model_request_in_progress' }); await input('model-api-key', 'ui-test-key'); await click('保存模型配置');
    expect(client.save).not.toHaveBeenCalled(); expect(host.querySelector<HTMLInputElement>('#model-api-key')!.value).toBe(''); expect(host.textContent).toContain('尚未结束');
  });
  it('explains a stale revision and requires rereading rather than silently overwriting', async () => {
    await mount({ saveError: 'model_config_conflict' }); await input('model-id', 'edited-model'); await click('保存模型配置');
    expect(host.textContent).toContain('其他窗口更新'); await click('重新读取模型配置'); expect(host.querySelector<HTMLInputElement>('#model-id')!.value).toBe(config().modelId);
  });
  it('rejects HTTP before sending and requires mock mode to clear a credential', async () => {
    const { client } = await mount(); await input('model-base-url', 'http://api.example.test'); expect(button('保存模型配置').disabled).toBe(true);
    expect(host.textContent).toContain('必须使用 HTTPS'); expect(client.save).not.toHaveBeenCalled();
    await input('model-base-url', config().baseUrl); await act(async () => host.querySelector<HTMLInputElement>('#model-clear-key')!.click()); expect(button('保存模型配置').disabled).toBe(true);
    await mode('mock'); await click('保存模型配置'); expect(client.save.mock.calls[0][0]).toMatchObject({ mode: 'mock', clearApiKey: true });
  });
  it('handles an old gateway and prevents editing without a successful read', async () => {
    await mount({ readError: 'gateway_http_404' }); expect(host.textContent).toContain('重启新版网关'); expect(host.querySelector('fieldset')!.disabled).toBe(true); expect(button('重新读取模型配置').disabled).toBe(false);
  });
  it('blocks configuration edits while a manual operation is busy', async () => {
    await mount({ disabled: true }); expect(host.querySelector('fieldset')!.disabled).toBe(true); expect(button('重新读取模型配置').disabled).toBe(true);
  });
});
