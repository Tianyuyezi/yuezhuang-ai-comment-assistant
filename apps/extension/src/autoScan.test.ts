import { describe, expect, it } from 'vitest';
import { FAST_SCAN_DELAY_MS, FAST_SCAN_RETRY_MS, MAX_SCAN_DELAY_MS, MIN_SCAN_DELAY_MS, newCandidates, nextScanDelayMs, scanDelayMs } from './autoScan';
import type { SearchTask, SearchCandidate } from '@yuezhuang/shared';

describe('auto scan safeguards', () => {
  it('schedules one-shot scans between 3 and 5 minutes', () => {
    expect(nextScanDelayMs(() => 0)).toBe(MIN_SCAN_DELAY_MS);
    expect(nextScanDelayMs(() => 0.999999)).toBeLessThanOrEqual(MAX_SCAN_DELAY_MS);
    expect(nextScanDelayMs(() => 0.5)).toBeGreaterThan(MIN_SCAN_DELAY_MS);
  });
  it('scrolls again promptly without pacing, but backs off at the bottom', () => {
    expect(scanDelayMs(false, false)).toBe(FAST_SCAN_DELAY_MS);
    expect(scanDelayMs(false, true)).toBe(FAST_SCAN_RETRY_MS);
    expect(scanDelayMs(true, false, () => 0)).toBe(MIN_SCAN_DELAY_MS);
  });
  it('deduplicates within a task without hiding another task results', () => {
    const task: SearchTask = { id: 'task-1', campaignId: 'campaign-1', keyword: '上海约妆', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=%E4%B8%8A%E6%B5%B7%E7%BA%A6%E5%A6%86', createdAt: '2026-09-26', status: 'collected' };
    const prior = { id: 'old', taskId: 'task-1', noteId: 'xhs:a', url: task.sourceUrl, title: 'A', snippet: '', status: 'new', reason: '', capturedAt: '2026-09-26', note: null, draft: '', promptVersion: null, assessment: null, likeStatus: 'none', likedAt: null, authorId: null, authorName: '', authorUrl: null, followStatus: 'none', followedAt: null, followReason: '' } satisfies SearchCandidate;
    const results = [{ noteId: 'xhs:a', url: task.sourceUrl, title: 'A', snippet: '' }, { noteId: 'xhs:b', url: task.sourceUrl, title: 'B', snippet: '' }, { noteId: 'xhs:b', url: task.sourceUrl, title: 'B', snippet: '' }];
    expect(newCandidates(task, [prior], results, '2026-09-26').map(item => item.noteId)).toEqual(['xhs:b']);
    expect(newCandidates({ ...task, id: 'task-2' }, [prior], results, '2026-09-26').map(item => item.noteId)).toEqual(['xhs:a', 'xhs:b']);
  });
});
