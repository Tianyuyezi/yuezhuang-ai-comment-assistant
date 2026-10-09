import { afterEach, describe, expect, it } from 'vitest';
import { campaignFromBusinessTemplate, createBusinessTemplate, createMockCommand } from '@yuezhuang/shared';
import { createApp, readConfig } from './server.js';
import { CANDIDATE_PROMPT_VERSION, CANDIDATE_SYSTEM_PROMPT } from './candidatePrompt.js';
import { DRAFT_PROMPT_VERSION, DRAFT_SYSTEM_PROMPT } from './draftPrompt.js';
import { DEMAND_PROMPT_VERSION, DEMAND_SYSTEM_PROMPT, guardCardDecision } from './demandPrompt.js';
import { TITLE_PROMPT_VERSION, TITLE_SYSTEM_PROMPT } from './titlePrompt.js';

describe('mock command parser', () => {
  it('refuses batch comment requests', () => {
    expect(createMockCommand('帮我连续评论下一百篇').action).toBe('unsupported');
  });
});

describe('gateway security and mock protocol', () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
  it('rejects an HTTP upstream in real mode', () => {
    expect(() => readConfig({ APP_MODE: 'real', MODEL_API_ORIGIN: 'http://example.test', MODEL_API_KEY: 'not-used' })).toThrow('real_upstream_requires_https');
  });
  it('versions a conservative classification prompt', () => {
    expect(CANDIDATE_PROMPT_VERSION).toBe('candidate-v10');
    expect(CANDIDATE_SYSTEM_PROMPT).toContain('Search keywords are hints');
    expect(CANDIDATE_SYSTEM_PROMPT).toContain('exact contiguous quotes');
    expect(CANDIDATE_SYSTEM_PROMPT).toContain('Do not draft, fill, or publish');
    expect(CANDIDATE_SYSTEM_PROMPT).toContain('negative filtering');
    expect(CANDIDATE_SYSTEM_PROMPT).toContain('private bathroom');
    expect(TITLE_PROMPT_VERSION).toBe('title-screen-v3');
    expect(TITLE_SYSTEM_PROMPT).toContain('high-recall');
  });
  it('keeps draft generation grounded and separate from publishing', () => {
    expect(DRAFT_PROMPT_VERSION).toBe('draft-v9');
    expect(DRAFT_SYSTEM_PROMPT).toContain('never more than 60 characters');
    expect(DRAFT_SYSTEM_PROMPT).toContain('Use only confirmed offering facts');
    expect(DRAFT_SYSTEM_PROMPT).toContain('not present in the data');
    expect(DRAFT_SYSTEM_PROMPT).toContain('Do not reclassify a missing seeker preference');
    expect(DRAFT_SYSTEM_PROMPT).toContain('You do not post');
  });
  it('keeps find-demand judgment separate from draft and publish', async () => {
    expect(DEMAND_PROMPT_VERSION).toBe('find-demand-card-v6');
    expect(DEMAND_SYSTEM_PROMPT).toContain('never draft, fill, or publish');
    expect(DEMAND_SYSTEM_PROMPT).toContain('Generic titles');
    expect(DEMAND_SYSTEM_PROMPT).toContain('no visible connection');
    expect(DEMAND_SYSTEM_PROMPT).toContain('provider promotion, not review');
    expect(guardCardDecision('上海静安大悦城接妆 十月国庆', 'match')).toBe('no_match');
    expect(guardCardDecision('📢上海约妆｜谁说平价约不到好妆！', 'match')).toBe('no_match');
    expect(guardCardDecision('上海博主晚宴约妆～温柔千金', 'match')).toBe('review');
    expect(guardCardDecision('求推荐上海化妆老师', 'match')).toBe('match');
    expect(guardCardDecision('我要去上海大悦城约妆啊，欢迎摆摊', 'match')).toBe('match');
    expect(guardCardDecision('求租上海短租两个月', 'match')).toBe('match');
    const app = await createApp({ APP_MODE: 'mock', DEMAND_DB_PATH: ':memory:' }); apps.push(app);
    const campaign = { id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: [], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' };
    const note = { id: 'xhs:6ab7d5ab000000001b02ce03', title: '找上海化妆师', body: '想约妆，求推荐上海上门化妆师', source: 'xhs', capturedAt: '2026-09-26T00:00:00Z', completeness: 'partial' };
    const response = await app.inject({ method: 'POST', url: '/v1/demand/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ decision: 'match', promptVersion: 'mock-find-demand-v2' });
    expect(response.json()).not.toHaveProperty('draft');
  });
  it('treats an ambiguous card title as review and sends card scope to the model', async () => {
    const campaign = { id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: [], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' };
    const note = { id: 'xhs:6ab7d5ab000000001b02ce03', title: '求接', body: '求接', source: 'xhs', capturedAt: '2026-09-26T00:00:00Z', completeness: 'partial' };
    const mock = await createApp({ APP_MODE: 'mock', DEMAND_DB_PATH: ':memory:' }); apps.push(mock);
    const ambiguous = await mock.inject({ method: 'POST', url: '/v1/demand/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note, inputScope: 'card' } });
    expect(ambiguous.json().decision).toBe('review');
    let upstream: any;
    const fetcher: typeof fetch = async (_input, init) => {
      upstream = JSON.parse(String(init?.body));
      const title = JSON.parse(upstream.input[1].content).note.title;
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ decision: 'match', evidence: [title], reason: '猜测是客户', tags: [] }) }] }] }), { status: 200 });
    };
    const real = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only' }, fetcher); apps.push(real);
    const response = await real.inject({ method: 'POST', url: '/v1/demand/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note, inputScope: 'card' } });
    expect(response.json().decision).toBe('review');
    expect(JSON.parse(upstream.input[1].content).inputScope).toBe('card');
    const vague = await real.inject({ method: 'POST', url: '/v1/demand/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note: { ...note, title: '上海约妆', body: '上海约妆' }, inputScope: 'card' } });
    expect(vague.json().decision).toBe('review');
    const explicit = await real.inject({ method: 'POST', url: '/v1/demand/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note: { ...note, title: '我要去上海大悦城约妆啊，欢迎摆摊', body: '我要去上海大悦城约妆啊，欢迎摆摊' }, inputScope: 'card' } });
    expect(explicit.json().decision).toBe('match');
  });
  it('returns a conservative mock analysis without an upstream request', async () => {
    const app = await createApp({ APP_MODE: 'mock' }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/note/analyze', headers: { host: '127.0.0.1:3417' }, payload: { id: 'n1', title: '上海领证约妆', body: '十月在上海想找领证妆', source: 'fixture', capturedAt: '2026-09-26T00:00:00.000Z', completeness: 'complete' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().decision).toBe('eligible_for_review');
  });
  it('assesses rental demand against a configured campaign', async () => {
    const app = await createApp({ APP_MODE: 'mock' }); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/candidate/analyze', headers: { host: '127.0.0.1:3417' }, payload: {
      campaign: { id: 'rental', name: '房源出租', offering: '徐汇一居室', targetIntent: '寻找长租房源', cities: ['上海'], demandKeywords: ['找一套'], exclusionKeywords: ['已经租到'], accountLabel: '房东账号', confirmedAt: '2026-09-26T00:00:00Z' },
      note: { id: 'fixture:rental-1', title: '上海徐汇租房', body: '想找一套一居室长租', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' }
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().decision).toBe('eligible_for_review');
  });
  it('screens title before detail and keeps plausible rental titles', async () => {
    const app = await createApp({ APP_MODE: 'mock' }); apps.push(app);
    const campaign = { id: 'rental', name: '上海房源出租', offering: '上海主卧合租，月租1900元', targetIntent: '寻找上海合租房间', cities: ['上海'], demandKeywords: ['上海求租'], exclusionKeywords: [], accountLabel: '房东', confirmedAt: '2026-10-04T00:00:00Z' };
    const plausible = await app.inject({ method: 'POST', url: '/v1/candidate/title-screen', headers: { host: '127.0.0.1:3417' }, payload: { campaign, title: '找房', snippet: '' } });
    expect(plausible.json()).toMatchObject({ decision: 'inspect', promptVersion: 'mock-title-v1' });
    const unrelated = await app.inject({ method: 'POST', url: '/v1/candidate/title-screen', headers: { host: '127.0.0.1:3417' }, payload: { campaign, title: '今天的晚饭', snippet: '' } });
    expect(unrelated.json().decision).toBe('reject');
  });
  it('never promotes a clear 3/4-line rental mismatch for a 7/15-line offering', async () => {
    const app = await createApp({ APP_MODE: 'mock' }); apps.push(app);
    const campaign = { id: 'rental', name: '上海房屋出租', offering: '上大聚丰园主卧合租，15号线丰翔路、7号线上大路', targetIntent: '求上海租房。15号线，宝山，7号线。', cities: ['上海'], demandKeywords: ['上海求租'], exclusionKeywords: [], accountLabel: '房东账号', confirmedAt: '2026-09-27T00:00:00Z' };
    const note = { id: 'fixture:rental-lines', title: '上海求租', body: '只考虑3号线和4号线附近合租房', source: 'fixture', capturedAt: '2026-09-27T00:00:00Z', completeness: 'complete' };
    const mismatch = await app.inject({ method: 'POST', url: '/v1/candidate/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note } });
    expect(mismatch.json()).toMatchObject({ decision: 'hard_skip', serviceFit: 'incompatible', decisionSource: 'safety_rule' });
    const noDraft = await app.inject({ method: 'POST', url: '/v1/draft/create', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note, assessment: { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海求租'], reason: '误判' } } });
    expect(noDraft.statusCode).toBe(409);
    const compatible = await app.inject({ method: 'POST', url: '/v1/candidate/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note: { ...note, body: '想找上海7号线附近合租房' } } });
    expect(compatible.json()).toMatchObject({ decision: 'eligible_for_review', serviceFit: 'compatible', decisionSource: 'model' });
  });
  it('finds a city-stripped demand phrase in mock mode and skips a supply post', async () => {
    const app = await createApp({ APP_MODE: 'mock' }); apps.push(app);
    const campaign = { id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: [], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' };
    const base = { id: 'n1', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' };
    const demand = await app.inject({ method: 'POST', url: '/v1/candidate/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note: { ...base, title: '蹲一个3号上海上门化妆师', body: '想约妆，求推荐' } } });
    const supply = await app.inject({ method: 'POST', url: '/v1/candidate/analyze', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note: { ...base, id: 'n2', title: '上海约妆工作室接单', body: '提供上门服务' } } });
    expect(demand.json().decision).toBe('eligible_for_review');
    expect(demand.json().promptVersion).toBe('mock-v2');
    expect(supply.json().decision).toBe('hard_skip');
  });
  it('creates only a review draft for a complete eligible note', async () => {
    const app = await createApp({ APP_MODE: 'mock' }); apps.push(app);
    const campaign = { id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: [], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' };
    const note = { id: 'n1', title: '蹲一个上海化妆师', body: '想约妆，求推荐', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' };
    const assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['想约妆'], reason: '明确求助' };
    const response = await app.inject({ method: 'POST', url: '/v1/draft/create', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note, assessment, style: '自然简短' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().promptVersion).toBe('mock-draft-v1');
    expect(response.json().body.length).toBeGreaterThan(0);
    const partial = await app.inject({ method: 'POST', url: '/v1/draft/create', headers: { host: '127.0.0.1:3417' }, payload: { campaign, note: { ...note, completeness: 'partial' }, assessment } });
    expect(partial.statusCode).toBe(409);
  });
  it('sends a strict non-stored Responses request with the configured model', async () => {
    let upstream: { url?: string; payload?: any } = {};
    const fetcher: typeof fetch = async (input, init) => {
      upstream = { url: String(input), payload: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['找一套'], reason: '匹配目标需求' }) }] }] }), { status: 200 });
    };
    const app = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only' }, fetcher); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/candidate/analyze', headers: { host: '127.0.0.1:3417' }, payload: {
      campaign: { id: 'rental', name: '房源出租', offering: '徐汇一居室', targetIntent: '寻找长租房源', cities: ['上海'], demandKeywords: ['找一套'], exclusionKeywords: [], accountLabel: '房东账号', confirmedAt: '2026-09-26T00:00:00Z' },
      note: { id: 'fixture:rental-1', title: '上海徐汇租房', body: '想找一套一居室长租', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' }
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(upstream.url).toBe('https://api.example.test/v1/responses');
    expect(response.json().promptVersion).toBe('candidate-v10');
    expect(upstream.payload.model).toBe('gpt-5.6-luna');
    expect(upstream.payload.store).toBe(false);
    expect(upstream.payload.text.format).toMatchObject({ type: 'json_schema', strict: true });
  });
  it('uses structured Responses output for a single human-review draft', async () => {
    let upstream: { payload?: any } = {};
    const fetcher: typeof fetch = async (_input, init) => {
      upstream.payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ body: '看到你在找上海化妆师，可以说说日期和妆容要求吗？', warnings: [] }) }] }] }), { status: 200 });
    };
    const app = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only' }, fetcher); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/draft/create', headers: { host: '127.0.0.1:3417' }, payload: {
      campaign: { id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: [], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' },
      note: { id: 'n1', title: '蹲一个上海化妆师', body: '想约妆，求推荐', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' },
      assessment: { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['想约妆'], reason: '明确求助' }, style: '自然简短'
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().promptVersion).toBe('draft-v9');
    expect(upstream.payload.model).toBe('gpt-5.6-luna');
    expect(upstream.payload.store).toBe(false);
    expect(upstream.payload.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 'comment_draft' });
  });
  it('turns an overlong model comment into an empty review draft instead of publishing it', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ body: '这段话太长了'.repeat(20), warnings: [] }) }] }] }), { status: 200 });
    const app = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only' }, fetcher); apps.push(app);
    const response = await app.inject({ method: 'POST', url: '/v1/draft/create', headers: { host: '127.0.0.1:3417' }, payload: {
      campaign: { id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: [], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' },
      note: { id: 'n1', title: '蹲一个上海化妆师', body: '想约妆，求推荐', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' },
      assessment: { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['想约妆'], reason: '明确求助' }
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ body: '', warnings: ['模型草稿超过 60 字，已转待复核，不自动发送。'] });
  });
  it('passes active makeup facts, custom criteria and comment style through every model stage', async () => {
    const template = createBusinessTemplate('makeup', 'artist-template');
    template.judgmentInstructions = '只接上海静安区日常妆客户';
    template.commentStyle = '一句话介绍可提供日常妆';
    template.config.makeupProfile = { cities: ['上海'], serviceAreas: ['静安区'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 200, priceTo: 300, priceNotes: '', availability: '' };
    const campaign = campaignFromBusinessTemplate(template, 'artist-snapshot');
    const note = { id: 'fixture:artist', title: '上海静安区求推荐日常妆化妆师', body: '需要上门，预算300元', source: 'fixture', completeness: 'complete', capturedAt: '2026-10-04' };
    const assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: [note.title], reason: '没有明确冲突', topicFit: 'relevant', serviceDate: null };
    const payloads: any[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)); payloads.push(payload);
      const name = payload.text.format.name;
      const result = name === 'comment_draft' ? { body: '可以提供静安区上门日常妆。', warnings: [] } : name === 'title_screen' ? { decision: 'inspect', reason: '需要约妆' } : name === 'demand_assessment' ? { decision: 'match', evidence: [note.title], reason: '客户约妆需求', tags: ['上海'] } : assessment;
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 });
    };
    const app = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only', DEMAND_DB_PATH: ':memory:' }, fetcher); apps.push(app);
    const stages = [
      ['/v1/candidate/title-screen', { campaign, title: note.title, snippet: '' }],
      ['/v1/candidate/analyze', { campaign, note }],
      ['/v1/draft/create', { campaign, note, assessment }],
      ['/v1/demand/analyze', { campaign, note, inputScope: 'card' }]
    ] as const;
    for (const [url, payload] of stages) {
      const response = await app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:3417' }, payload });
      expect(response.statusCode, response.body).toBe(200);
    }
    for (const payload of payloads) {
      const content = JSON.parse(payload.input[1].content);
      expect(content.business).toMatchObject({ businessType: 'makeup', matchingRequirements: template.judgmentInstructions, makeupProfile: { priceFrom: 200, serviceAreas: ['静安区'] } });
      expect(content.business.rentalProfile).toBeUndefined();
    }
    expect(JSON.parse(payloads[2].input[1].content).style).toBe(template.commentStyle);
  });
});
