import { describe, expect, it } from 'vitest';
import { demandCardBatch, isDemandPage, matchesDemandListTab, nextDemandDelayMs, normalizePublished } from './demand';

describe('find-demand page and publication dates', () => {
  it('accepts homepage without a keyword and checks search keyword exactly', () => {
    expect(isDemandPage('https://www.xiaohongshu.com/explore', 'home', null)).toBe(true);
    expect(isDemandPage('https://www.xiaohongshu.com/', 'home', null)).toBe(true);
    expect(isDemandPage('https://www.xiaohongshu.com/search_result?keyword=上海约妆', 'home', null)).toBe(false);
    expect(isDemandPage('https://www.xiaohongshu.com/search_result?keyword=上海约妆', 'search', '上海约妆')).toBe(true);
    expect(isDemandPage('https://www.xiaohongshu.com/search_result?keyword=上海约妆', 'search', '租房')).toBe(false);
  });
  it('keeps raw date precision distinguishable from discovered time', () => {
    expect(normalizePublished('2026-09-26 12:30', '2026-09-27T00:00:00.000Z')).toEqual({ publishedAt: '2026-09-26T04:30:00.000Z', precision: 'minute' });
    expect(normalizePublished('2天前', '2026-09-27T00:00:00.000Z')).toEqual({ publishedAt: '2026-09-25T00:00:00.000Z', precision: 'relative' });
    expect(normalizePublished('59分钟前 上海', '2026-09-27T00:00:00.000Z')).toEqual({ publishedAt: '2026-09-26T23:01:00.000Z', precision: 'relative' });
    expect(normalizePublished(null, '2026-09-27T00:00:00.000Z')).toEqual({ publishedAt: null, precision: 'unknown' });
  });
  it('drains unseen loaded cards across batches before scrolling again', () => {
    const cards = Array.from({ length: 31 }, (_, index) => ({ noteId: `xhs:${index}` }));
    const seen = new Set<string>();
    for (const expected of [15, 15, 1, 0]) {
      const batch = demandCardBatch(cards, seen);
      expect(batch).toHaveLength(expected);
      batch.forEach(card => seen.add(card.noteId));
    }
  });
  it('continues discovery after seconds, slowing only when no new cards load', () => {
    expect(nextDemandDelayMs(0, () => 0)).toBe(2_000);
    expect(nextDemandDelayMs(0, () => 0.999999)).toBeLessThanOrEqual(4_000);
    expect(nextDemandDelayMs(1, () => 0)).toBe(6_000);
    expect(nextDemandDelayMs(100, () => 0.999999)).toBeLessThanOrEqual(20_000);
  });
  it('moves opened records into the viewed tab while keeping all records visible', () => {
    const unread = { decision: 'match' as const, lastOpenedAt: null };
    const viewed = { decision: 'match' as const, lastOpenedAt: '2026-09-27T01:00:00.000Z' };
    expect(matchesDemandListTab(unread, 'match')).toBe(true);
    expect(matchesDemandListTab(unread, 'unread')).toBe(true);
    expect(matchesDemandListTab(unread, 'viewed')).toBe(false);
    expect(matchesDemandListTab(viewed, 'match')).toBe(false);
    expect(matchesDemandListTab(viewed, 'unread')).toBe(false);
    expect(matchesDemandListTab(viewed, 'viewed')).toBe(true);
    expect(matchesDemandListTab(viewed, 'all')).toBe(true);
    expect(matchesDemandListTab({ decision: 'review', lastOpenedAt: null }, 'review')).toBe(true);
    expect(matchesDemandListTab({ decision: 'review', lastOpenedAt: viewed.lastOpenedAt }, 'review')).toBe(false);
  });
});
