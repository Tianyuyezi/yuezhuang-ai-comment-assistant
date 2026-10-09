type Inspection = { ok: true; control: HTMLElement; liked: boolean } | { ok: false; reason: string };
type LikeResult = { ok: true; liked: true; alreadyLiked: boolean } | { ok: false; reason: string; ambiguous: boolean };
const excluded = '.comment-item,.commentItem,[class*="comment-item"],[class*="commentItem"],.comments-container,#comment-list,[class*="comment-list"],[class*="commentList"],.recommend-container,[data-recommendation]';

export function inspectNoteLike(document: Document, visible: (element: Element) => boolean): Inspection {
  const titles = [...document.querySelectorAll('h1')].filter(visible);
  if (titles.length !== 1) return { ok: false, reason: 'main_note_title_not_unique' };
  const root = titles[0].closest('#noteContainer,.note-container,.note-detail-container,.note-detail');
  if (!root) return { ok: false, reason: 'main_note_like_scope_unverified' };
  const controls = [...root.querySelectorAll<HTMLElement>('.engage-bar .buttons .left > .like-wrapper')]
    .filter(element => visible(element) && !element.closest(excluded));
  if (controls.length !== 1) return { ok: false, reason: 'main_like_control_not_unique' };
  const control = controls[0];
  const states: boolean[] = [];
  for (const attribute of ['aria-pressed', 'data-liked']) {
    const value = control.getAttribute(attribute);
    if (value === 'true') states.push(true);
    if (value === 'false') states.push(false);
  }
  const label = (control.getAttribute('aria-label') ?? control.getAttribute('title') ?? '').replace(/\s+/g, '');
  if (/^(取消点赞|已点赞)$/.test(label)) states.push(true);
  if (label === '未点赞') states.push(false);
  if (states.length && states.some(value => value !== states[0])) return { ok: false, reason: 'main_like_state_conflicting' };
  const symbols = [...control.querySelectorAll('svg use')].map(use => {
    const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    return href.includes('#') ? `#${href.split('#').pop()}` : href;
  });
  // A known filled heart must never be toggled merely because a stale attribute says false.
  if (states[0] === false && symbols.some(icon => icon === '#liked_b' || icon === '#like_a')) return { ok: false, reason: 'main_like_state_conflicting' };
  let liked = states[0];
  if (!states.length) {
    const icons = new Set(symbols);
    if (icons.size !== 1) return { ok: false, reason: 'main_like_state_unknown' };
    const icon = symbols[0];
    // Explicit variants only: an arbitrary #like_* icon is not evidence of a liked note.
    if (icon === '#like_b') liked = false;
    else if (icon === '#liked_b' || icon === '#like_a') liked = true;
    else return { ok: false, reason: 'main_like_state_unknown' };
  }
  if (!liked && (control.matches('[disabled],[aria-disabled="true"]') || control.closest('[aria-disabled="true"]'))) return { ok: false, reason: 'main_like_control_disabled' };
  return { ok: true, control, liked };
}

export async function likeMainNote(document: Document, visible: (element: Element) => boolean,
  validateNote: () => string | null, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<LikeResult> {
  const invalid = validateNote();
  if (invalid) return { ok: false, reason: invalid, ambiguous: false };
  const target = inspectNoteLike(document, visible);
  if (!target.ok) return { ...target, ambiguous: false };
  if (target.liked) return { ok: true, liked: true, alreadyLiked: true };
  const beforeClick = validateNote();
  if (beforeClick) return { ok: false, reason: beforeClick, ambiguous: false };
  // Click once. Re-read the live DOM below because the framework may replace this node.
  target.control.click();
  let confirmations = 0;
  let lastReason = 'like_clicked_but_state_unverified';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await wait(400);
    const invalid = validateNote();
    if (invalid) return { ok: false, reason: invalid, ambiguous: true };
    const current = inspectNoteLike(document, visible);
    confirmations = current.ok && current.liked ? confirmations + 1 : 0;
    if (!current.ok) lastReason = current.reason;
    if (confirmations >= 2) return { ok: true, liked: true, alreadyLiked: false };
  }
  return { ok: false, reason: lastReason === 'like_clicked_but_state_unverified' ? lastReason : `like_clicked_but_state_unverified:${lastReason}`, ambiguous: true };
}
