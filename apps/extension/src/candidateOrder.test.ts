import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { searchCandidateSchema, type SearchTask } from '@yuezhuang/shared';
import { alignCandidatesToPage, orderedCandidates } from './candidateOrder';
import { orderedCollection } from './autoScan';
import { loadSearchCandidates, saveSearchCandidate, saveSearchCandidateOrder } from './storage';

const candidate = (id: string, fields = {}) => searchCandidateSchema.parse({ id: `uuid-${id}`, taskId: 'task', noteId: `xhs:${id}`, url: `https://www.xiaohongshu.com/explore/${id}`, title: id, snippet: '', status: 'new', reason: '', capturedAt: '2026-10-06T01:00:00Z', note: null, draft: '', ...fields });
const task: SearchTask = { id: 'task', campaignId: 'campaign', keyword: '上海约妆', status: 'collected', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海约妆', createdAt: '2026-10-06' };
const result = (id: string) => { const item = candidate(id); return { noteId: item.noteId, url: item.url, title: item.title, snippet: item.snippet }; };

describe('persistent Auto page order', () => {
  it('uses sequence numbers rather than newest capture time or UUID', () => {
    const items = [candidate('a', { listOrder: 2, capturedAt: '2026-10-06T03:00:00Z' }), candidate('b', { listOrder: 1 }), candidate('z', { listOrder: 0 })];
    expect(orderedCandidates(items).map(item => item.title)).toEqual(['z', 'b', 'a']);
    expect(items.map(item => item.title)).toEqual(['a', 'b', 'z']);
  });
  it('restores a legacy queue to page order without deleting history, locks or off-page posts', () => {
    const history = candidate('a', { status: 'published', draft: '已发送', likeStatus: 'unknown', followStatus: 'unknown' });
    const items = [candidate('off'), history, candidate('b')];
    const aligned = alignCandidatesToPage(items, [result('b'), result('a'), result('b')]);
    expect(aligned.map(item => item.title)).toEqual(['b', 'a', 'off']);
    expect(aligned[1]).toEqual({ ...history, listOrder: 1 });
    expect(aligned.filter(item => item.status === 'new').map(item => item.title)).toEqual(['b', 'off']);
  });
  it('appends newly scrolled cards after the existing queue, deduplicating both batches and tasks', () => {
    const prior = [candidate('a', { listOrder: 0 }), candidate('b', { listOrder: 1 }), candidate('other', { taskId: 'other', listOrder: 900 })];
    const { additions, updates } = orderedCollection(task, prior, [result('b'), result('c'), result('c'), result('d')], '2026-10-06T05:00:00Z');
    expect(additions.map(item => [item.title, item.listOrder])).toEqual([['c', 2], ['d', 3]]); expect(updates).toEqual([]);
    expect(orderedCandidates([...additions, ...prior.filter(item => item.taskId === task.id)]).map(item => item.title)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('aligns new and legacy cards together at start, and does not touch other tasks', () => {
    const prior = [candidate('b'), candidate('other', { taskId: 'other', listOrder: 900 })];
    const collection = orderedCollection(task, prior, [result('a'), result('b'), result('c')], '2026-10-06', true);
    expect(collection.additions.map(item => [item.title, item.listOrder])).toEqual([['a', 0], ['c', 2]]);
    expect(collection.updates.map(item => [item.title, item.listOrder])).toEqual([['b', 1]]);
  });
  it('has a deterministic fallback for legacy off-page rows, without using UUID order', () => {
    const first = candidate('z', { id: 'zzz', capturedAt: '2026-10-05' });
    expect(orderedCandidates([candidate('a', { id: 'aaa' }), first]).map(item => item.title)).toEqual(['z', 'a']);
    expect(searchCandidateSchema.parse(first).listOrder).toBeUndefined();
  });
  it('preserves sequence and handled status through a real IndexedDB save/load', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    try {
      await saveSearchCandidate(candidate('a', { listOrder: 1, capturedAt: '2026-10-06T05:00:00Z' }));
      await saveSearchCandidate(candidate('z', { listOrder: 0, status: 'published' }));
      const loaded = orderedCandidates(await loadSearchCandidates());
      expect(loaded.map(item => item.title)).toEqual(['z', 'a']); expect(loaded[0].status).toBe('published');
    } finally { vi.unstubAllGlobals(); }
  });
  it('changes only order when a newer interaction result has been saved since collection', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    try {
      const latest = candidate('a', { status: 'published', draft: '已发送', likeStatus: 'unknown', followStatus: 'unknown' });
      await saveSearchCandidate(latest); await saveSearchCandidateOrder(latest.id, 0);
      expect((await loadSearchCandidates())[0]).toEqual({ ...latest, listOrder: 0 });
      await expect(saveSearchCandidateOrder(latest.id, -1)).rejects.toThrow('顺序无效');
      expect((await loadSearchCandidates())[0].status).toBe('published');
    } finally { vi.unstubAllGlobals(); }
  });
});
