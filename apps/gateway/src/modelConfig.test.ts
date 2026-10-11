import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelConfigStore } from './modelConfig.js';
import { createApp } from './server.js';

const env = { APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only', MODEL_ID: 'gateway-model', GATEWAY_PAIRING_TOKEN: 'local-pair' };
const headers = { host: '127.0.0.1:3417', 'x-yuezhuang-pairing-token': 'local-pair', origin: 'chrome-extension://' + 'a'.repeat(32) };
const update = { revision: 0, mode: 'real' as const, baseUrl: 'https://api.example.test/v1', modelId: 'gateway-model-next' };
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function path() { const dir = await mkdtemp(join(tmpdir(), 'yuezhuang-config-test-')); dirs.push(dir); return join(dir, 'model-config.json'); }
const response = (result: unknown = { ok: true }) => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });

describe('private model configuration storage', () => {
  it('persists with restrictive permissions, retains key/pairing and loads after restart', async () => {
    const file = await path(); const store = await ModelConfigStore.open(env, file);
    const saved = await store.update(update);
    expect(saved).toMatchObject({ revision: 1, modelId: update.modelId, baseUrl: update.baseUrl });
    expect(JSON.stringify(saved)).not.toContain(env.MODEL_API_KEY);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ apiKey: env.MODEL_API_KEY });
    const reopened = await ModelConfigStore.open({ ...env, MODEL_API_KEY: 'different-test', MODEL_ID: 'different-model' }, file);
    expect(reopened.publicConfig()).toEqual(saved); expect(reopened.config.key).toBe(env.MODEL_API_KEY); expect(reopened.config.pairingToken).toBe('local-pair');
  });
  it('does not automatically send a stored key to another service', async () => {
    const store = await ModelConfigStore.open(env, null);
    await expect(store.update({ ...update, baseUrl: 'https://other.example.test/v1' })).rejects.toThrow('new_provider_requires_key');
    expect(store.publicConfig().revision).toBe(0);
    await store.update({ ...update, baseUrl: 'https://other.example.test/v1', apiKey: 'new-test-key' }); expect(store.config.key).toBe('new-test-key');
  });
  it('clears credentials durably in mock mode without falling back to the old key', async () => {
    const file = await path(); const store = await ModelConfigStore.open(env, file);
    await expect(store.update({ ...update, clearApiKey: true })).rejects.toThrow('real_mode_not_configured');
    await store.update({ ...update, mode: 'mock', clearApiKey: true });
    expect((await ModelConfigStore.open(env, file)).publicConfig()).toMatchObject({ mode: 'mock', apiKeyConfigured: false });
    await expect(store.update({ ...update, revision: 1, clearApiKey: true, apiKey: 'new-test-key' })).rejects.toThrow('invalid_key_update');
  });
  it('rejects stale saves and keeps state when persistence fails', async () => {
    const file = await path(); const store = await ModelConfigStore.open(env, file); await store.update(update);
    await expect(store.update(update)).rejects.toThrow('model_config_conflict');
    await rm(file); await mkdir(file);
    await expect(store.update({ ...update, revision: 1, modelId: 'not-saved' })).rejects.toThrow('model_config_save_failed');
    expect(store.publicConfig()).toMatchObject({ revision: 1, modelId: update.modelId });
  });
  it('fails closed on a malformed file without reflecting its contents', async () => {
    const file = await path(); await writeFile(file, 'a malformed private value');
    await expect(ModelConfigStore.open(env, file)).rejects.toThrow(/^model_config_file_invalid$/);
  });
});

