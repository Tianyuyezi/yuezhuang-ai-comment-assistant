// Scope controls to the main note's author header. Never use comment or recommendation follows.
export type AuthorFollowState = { authorId: string; authorName: string; authorUrl: string; following: boolean };
type Inspection = { ok: true; state: AuthorFollowState; control: HTMLElement } | { ok: false; reason: string };
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const followLabel = (element: Element) => compact(element.textContent ?? '').replace(/[\s+＋]/g, '');
const excluded = '.comment-item,.commentItem,[class*="comment-item"],[class*="commentItem"],.comments-container,#comment-list,[class*="comment-list"],[class*="commentList"],.recommend-container,[data-recommendation]';
export function authorIdFromProfileUrl(value: string): string | null {
  try {
    const url = new URL(value, 'https://www.xiaohongshu.com');
    return url.hostname === 'www.xiaohongshu.com' && url.protocol === 'https:' ? url.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/i)?.[1].toLowerCase() ?? null : null;
  } catch { return null; }
}
export function inspectNoteAuthor(document: Document, visible: (element: Element) => boolean): Pick<AuthorFollowState, 'authorId' | 'authorName' | 'authorUrl'> | null {
  const titles = [...document.querySelectorAll('h1')].filter(visible);
  if (titles.length !== 1) return null;
  const root = titles[0].closest('#noteContainer,.note-container,.note-detail-container,.note-detail');
  if (!root) return null;
  const authors = new Map<string, HTMLAnchorElement>();
  for (const link of root.querySelectorAll<HTMLAnchorElement>('.author-container a[href*="/user/profile/"],.author-wrapper a[href*="/user/profile/"],.note-author a[href*="/user/profile/"]')) {
    const id = authorIdFromProfileUrl(link.href);
    if (id && visible(link) && !link.closest(excluded) && compact(link.textContent ?? '')) authors.set(id, link);
  }
  if (authors.size !== 1) return null;
  const [authorId, link] = [...authors.entries()][0];
  return { authorId, authorName: compact(link.textContent ?? '').slice(0, 200), authorUrl: `https://www.xiaohongshu.com/user/profile/${authorId}` };
}
export function inspectAuthorFollow(document: Document, visible: (element: Element) => boolean): Inspection {
  const titles = [...document.querySelectorAll('h1')].filter(visible);
  if (titles.length !== 1) return { ok: false, reason: 'main_note_title_not_unique' };
  const root = titles[0].closest('#noteContainer,.note-container,.note-detail-container,.note-detail');
  if (!root) return { ok: false, reason: 'main_note_author_scope_unverified' };
  const controls = [...root.querySelectorAll<HTMLElement>('.author-container .follow-btn,.author-container .follow-button,.author-container button,.author-container [role="button"],.author-wrapper .follow-btn,.author-wrapper .follow-button,.author-wrapper button,.author-wrapper [role="button"],.note-author button,.note-author [role="button"]')]
    .filter(element => visible(element) && !element.closest(excluded) && /^(关注|已关注|互相关注|相互关注)$/.test(followLabel(element)));
  const leaves = controls.filter(element => !controls.some(other => other !== element && element.contains(other)));
  if (leaves.length !== 1) return { ok: false, reason: 'main_author_follow_control_not_unique' };
  const control = leaves[0];
  const header = control.closest('.author-container,.author-wrapper,.note-author');
  if (!header) return { ok: false, reason: 'main_note_author_scope_unverified' };
  const authors = new Map<string, HTMLAnchorElement>();
  for (const link of header.querySelectorAll<HTMLAnchorElement>('a[href*="/user/profile/"]')) {
    const id = authorIdFromProfileUrl(link.href);
    if (id && visible(link) && !link.closest(excluded) && (!authors.has(id) || compact(link.textContent ?? ''))) authors.set(id, link);
  }
  if (authors.size !== 1) return { ok: false, reason: 'main_author_identity_not_unique' };
  const [authorId, link] = [...authors.entries()][0];
  const following = followLabel(control) !== '关注';
  if (!following && (control.matches('[disabled],[aria-disabled="true"]') || control.closest('[aria-disabled="true"]'))) return { ok: false, reason: 'main_author_follow_disabled' };
  return { ok: true, state: { authorId, authorName: compact(link.textContent ?? '').slice(0, 200), authorUrl: `https://www.xiaohongshu.com/user/profile/${authorId}`, following }, control };
}

export async function followAuthor(document: Document, visible: (element: Element) => boolean, expectedAuthorId: string,
  validateNote: () => string | null, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const invalid = validateNote();
  if (invalid) return { ok: false, reason: invalid, ambiguous: false };
  const target = inspectAuthorFollow(document, visible);
  if (!target.ok) return { ...target, ambiguous: false };
  if (target.state.authorId !== expectedAuthorId) return { ok: false, reason: 'main_author_changed', ambiguous: false };
  if (target.state.following) return { ok: true, ...target.state, followed: true, alreadyFollowing: true };
  // No toggling or blind retry: the only clicked state is an identified author's explicit 关注 control.
  const beforeClick = validateNote();
  if (beforeClick) return { ok: false, reason: beforeClick, ambiguous: false };
  target.control.click();
  let confirmations = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(400);
    const invalid = validateNote();
    if (invalid) return { ok: false, reason: invalid, ambiguous: true };
    const current = inspectAuthorFollow(document, visible);
    if (!current.ok || current.state.authorId !== expectedAuthorId) return { ok: false, reason: current.ok ? 'main_author_changed' : current.reason, ambiguous: true };
    confirmations = current.state.following ? confirmations + 1 : 0;
    if (confirmations >= 2) return { ok: true, ...current.state, followed: true, alreadyFollowing: false };
  }
  return { ok: false, reason: 'follow_clicked_but_state_unverified', ambiguous: true };
}
