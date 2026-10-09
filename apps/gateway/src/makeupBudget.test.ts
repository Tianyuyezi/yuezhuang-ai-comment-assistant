import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { campaignFromBusinessTemplate, createBusinessTemplate, type MakeupBudgetFilter } from '@yuezhuang/shared';
import { createApp } from './server.js';
import { configuredMakeupQuote, guardMakeupQuote } from './makeupPricing.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const note = { id: 'fixture:budget', title: '上海求日常妆化妆师', body: '需要上门，预算200元', source: 'fixture', completeness: 'complete', capturedAt: '2026-10-06' };
const assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: [note.title], reason: '真实需求且非金额条件匹配', clientBudget: { min: 200, max: 200, evidence: '预算200元' }, topicFit: 'relevant', serviceDate: null };
function campaign(filter?: MakeupBudgetFilter) {
  const template = createBusinessTemplate('makeup', 'artist');
  template.judgmentInstructions = '旧配置：预算低于359不接';
  template.config.makeupProfile = { cities: ['上海'], serviceAreas: ['上海'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 359, priceTo: null, priceNotes: '路费另计', availability: '', ...(filter ? { budgetFilter: filter } : {}) };
  return campaignFromBusinessTemplate(template, 'artist-snapshot');
}
async function appFor(result: object, payloads: any[] = []) {
  const fetcher: typeof fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });
  };
  const app = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only', DEMAND_DB_PATH: ':memory:' }, fetcher);
  apps.push(app); return app;
}
const post = (app: FastifyInstance, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:3417' }, payload });

describe('makeup budget policy through gateway and quoting', () => {
  it.each([
    [{ mode: 'ignore', min: 300, max: 500 }, 'eligible_for_review'],
    [{ mode: 'range', min: 100, max: 300 }, 'eligible_for_review'],
    [{ mode: 'range', min: 300, max: 500 }, 'hard_skip']
  ] as const)('applies %j after model non-monetary reasoning', async (filter, expected) => {
    const payloads: any[] = []; const app = await appFor(assessment, payloads);
    const response = await post(app, '/v1/candidate/analyze', { campaign: campaign(filter), note });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ decision: expected, promptVersion: 'candidate-v10' });
    const input = JSON.parse(payloads[0].input[1].content);
    expect(input.business).toMatchObject({ makeupBudgetFilter: filter, configuredQuote: '359元起', makeupProfile: { priceFrom: 359 } });
    expect(payloads[0].text.format.schema.required).toContain('clientBudget');
    expect(payloads[0].input[0].content).toContain('takes precedence over stale budget');
  });
  it('uses the same range for read-only demand records and tolerates absent budgets', async () => {
    const app = await appFor({ decision: 'match', evidence: [note.title], reason: '明确约妆需求', tags: ['上海'], clientBudget: assessment.clientBudget });
    const range = campaign({ mode: 'range', min: 300, max: 500 });
    const excluded = await post(app, '/v1/demand/analyze', { campaign: range, note, inputScope: 'card' });
    expect(excluded.json()).toMatchObject({ decision: 'no_match', promptVersion: 'find-demand-card-v6' });
    const allowed = await post(app, '/v1/demand/analyze', { campaign: campaign(), note, inputScope: 'card' });
    expect(allowed.json().decision).toBe('match');
    const unknownApp = await appFor({ ...assessment, clientBudget: null });
    expect((await post(unknownApp, '/v1/candidate/analyze', { campaign: range, note })).json().decision).toBe('eligible_for_review');
  });
  it('adds only the configured quote when the model omits it, despite a lower budget', async () => {
    const payloads: any[] = []; const app = await appFor({ body: '可以提供上门日常妆，有兴趣可以了解。', warnings: [] }, payloads);
    const response = await post(app, '/v1/draft/create', { campaign: campaign(), note, assessment });
    expect(response.json()).toMatchObject({ body: '359元起，可以提供上门日常妆，有兴趣可以了解。', promptVersion: 'draft-v9' });
    expect(JSON.parse(payloads[0].input[1].content).business.configuredQuote).toBe('359元起');
    expect(payloads[0].input[0].content).toContain('NOT a reason for an empty draft or a discount');
    const outOfRange = await post(app, '/v1/draft/create', { campaign: campaign({ mode: 'range', min: 300, max: 500 }), note, assessment });
    expect(outOfRange.statusCode).toBe(409);
    expect(payloads).toHaveLength(1);
  });
  it.each(['200元就能上门化妆。', '500元起可以上门化妆。', '上门化妆¥200。', '200–300元可以上门化妆。', '359元起，两百元就能上门。', '二百至三百元可以上门。'])('does not adopt an invented or discounted quote: %s', async body => {
    const app = await appFor({ body, warnings: [] });
    expect((await post(app, '/v1/draft/create', { campaign: campaign(), note, assessment })).json()).toMatchObject({ body: '', warnings: ['草稿金额与配置收费不一致，未自动采用。'] });
  });
  it('never promotes a model-detected service conflict just because budgets are ignored', async () => {
    const app = await appFor({ ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '用户只接受到店服务' });
    expect((await post(app, '/v1/candidate/analyze', { campaign: campaign(), note })).json().decision).toBe('hard_skip');
    expect((await post(app, '/v1/draft/create', { campaign: campaign(), note: { ...note, resolutionEvidence: '已找到' }, assessment })).statusCode).toBe(409);
  });
  it('supports a configured service range or quote-on-request without inventing fees', () => {
    const value = campaign(); value.makeupProfile!.priceTo = 499;
    expect(configuredMakeupQuote(value)).toBe('359–499元');
    expect(guardMakeupQuote(value, { body: '上门日常妆359–499元。', warnings: [] }).body).toBe('上门日常妆359–499元。');
    value.makeupProfile!.priceFrom = null; value.makeupProfile!.priceTo = null;
    expect(configuredMakeupQuote(value)).toBeNull();
    expect(guardMakeupQuote(value, { body: '', warnings: ['无法确认档期'] })).toEqual({ body: '', warnings: ['无法确认档期'] });
  });
});
