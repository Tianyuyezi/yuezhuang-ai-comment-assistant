import type { SearchCandidate, SearchTask } from '@yuezhuang/shared';
import { alignCandidatesToPage } from './candidateOrder';

export const AUTO_SCAN_ALARM = 'yuezhuang-auto-scan';
export const MIN_SCAN_DELAY_MS = 3 * 60_000;
export const MAX_SCAN_DELAY_MS = 5 * 60_000;
export const FAST_SCAN_DELAY_MS = 2_000;
export const FAST_SCAN_RETRY_MS = 30_000;

export type AutoScanState = {
  status: 'stopped' | 'running' | 'paused';
  runId: string | null;
  taskId: string | null;
  tabId: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastAdded: number;
  totalAdded: number;
  stalledCount: number;
  paceEnabled: boolean;
  reason: string;
};

export const initialAutoScanState: AutoScanState = {
  status: 'stopped', runId: null, taskId: null, tabId: null,
  nextRunAt: null, lastRunAt: null, lastAdded: 0, totalAdded: 0, stalledCount: 0, paceEnabled: false, reason: ''
};

export function scanDelayMs(paceEnabled: boolean, stalled: boolean, random = Math.random): number {
  return paceEnabled ? nextScanDelayMs(random) : stalled ? FAST_SCAN_RETRY_MS : FAST_SCAN_DELAY_MS;
}

export function nextScanDelayMs(random = Math.random): number {
  return MIN_SCAN_DELAY_MS + Math.floor(random() * (MAX_SCAN_DELAY_MS - MIN_SCAN_DELAY_MS + 1));
}

export function newCandidates(
  task: SearchTask,
  existing: SearchCandidate[],
  results: Array<{ noteId: string; url: string; title: string; snippet: string }>,
  now: string
): SearchCandidate[] {
  const known = new Set(existing.filter(item => item.taskId === task.id).map(item => item.noteId));
  let listOrder = existing.filter(item => item.taskId === task.id).reduce((next, item) => Math.max(next, (item.listOrder ?? -1) + 1), 0);
  return results.flatMap(item => {
    if (known.has(item.noteId)) return [];
    known.add(item.noteId);
    return [{
      id: crypto.randomUUID(), taskId: task.id, noteId: item.noteId,
      url: item.url, title: item.title, snippet: item.snippet,
      status: 'new' as const, reason: '等待打开并读取完整笔记',
      capturedAt: now, listOrder: listOrder++, note: null, draft: '', promptVersion: null, assessment: null, likeStatus: 'none' as const, likedAt: null,
      authorId: null, authorName: '', authorUrl: null, followStatus: 'none' as const, followedAt: null, followReason: ''
    }];
  });
}

export function orderedCollection(task: SearchTask, existing: SearchCandidate[], results: Array<{ noteId: string; url: string; title: string; snippet: string }>, now: string, align = false) {
  const additions = newCandidates(task, existing, results, now);
  if (!align) return { additions, updates: [] as SearchCandidate[] };
  const prior = new Map(existing.filter(item => item.taskId === task.id).map(item => [item.id, item]));
  const ordered = alignCandidatesToPage([...prior.values(), ...additions], results);
  return {
    additions: ordered.filter(item => !prior.has(item.id)),
    updates: ordered.filter(item => prior.has(item.id) && prior.get(item.id)!.listOrder !== item.listOrder)
  };
}
