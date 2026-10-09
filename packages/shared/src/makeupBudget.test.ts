import { describe, expect, it } from 'vitest';
import { assessmentSchema, businessTemplateIssue, campaignFromBusinessTemplate, createBusinessTemplate, gateAssessment, makeupBudgetFilter, makeupBudgetOutsideRange, type Assessment, type MakeupBudgetFilter, type NoteSnapshot } from './index.js';

const note: NoteSnapshot = { id: 'fixture:budget', title: '上海求日常妆化妆师', body: '需要上门，预算200元', source: 'fixture', capturedAt: '2026-10-06', completeness: 'complete' };
const assessment: Assessment = { intent: 'demand', serviceFit: 'compatible', decision: 'eligible_for_review', evidence: [note.title], reason: '明确客户求助，无非金额冲突', clientBudget: { min: 200, max: 200, evidence: '预算200元' } };
function template(filter?: MakeupBudgetFilter) {
  const value = createBusinessTemplate('makeup', 'artist');
  value.config.makeupProfile = { cities: ['上海'], serviceAreas: ['上海'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 359, priceTo: null, priceNotes: '路费另计', availability: '', ...(filter ? { budgetFilter: filter } : {}) };
  return value;
}
const campaign = (filter?: MakeupBudgetFilter) => campaignFromBusinessTemplate(template(filter), 'artist-snapshot');

describe('optional makeup customer-budget filtering', () => {
  it('defaults legacy profiles to ignore without changing configured service prices', () => {
    const legacy = campaign();
    expect(makeupBudgetFilter(legacy)).toEqual({ mode: 'ignore', min: null, max: null });
    expect(gateAssessment(legacy, note, assessment).decision).toBe('eligible_for_review');
    expect(legacy.makeupProfile!.priceFrom).toBe(359);
    expect(legacy.offering).toContain('359元起');
    expect(assessmentSchema.parse({ ...assessment, clientBudget: undefined }).clientBudget).toBeUndefined();
  });
  it('ignores even a retained restrictive range when switched off', () => {
    expect(gateAssessment(campaign({ mode: 'ignore', min: 400, max: 500 }), note, assessment).decision).toBe('eligible_for_review');
  });
  it.each([
    [100, 300, false], [200, 200, false], [201, 500, true], [0, 199, true],
    [null, 199, true], [201, null, true], [null, null, false]
  ])('checks an inclusive customer interval %s–%s independently of the fee', (min, max, excluded) => {
    const value = campaign({ mode: 'range', min, max });
    const result = gateAssessment(value, note, assessment);
    expect(result.decision).toBe(excluded ? 'hard_skip' : 'eligible_for_review');
    expect(value.makeupProfile!.priceFrom).toBe(359);
  });
  it('accepts overlapping and one-sided client intervals', () => {
    const value = campaign({ mode: 'range', min: 300, max: 500 });
    for (const budget of [{ min: 200, max: 400 }, { min: 400, max: null }, { min: null, max: 300 }]) {
      expect(makeupBudgetOutsideRange(value, note, { ...budget, evidence: '预算200元' })).toBe(false);
    }
  });
  it('never fabricates exclusion from missing, ungrounded or inverted extraction', () => {
    const value = campaign({ mode: 'range', min: 300, max: 500 });
    for (const budget of [null, undefined, { min: null, max: null, evidence: '预算200元' }, { min: 200, max: 100, evidence: '预算200元' }, { min: 200, max: 200, evidence: '不存在的预算' }]) {
      expect(gateAssessment(value, note, { ...assessment, clientBudget: budget }).decision).toBe('eligible_for_review');
    }
  });
  it('does not promote solved, supply, non-monetary mismatch or unreadable posts', () => {
    const value = campaign();
    expect(gateAssessment(value, { ...note, resolutionEvidence: '已找到' }, assessment).decision).toBe('hard_skip');
    expect(gateAssessment(value, note, { ...assessment, intent: 'supply', decision: 'hard_skip', serviceFit: 'incompatible' }).decision).toBe('hard_skip');
    expect(gateAssessment(value, note, { ...assessment, serviceFit: 'incompatible', decision: 'hard_skip', reason: '明确只接受到店' }).decision).toBe('hard_skip');
    expect(gateAssessment(value, { ...note, completeness: 'partial' }, assessment).decision).toBe('manual_review');
  });
  it('validates the optional customer range separately from service fee bounds', () => {
    expect(businessTemplateIssue(template({ mode: 'range', min: 500, max: 100 }))).toContain('客户预算');
    expect(businessTemplateIssue(template({ mode: 'ignore', min: 500, max: 100 }))).toBeNull();
    expect(createBusinessTemplate('makeup', 'new').config.makeupProfile!.budgetFilter!.mode).toBe('ignore');
  });
  it('preserves rental affordability exclusions', () => {
    const rental = campaignFromBusinessTemplate(createBusinessTemplate('rental', 'rental'), 'rental-snapshot');
    const rentalNote = { ...note, title: '上海求租', body: '想找合租，预算最多1800元' };
    expect(gateAssessment(rental, rentalNote, { ...assessment, evidence: ['上海求租'], clientBudget: null }).decision).toBe('hard_skip');
  });
});
