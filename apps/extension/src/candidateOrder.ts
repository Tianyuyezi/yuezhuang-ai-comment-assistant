import type { SearchCandidate } from '@yuezhuang/shared';

// Execution order is not the history view's capture-time-descending order.
export function orderedCandidates(items: SearchCandidate[]): SearchCandidate[] {
  return [...items].sort((a, b) => {
    if (a.listOrder !== undefined && b.listOrder !== undefined) return a.listOrder - b.listOrder || a.noteId.localeCompare(b.noteId);
    if (a.listOrder !== undefined) return -1;
    if (b.listOrder !== undefined) return 1;
    return a.capturedAt.localeCompare(b.capturedAt) || a.noteId.localeCompare(b.noteId);
  });
}

// Reconcile legacy/random queues against the currently loaded page on a read-only
// collection/start. Keep status, interaction locks and all off-page records intact.
export function alignCandidatesToPage(items: SearchCandidate[], results: Array<{ noteId: string }>): SearchCandidate[] {
  const byNote = new Map(items.map(item => [item.noteId, item]));
  const ordered: SearchCandidate[] = [];
  for (const result of results) {
    const item = byNote.get(result.noteId);
    if (item) { ordered.push(item); byNote.delete(result.noteId); }
  }
  ordered.push(...orderedCandidates([...byNote.values()]));
  return ordered.map((item, listOrder) => ({ ...item, listOrder }));
}