describe('model configuration API and immediate application', () => {
  it('protects read/update/probe with pairing, host and origin checks without exposing keys', async () => {
    const app = await createApp(env); apps.push(app);
    for (const [method, url] of [['GET', '/v1/provider/config'], ['PATCH', '/v1/provider/config'], ['POST', '/v1/provider/probe']] as const) {
      for (const badHeaders of [{ host: headers.host }, { ...headers, host: 'rebinding.example.test' }, { ...headers, origin: 'https://website.example.test' }]) {
        expect((await app.inject({ method, url, headers: badHeaders, ...(method === 'PATCH' ? { payload: update } : {}) })).statusCode).toBe(403);
      }
    }
    const read = await app.inject({ method: 'GET', url: '/v1/provider/config', headers });
    expect(read.headers['cache-control']).toBe('no-store'); expect(read.json()).toMatchObject({ apiKeyConfigured: true, baseUrl: env.MODEL_API_ORIGIN });
    expect(read.body).not.toContain(env.MODEL_API_KEY); expect(read.body).not.toContain(env.GATEWAY_PAIRING_TOKEN);
  });
  it('uses saved address, model and key immediately in probe and inference', async () => {
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      sent.push({ url: String(url), init });
      const payload = JSON.parse(String(init?.body));
      return response(payload.text.format.name === 'probe' ? { ok: true } : { type: 'consumer_request', city: '上海', evidence: ['找上海化妆师'], decision: 'eligible_for_review' });
    };
    const app = await createApp(env, fetcher); apps.push(app);
    const saved = await app.inject({ method: 'PATCH', url: '/v1/provider/config', headers, payload: { ...update, baseUrl: 'https://new.example.test/prefix/v1/', apiKey: 'new-test-key' } });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.body).not.toContain('new-test-key');
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ mode: 'real', modelId: update.modelId });
    const probe = await app.inject({ method: 'POST', url: '/v1/provider/probe', headers }); expect(probe.statusCode, probe.body).toBe(200);
    expect(sent[0].url).toBe('https://new.example.test/prefix/v1/responses'); expect(sent[0].init?.headers).toMatchObject({ authorization: 'Bearer new-test-key' });
    expect(sent[0].init?.redirect).toBe('error'); expect(JSON.parse(String(sent[0].init?.body))).toMatchObject({ model: update.modelId, store: false });
    const inference = await app.inject({ method: 'POST', url: '/v1/note/analyze', headers, payload: { id: 'fixture:config-test', title: '找上海化妆师', body: '求推荐上海约妆', source: 'fixture', completeness: 'complete', capturedAt: '2026-10-11T00:00:00Z' } });
    expect(inference.statusCode, inference.body).toBe(200);
    expect(sent[1].url).toBe(sent[0].url); expect(JSON.parse(String(sent[1].init?.body)).model).toBe(update.modelId);
    expect((await app.inject({ method: 'GET', url: '/v1/config-summary', headers })).json()).toMatchObject({ modelId: update.modelId, upstreamConfigured: true });
  });
  it('switches mock to real, and probe only sends fixed text without posts', async () => {
    let requests = 0;
    const app = await createApp({ APP_MODE: 'mock' }, async (_url, init) => { requests++; expect(JSON.parse(String(init?.body)).input).toEqual([{ role: 'user', content: 'Return JSON with ok set to true.' }]); return response(); }); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/v1/provider/probe', headers })).json()).toMatchObject({ ok: true, mode: 'mock' }); expect(requests).toBe(0);
    expect((await app.inject({ method: 'PATCH', url: '/v1/provider/config', headers, payload: { ...update, apiKey: 'new-test-key' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/provider/probe', headers })).json()).toMatchObject({ ok: true, mode: 'real' }); expect(requests).toBe(1);
  });
  it('supports native HTTP reads/saves/probes with no empty JSON body on probe', async () => {
    const app = await createApp({ APP_MODE: 'mock' }, async () => response()); apps.push(app);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const browserHeaders = { origin: headers.origin };
    expect((await fetch(`${base}/v1/provider/config`, { headers: browserHeaders })).status).toBe(200);
    const saved = await fetch(`${base}/v1/provider/config`, { method: 'PATCH', headers: { ...browserHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ ...update, apiKey: 'new-test-key' }) });
    expect(saved.status).toBe(200); expect((await saved.json()).apiKeyConfigured).toBe(true);
    const probe = await fetch(`${base}/v1/provider/probe`, { method: 'POST', headers: browserHeaders });
    expect(probe.status).toBe(200); expect(await probe.json()).toMatchObject({ ok: true, mode: 'real' });
    const preflight = await fetch(`${base}/v1/provider/config`, { method: 'OPTIONS', headers: { ...browserHeaders, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type,x-yuezhuang-pairing-token' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(headers.origin);
  });
  it('rejects invalid configuration and hides credentials in malformed JSON errors', async () => {
    const app = await createApp(env); apps.push(app);
    for (const payload of [{ ...update, baseUrl: 'http://api.example.test' }, { ...update, extra: env.MODEL_API_KEY }, { ...update, apiKey: 'line\nbreak' }]) {
      const result = await app.inject({ method: 'PATCH', url: '/v1/provider/config', headers, payload }); expect(result.statusCode).toBe(400); expect(result.body).not.toContain(env.MODEL_API_KEY);
    }
    const malformedKey = ['private', 'test', 'value'].join('-');
    const malformed = await app.inject({ method: 'PATCH', url: '/v1/provider/config', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ apiKey: malformedKey }) + ',' });
    expect(malformed.statusCode).toBe(400); expect(malformed.body).not.toContain('private-test-value');
    expect((await app.inject({ method: 'GET', url: '/v1/provider/config', headers })).json().revision).toBe(0);
  });
  it('refuses switching configuration during a model request', async () => {
    let release!: () => void; let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const app = await createApp(env, async () => { started(); await wait; return response(); }); apps.push(app);
    const probe = app.inject({ method: 'POST', url: '/v1/provider/probe', headers });
    await begun;
    const blocked = await app.inject({ method: 'PATCH', url: '/v1/provider/config', headers, payload: update });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error).toBe('model_request_in_progress'); release(); await probe;
    expect((await app.inject({ method: 'PATCH', url: '/v1/provider/config', headers, payload: update })).statusCode).toBe(200);
  });
  it('hides network exception details and rejects a false probe', async () => {
    const app = await createApp(env, async () => { throw new Error(`network rejected credential ${env.MODEL_API_KEY}`); }); apps.push(app);
    const result = await app.inject({ method: 'POST', url: '/v1/provider/probe', headers });
    expect(result.statusCode).toBe(502); expect(result.json().error).toBe('upstream_network_error'); expect(result.body).not.toContain(env.MODEL_API_KEY);
    const falseApp = await createApp(env, async () => response({ ok: false })); apps.push(falseApp);
    expect((await falseApp.inject({ method: 'POST', url: '/v1/provider/probe', headers })).json().error).toBe('upstream_probe_failed');
  });
});
