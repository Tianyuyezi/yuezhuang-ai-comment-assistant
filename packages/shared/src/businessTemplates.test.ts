import { describe, expect, it } from 'vitest';
import { businessTemplateFromCampaign, businessTemplateIssue, campaignFromBusinessTemplate, createBusinessTemplate, gateAssessment, type Assessment } from './index.js';

const assessment: Assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海求租'], reason: '真实需求' };
describe('business templates', () => {
  it('preserves the user-supplied rental facts in an activation snapshot', () => {
    const template = createBusinessTemplate('rental', 'rental');
    const campaign = campaignFromBusinessTemplate(template, 'snapshot-1');
    expect(campaign).toMatchObject({ businessType: 'rental', businessTemplateId: 'rental', businessTemplateVersion: 1, rentalProfile: { monthlyRent: 1900, roomType: 'shared_master', privateBathroom: false, metroStations: [{ line: 15, station: '丰翔路' }, { line: 7, station: '上大路' }] } });
    template.config.rentalProfile!.monthlyRent = 2000;
    expect(campaign.rentalProfile!.monthlyRent).toBe(1900);
    expect(businessTemplateFromCampaign(campaign).config.offering).toBe(campaign.offering);
  });
  it('allows an incomplete makeup draft, but does not fabricate facts or activate it', () => {
    const template = createBusinessTemplate('makeup', 'makeup');
    expect(template.config.makeupProfile!.cities).toEqual([]);
    expect(template.config.makeupProfile!.priceFrom).toBeNull();
    expect(businessTemplateIssue(template)).toBeTruthy();
    expect(() => campaignFromBusinessTemplate(template, 'snapshot')).toThrow();
    template.config.makeupProfile = { cities: ['上海'], serviceAreas: ['静安'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 200, priceTo: 300, priceNotes: '', availability: '周末' };
    const campaign = campaignFromBusinessTemplate(template, 'makeup-snapshot');
    expect(campaign).toMatchObject({ businessType: 'makeup', makeupProfile: { priceFrom: 200 }, cities: ['上海'] });
    expect(campaign.rentalProfile).toBeUndefined();
    expect(campaign.offering).toContain('静安');
    template.config.makeupProfile.priceTo = 100;
    expect(businessTemplateIssue(template)).toContain('上限');
  });
  it('rejects archived templates and missing delivery facts', () => {
    const rental = createBusinessTemplate('rental', 'rental');
    rental.archivedAt = '2026-10-04';
    expect(() => campaignFromBusinessTemplate(rental, 'new')).toThrow('已归档');
    const makeup = createBusinessTemplate('makeup', 'makeup');
    makeup.config.makeupProfile = { cities: ['上海'], serviceAreas: [], serviceTypes: ['领证妆'], deliveryMode: 'studio', studioAddress: '', priceFrom: null, priceTo: null, priceNotes: '根据妆容报价', availability: '' };
    expect(businessTemplateIssue(makeup)).toContain('地址');
    makeup.config.makeupProfile.studioAddress = '静安测试店';
    expect(businessTemplateIssue(makeup)).toBeNull();
  });
  it('keeps rental hard-condition rules out of explicitly different business types', () => {
    const campaign = campaignFromBusinessTemplate(createBusinessTemplate('rental', 'rental'), 'snapshot');
    const note = { id: 'n1', title: '上海求租', body: '必须独卫，只考虑3号线，预算1000', source: 'fixture' as const, capturedAt: '2026-10-04', completeness: 'complete' as const };
    expect(gateAssessment(campaign, note, assessment).decision).toBe('hard_skip');
    expect(gateAssessment({ ...campaign, businessType: 'custom' }, note, assessment).decision).toBe('eligible_for_review');
  });
});
