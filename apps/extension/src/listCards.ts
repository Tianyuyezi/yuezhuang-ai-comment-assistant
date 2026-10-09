// Visual order is authoritative for the waterfall feed; DOM order can be column-major.
export function orderedCardLinks(document: Document, visible: (element: Element) => boolean): HTMLAnchorElement[] {
  const cards = new Map<Element, { link: HTMLAnchorElement; top: number; left: number; index: number }>();
  const excluded = '#noteContainer,.note-container,.note-detail-container,.note-detail,.comment-item,.comments-container,.recommend-container,[data-recommendation]';
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="/explore/"],a[href*="/search_result/"]')) {
    if (!visible(link) || link.closest(excluded)) continue;
    const card = link.closest('section.note-item,section,article,[class*="note-item"],[class*="feed-card"]');
    if (!card || cards.has(card)) continue;
    const rect = card.getBoundingClientRect();
    cards.set(card, { link, top: rect.top, left: rect.left, index: cards.size });
  }
  const sorted = [...cards.values()].sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index);
  const result: HTMLAnchorElement[] = [];
  // Small sub-pixel layout differences must not put the right-hand card first.
  for (let index = 0; index < sorted.length;) {
    const top = sorted[index].top; const row = [];
    do { row.push(sorted[index++]); } while (index < sorted.length && sorted[index].top - top <= 8);
    row.sort((a, b) => a.left - b.left || a.top - b.top || a.index - b.index);
    result.push(...row.map(item => item.link));
  }
  return result;
}
