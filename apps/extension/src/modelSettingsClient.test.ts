import { describe, expect, it, vi } from 'vitest';
import { createModelSettingsClient, modelSettingsError } from './modelSettingsClient';

const config = { revision: 0, mode: 'real', baseUrl: 'https://api.example.test/v1', modelId: 'gateway-model', apiKeyConfigured: true, protocol: 'responses', persistent: true };
describe('private model settings transport', () => {
  it('uses only the local gateway and pairing token; credentials only appear in the update body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(String(url).endsWith('/probe') ? { ok: true, mode: 'real', modelId: 'gateway-model' } : config)); };
    const client = createModelSettingsClient('http://127.0.0.1:3417', 'local-pair', fetcher);
    await client.read(); await client.save({ revision: 0, mode: 'real', baseUrl: config.baseUrl, modelId: 'gateway-model', apiKey: 'ui-test-key' }); await client.probe();
    expect(calls.map(call => call.url)).toEqual(['http://127.0.0.1:3417/v1/provider/config', 'http://127.0.0.1:3417/v1/provider/config', 'http://127.0.0.1:3417/v1/provider/probe']);
    expect(calls[1].init?.method).toBe('PATCH'); expect(JSON.parse(String(calls[1].init?.body)).apiKey).toBe('ui-test-key');
    for (const call of calls) { expect(call.init?.headers).toEqual({ ...(call.init?.body ? { 'content-type': 'application/json' } : {}), 'x-yuezhuang-pairing-token': 'local-pair' }); expect(call.init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' }); }
    expect(calls[2].init?.body).toBeUndefined();
  });
  it('refuses a response that includes a key instead of caching or displaying it', async () => {
    const client = createModelSettingsClient('http://127.0.0.1:3417', '', async () => new Response(JSON.stringify({ ...config, apiKey: 'private-test' })));
    await expect(client.read()).rejects.toThrow('invalid_config_response');
  });
  it('does not return arbitrary server error text that could contain credentials', async () => {
    const client = createModelSettingsClient('http://127.0.0.1:3417', '', async () => new Response(JSON.stringify({ error: 'credential private-test rejected' }), { status: 500 }));
    await expect(client.read()).rejects.toThrow(/^gateway_http_500$/);
    expect(modelSettingsError(new Error('credential private-test rejected'))).not.toContain('private-test');
    expect(modelSettingsError(new Error('not_paired'))).toContain('配对令牌');
    expect(modelSettingsError(new Error('__proto__'))).toContain('敏感错误内容已隐藏');
  });
  it('explains old gateways and keeps a model key out of the pairing header', async () => {
    let headers: HeadersInit | undefined;
    const fakeKey = ['sk', 'not-a-real-key'].join('-');
    const client = createModelSettingsClient('http://127.0.0.1:3417', fakeKey, async (_url, init) => { headers = init?.headers; return new Response('{}', { status: 404 }); });
    await expect(client.read()).rejects.toThrow('gateway_http_404');
    expect(headers).not.toHaveProperty('x-yuezhuang-pairing-token');
    expect(modelSettingsError(new Error('gateway_http_404'))).toContain('重启新版网关');
  });
});
