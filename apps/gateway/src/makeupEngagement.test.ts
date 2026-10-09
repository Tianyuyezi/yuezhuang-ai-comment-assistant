import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { campaignFromBusinessTemplate, createBusinessTemplate } from '@yuezhuang/shared';
import { createApp } from './server.js';

const apps: FastifyInstance[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-06T04:00:00Z')); });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.useRealTimers(); });
const template = createBusinessTemplate('makeup', 'artist');
template.config.makeupProfile = { cities: ['上海'], serviceAreas: ['上海'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 359, priceTo: null, priceNotes: '', availability: '10月9日可以上门' };
const campaign = campaignFromBusinessTemplate(template, 'artist-snapshot');
const note = { id: 'fixture:date', title: '上海求日常妆化妆师', body: '想找上门化妆师，10月3日约日常妆', authorName: '测试客户', source: 'xhs', completeness: 'complete', capturedAt: '2026-10-06T04:00:00Z', publishedRaw: '1天前' };
const assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', topicFit: 'relevant', evidence: [note.title], reason: '日常妆需求，服务方式匹配', clientBudget: null, serviceDate: null as { lastAcceptableDate: string; evidence: string } | null };
async function appFor(result: object) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 }));
  const app = await createApp({ APP_MODE: 'real', MODEL_API_ORIGIN: 'https://api.example.test', MODEL_API_KEY: 'test-only' }, fetcher); apps.push(app); return { app, fetcher };
}
const post = (app: FastifyInstance, url: string, payload: object) => app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:3417' }, payload });

describe('server-side makeup comment restrictions', () => {
  it('returns separate permissions and blocks draft generation for a passed service date', async () => {
    const expired = { ...assessment, serviceDate: { lastAcceptableDate: '2026-10-03', evidence: '10月3日' } };
    const { app, fetcher } = await appFor(expired);
    const analyzed = await post(app, '/v1/candidate/analyze', { campaign, note });
    expect(analyzed.json()).toMatchObject({ decision: 'eligible_for_review', engagementPolicy: { canLike: true, canFollow: true, canComment: false } });
    const denied = await post(app, '/v1/draft/create', { campaign, note, assessment: analyzed.json() });
    expect(denied.statusCode).toBe(409); expect(denied.json().error).toContain('已过期'); expect(fetcher).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(payload.input[1].content).business).toMatchObject({ referenceDate: '2026-10-06', timeZone: 'Asia/Shanghai' });
    expect(payload.text.format.schema.required).toEqual(expect.arrayContaining(['topicFit', 'serviceDate']));
  });
  it('disallows follow/comment for an artist name even if AI reports customer demand', async () => {
    const { app, fetcher } = await appFor(assessment);
    const artist = { ...note, authorName: '上海美妆老师' };
    const analyzed = await post(app, '/v1/candidate/analyze', { campaign, note: artist });
    expect(analyzed.json().engagementPolicy).toMatchObject({ canLike: true, canFollow: false, canComment: false });
    expect((await post(app, '/v1/draft/create', { campaign, note: artist, assessment })).statusCode).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('permits only a like for relevant supply, with no false eligible classification', async () => {
    const { app } = await appFor({ ...assessment, intent: 'supply', decision: 'hard_skip', serviceFit: 'incompatible' });
    const analyzed = await post(app, '/v1/candidate/analyze', { campaign, note });
    expect(analyzed.json()).toMatchObject({ decision: 'hard_skip', intent: 'supply', engagementPolicy: { canLike: true, canFollow: false, canComment: false } });
  });
  it('keeps a current/future date eligible and rejects an old assessment missing the date check', async () => {
    const { app, fetcher } = await appFor({ body: '上门日常妆359元起。', warnings: [] });
    const futureNote = { ...note, body: '10月9日想找上海上门日常妆' };
    const future = { ...assessment, serviceDate: { lastAcceptableDate: '2026-10-09', evidence: '10月9日' } };
    expect((await post(app, '/v1/draft/create', { campaign, note: futureNote, assessment: future })).json().body).toBe('上门日常妆359元起。');
    const { serviceDate: _date, ...old } = assessment;
    const denied = await post(app, '/v1/draft/create', { campaign, note, assessment: old });
    expect(denied.statusCode).toBe(409); expect(denied.json().error).toContain('旧判断缺少约妆日期'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
