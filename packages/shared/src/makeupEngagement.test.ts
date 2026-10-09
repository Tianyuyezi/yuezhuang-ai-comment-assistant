import { describe, expect, it } from 'vitest';
import { campaignFromBusinessTemplate, candidateEngagementPolicy, createBusinessTemplate, makeupDateIssue, shanghaiDate, type Assessment, type NoteSnapshot } from './index.js';
const template = createBusinessTemplate('makeup', 'artist');
template.config.makeupProfile = { cities: ['上海'], serviceAreas: ['上海'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 359, priceTo: null, priceNotes: '', availability: '' };
const campaign = campaignFromBusinessTemplate(template, 'artist-snapshot');
const note: NoteSnapshot = { id: 'fixture:date', title: '上海求日常妆', body: '需要上门日常妆，10月3日或者10月9日都可以', authorName: '测试客户', source: 'xhs', completeness: 'complete', capturedAt: '2026-10-06T04:00:00Z' };
const assessment: Assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', topicFit: 'relevant', evidence: [note.title], reason: '明确需求', clientBudget: null, serviceDate: null };
const policy = (value = note, result = assessment) => candidateEngagementPolicy(campaign, value, result, '2026-10-06');

describe('separate makeup interaction permissions', () => {
  it('uses the Shanghai calendar day across a UTC midnight boundary', () => {
    expect(shanghaiDate(new Date('2026-10-05T16:01:00Z'))).toBe('2026-10-06');
  });
  it('allows likes/follows but no comments for an expired requested date', () => {
    expect(policy(note, { ...assessment, serviceDate: { lastAcceptableDate: '2026-10-03', evidence: '10月3日' } })).toMatchObject({ canLike: true, canFollow: true, canComment: false });
  });
  it.each(['2026-10-06', '2026-10-09', '2027-10-03'])('does not call the current or a future requested date expired: %s', date => {
    expect(policy(note, { ...assessment, serviceDate: { lastAcceptableDate: date, evidence: '10月9日' } }).canComment).toBe(true);
  });
  it('uses the last acceptable date when one option remains in the future', () => {
    expect(policy(note, { ...assessment, serviceDate: { lastAcceptableDate: '2026-10-09', evidence: '10月3日或者10月9日都可以' } }).canComment).toBe(true);
  });
  it('blocks comment, not other eligible actions, when the requested date is invalid or ungrounded', () => {
    for (const serviceDate of [{ lastAcceptableDate: null, evidence: '10月3日' }, { lastAcceptableDate: '2026-02-30', evidence: '10月3日' }, { lastAcceptableDate: '2026-10-09', evidence: '不存在的日期' }]) {
      expect(policy(note, { ...assessment, serviceDate })).toMatchObject({ canLike: true, canFollow: true, canComment: false });
    }
    expect(makeupDateIssue(note, assessment, '2026-10-06')).toBeNull();
  });
  it.each(['上海化妆师', '美妆老师', '妆妆', '约妆客户'])('applies the exact user rule for names containing 妆: %s', authorName => {
    expect(policy({ ...note, authorName })).toMatchObject({ canLike: true, canFollow: false, canComment: false });
  });
  it('allows only a relevant artist promotion to be liked without inventing customer demand', () => {
    const supply: Assessment = { ...assessment, intent: 'supply', decision: 'hard_skip', serviceFit: 'incompatible', reason: '同行接单' };
    expect(policy(note, supply)).toMatchObject({ canLike: true, canFollow: false, canComment: false });
    expect(policy(note, { ...supply, topicFit: 'irrelevant' })).toMatchObject({ canLike: false, canFollow: false, canComment: false });
  });
  it('does not bypass safety checks for an artist or expired demand', () => {
    for (const value of [{ ...note, resolutionEvidence: '已找到' }, { ...note, completeness: 'partial' as const }, { ...note, title: '北京求日常妆', body: '上门10月3日', authorName: '北京妆师' }]) {
      expect(policy(value)).toMatchObject({ canLike: false, canFollow: false, canComment: false });
    }
    for (const authorName of [null, undefined, '']) expect(policy({ ...note, authorName })).toMatchObject({ canLike: true, canFollow: false, canComment: false });
  });
});
