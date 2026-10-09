import { describe, expect, it } from 'vitest';
import { CandidatePool, assessmentSchema, campaignSchema, createMockCommand, eligibleTemplates, gateAssessment, noteSchema, rentalOfferingDescription, rentalOfferingHasPrice, rentalProfileIssue, searchCandidateSchema, searchTaskSchema, templateSchema, type Template } from './index.js';

describe('shared contracts', () => {
  it('allows a homepage task without keywords and preserves legacy search tasks', () => {
    const old = { id: 't1', campaignId: 'c1', keyword: '上海约妆', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海约妆', createdAt: '2026-10-06', status: 'collected' };
    expect(searchTaskSchema.parse(old)).toEqual(old);
    expect(searchTaskSchema.parse({ ...old, source: 'home', keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore' })).toMatchObject({ source: 'home', keyword: '' });
  });
  it('does not turn an empty legacy/search keyword into an implicit home task', () => {
    const task = { id: 't1', campaignId: 'c1', keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore', createdAt: '2026-10-06', status: 'opened' };
    expect(searchTaskSchema.safeParse(task).success).toBe(false);
    expect(searchTaskSchema.safeParse({ ...task, source: 'search', keyword: '  ' }).success).toBe(false);
    expect(searchTaskSchema.safeParse({ ...task, source: 'home', keyword: '上海约妆' }).success).toBe(false);
  });
  it('loads existing candidates with a safe unliked default', () => {
    const old = { id: 'c1', taskId: 't1', noteId: 'xhs:123', url: 'https://www.xiaohongshu.com/explore/123', title: '上海找房', snippet: '', status: 'new', reason: '', capturedAt: '2026-10-04', note: null, draft: '' };
    expect(searchCandidateSchema.parse(old)).toMatchObject({ likeStatus: 'none', likedAt: null, authorId: null, followStatus: 'none', followedAt: null });
  });
  it('keeps automatic publication outside the command surface', () => {
    expect(createMockCommand('帮我自动发送评论').action).toBe('unsupported');
  });

  it('accepts an explicitly disabled draft template', () => {
    expect(templateSchema.parse({ id: 't1', name: '草稿', category: '日常', body: '你好', cities: ['上海'], serviceTypes: ['daily'], enabled: false, approvalStatus: 'draft', version: 1, allowedModes: ['original'], selectionCount: 0, markedPublishedCount: 0 }).enabled).toBe(false);
  });

  it('filters before randomization and never repeats a candidate', () => {
    const base: Template = templateSchema.parse({ id: 't1', name: '已审核', category: '领证', body: '正文', cities: ['上海'], serviceTypes: ['certificate'], enabled: true, approvalStatus: 'approved', version: 1, allowedModes: ['original'], selectionCount: 0, markedPublishedCount: 0 });
    const blocked = { ...base, id: 't2', requireKnownFields: ['service_date'] };
    const candidates = eligibleTemplates([base, blocked], { city: '上海', serviceType: 'certificate', knownFields: [], mode: 'original' });
    const pool = new CandidatePool(candidates, () => 0);
    expect(pool.next()?.id).toBe('t1');
    expect(pool.next()).toBeNull();
  });

  it('accepts a non-makeup campaign and gates unsupported model evidence', () => {
    const campaign = campaignSchema.parse({ id: 'rental', name: '房源出租', offering: '上海徐汇一居室', targetIntent: '寻找长租房源', cities: ['上海'], demandKeywords: ['找房', '找一套'], exclusionKeywords: ['已经租到'], accountLabel: '房东账号', confirmedAt: '2026-09-26T00:00:00Z' });
    const note = noteSchema.parse({ id: 'fixture:rental-1', title: '想在上海找房', body: '需要找一套一居室', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' });
    expect(gateAssessment(campaign, note, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['找一套'], reason: '匹配' }).decision).toBe('eligible_for_review');
    expect(gateAssessment(campaign, note, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['预算 5000'], reason: '匹配' }).decision).toBe('manual_review');
    expect(gateAssessment(campaign, { ...note, completeness: 'partial' }, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['找一套'], reason: '匹配' }).decision).toBe('manual_review');
  });

  it('allows semantic demand without an exact keyword, but requires grounded evidence and demand intent', () => {
    const campaign = campaignSchema.parse({ id: 'makeup', name: '化妆服务', offering: '上海上门化妆', targetIntent: '寻找化妆师', cities: ['上海'], demandKeywords: ['上海约妆'], exclusionKeywords: ['已找到'], accountLabel: '测试账号', confirmedAt: '2026-09-26T00:00:00Z' });
    const note = noteSchema.parse({ id: 'n1', title: '蹲一个3号上海上门化妆师', body: '想要自然一点的妆容', source: 'fixture', capturedAt: '2026-09-26T00:00:00Z', completeness: 'complete' });
    expect(gateAssessment(campaign, note, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['蹲一个3号上海上门化妆师'], reason: '求推荐' }).decision).toBe('eligible_for_review');
    expect(gateAssessment(campaign, note, { intent: 'supply', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['蹲一个3号上海上门化妆师'], reason: '错误判断' }).decision).toBe('manual_review');
    expect(gateAssessment(campaign, note, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: [], reason: '无证据' }).decision).toBe('manual_review');
    expect(gateAssessment(campaign, { ...note, body: '已找到，谢谢' }, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['蹲一个3号上海上门化妆师'], reason: '过期' }).decision).toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, resolutionEvidence: '已经找到老师了！' }, { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['蹲一个3号上海上门化妆师'], reason: '错误判断' }).decision).toBe('hard_skip');
  });

  it('skips an explicit rental-line mismatch but allows flexible or overlapping routes', () => {
    const campaign = campaignSchema.parse({ id: 'rental', name: '房屋出租', offering: '上大聚丰园主卧合租，15号线丰翔路、7号线上大路', targetIntent: '寻找上海合租房源', cities: ['上海'], demandKeywords: ['求租'], exclusionKeywords: [], accountLabel: '房东账号', confirmedAt: '2026-09-27T00:00:00Z' });
    const base = noteSchema.parse({ id: 'fixture:rental', title: '上海求租', body: '只考虑3号线和4号线附近的合租房', source: 'fixture', capturedAt: '2026-09-27T00:00:00Z', completeness: 'complete' });
    const assessment = assessmentSchema.parse({ intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海求租'], reason: '模型误判为匹配' });
    expect(gateAssessment(campaign, base, assessment)).toMatchObject({ decision: 'hard_skip', serviceFit: 'incompatible' });
    expect(gateAssessment(campaign, { ...base, title: '上海3/4号线求租', body: '想找房，最好地铁附近' }, assessment).decision).not.toBe('hard_skip');
    expect(gateAssessment(campaign, { ...base, body: '想在3号线求租，7号线也可以' }, assessment).decision).toBe('eligible_for_review');
    expect(gateAssessment(campaign, { ...base, body: '在3号线上班，换乘通勤可接受' }, assessment).decision).toBe('eligible_for_review');
    expect(gateAssessment(campaign, { ...base, body: '求上海7号线附近合租房' }, { ...assessment, serviceFit: 'uncertain' }).decision).toBe('manual_review');
  });
  it('blocks one-bedroom and whole-unit requests when the offering is a shared room', () => {
    const campaign = campaignSchema.parse({ id: 'rental', name: '上海房屋出租', offering: '上大聚丰园主卧合租，15号线丰翔路、7号线上大路', targetIntent: '寻找上海合租房源', cities: ['上海'], demandKeywords: ['求租'], exclusionKeywords: [], accountLabel: '房东账号', confirmedAt: '2026-09-27T00:00:00Z' });
    const note = noteSchema.parse({ id: 'xhs:1', title: '上大附近有人转租吗？', body: '最好近地铁，近上大，只要一居室。', source: 'xhs', capturedAt: '2026-09-27', completeness: 'complete' });
    const assessment = assessmentSchema.parse({ intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上大附近有人转租吗？'], reason: '模型误判为匹配' });
    expect(gateAssessment(campaign, note, assessment)).toMatchObject({ decision: 'hard_skip', serviceFit: 'incompatible' });
    expect(gateAssessment(campaign, { ...note, body: '最好一居室，有合适房源也可以看看。' }, assessment).decision).not.toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, body: '近上大，一居室或合租都可以。' }, assessment).decision).not.toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, title: '上海找房', body: '想找合租，目前还没找到房。#过上整租生活' }, { ...assessment, evidence: ['想找合租'] }).decision).not.toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, title: '上海找房', body: '整租或合租都可以，最好靠近7号线。' }, { ...assessment, evidence: ['上海找房'] }).decision).not.toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, title: '上海找房', body: '一居室也行，女生合租均可，最好靠近7号线。' }, { ...assessment, evidence: ['上海找房'] }).decision).not.toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, title: '上海找房', body: '虽然提到合租，但只要整租，必须一个人住。' }, { ...assessment, evidence: ['上海找房'] }).decision).toBe('hard_skip');
    expect(gateAssessment({ ...campaign, offering: '上大附近整租一居室' }, note, assessment).decision).not.toBe('hard_skip');
  });

  it('requires a stated rent before treating a budgeted rental request as compatible', () => {
    const campaign = campaignSchema.parse({ id: 'rental', name: '上海房屋出租', offering: '上大聚丰园主卧合租，15号线丰翔路、7号线上大路', targetIntent: '寻找上海合租房源', cities: ['上海'], demandKeywords: ['求租'], exclusionKeywords: [], accountLabel: '房东账号', confirmedAt: '2026-09-27T00:00:00Z' });
    const note = noteSchema.parse({ id: 'xhs:1', title: '上海找合租', body: '预算2k以下，想找地铁附近主卧。', source: 'xhs', capturedAt: '2026-09-30', completeness: 'complete' });
    const assessment = assessmentSchema.parse({ intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海找合租'], reason: '模型认为兼容' });
    expect(rentalOfferingHasPrice(campaign)).toBe(false);
    expect(gateAssessment(campaign, note, assessment)).toMatchObject({ decision: 'manual_review', serviceFit: 'uncertain', reason: '作者给出了租金预算，但业务资料未填写房租，无法核验是否匹配。' });
    expect(rentalOfferingHasPrice({ ...campaign, offering: `${campaign.offering}，房租1800元/月` })).toBe(true);
    expect(gateAssessment({ ...campaign, offering: `${campaign.offering}，房租1800元/月` }, note, assessment).decision).toBe('eligible_for_review');
  });

  it('matches the supplied room by explicit hard constraints, not unspoken preferences', () => {
    const rentalProfile = { city: '上海', metroStations: [{ line: 15, station: '丰翔路' }, { line: 7, station: '上大路' }], monthlyRent: 1900, roomType: 'shared_master' as const, privateBathroom: false };
    const campaign = campaignSchema.parse({ id: 'rental', name: '上海主卧合租', offering: rentalOfferingDescription(rentalProfile), rentalProfile, targetIntent: '上海求租合租房间', cities: ['上海'], demandKeywords: ['上海求租'], exclusionKeywords: [], accountLabel: '房东', confirmedAt: '2026-10-04T00:00:00Z' });
    const note = noteSchema.parse({ id: 'xhs:1', title: '上海求租', body: '想找7号线或3号线的合租主卧，预算2000以内。', source: 'xhs', capturedAt: '2026-10-04T00:00:00Z', completeness: 'complete' });
    const assessment = assessmentSchema.parse({ intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海求租'], reason: '无硬性冲突' });
    expect(rentalProfileIssue(campaign)).toBeNull();
    expect(gateAssessment(campaign, note, assessment).decision).toBe('eligible_for_review');
    expect(gateAssessment(campaign, { ...note, body: '只要3号线和4号线附近合租，预算2000以内。' }, assessment).decision).toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, body: '合租可以，预算1800以内。' }, assessment).decision).toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, body: '必须整租，预算3000以内。' }, assessment).decision).toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, body: '只要独卫的合租，预算2000以内。' }, assessment).decision).toBe('hard_skip');
    expect(gateAssessment(campaign, { ...note, body: '最好有独卫，预算2000左右，合租可。' }, assessment).decision).toBe('eligible_for_review');
    expect(gateAssessment(campaign, { ...note, title: '上大路求租', body: '有合租房吗？' }, { ...assessment, evidence: ['上大路求租'] }).decision).toBe('eligible_for_review');
    expect(rentalProfileIssue({ ...campaign, offering: '上海主卧合租' })).not.toBeNull();
  });
});
