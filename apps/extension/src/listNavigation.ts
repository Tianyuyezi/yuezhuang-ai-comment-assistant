// Normal in-page UI only. No deep-link navigation, new tabs, fingerprint changes or CAPTCHA handling.
// Keep route helpers local: sharing runtime imports with background/main would split MV3 content.js.
type AutoSource = 'home' | 'search';
type Context = { href: () => string; blocked: () => string | null; wait?: (ms: number) => Promise<void> };
export const searchKeyword = (href: string) => {
  const url = new URL(href); let keyword = url.searchParams.get('keyword');
  for (let attempt = 0; attempt < 2 && keyword && /%[a-f0-9]{2}/i.test(keyword); attempt++) { try { keyword = decodeURIComponent(keyword); } catch { break; } }
  return keyword;
};
export const isSearchList = (href: string, keyword: string) => {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname === 'www.xiaohongshu.com' && /^\/search_result(?:_ai)?\/?$/.test(url.pathname) && searchKeyword(href) === keyword;
  } catch { return false; }
};
export const isTaskList = (href: string, keyword: string, source: AutoSource = 'search') => {
  if (source === 'search') return isSearchList(href, keyword);
  try { const url = new URL(href); return url.protocol === 'https:' && url.hostname === 'www.xiaohongshu.com' && /^\/(?:explore)?\/?$/.test(url.pathname); }
  catch { return false; }
};
const noteId = (href: string) => {
  const url = new URL(href);
  return url.hostname === 'www.xiaohongshu.com' ? url.pathname.match(/^\/(?:explore|search_result)\/([a-f0-9]+)\/?$/i)?.[1] ?? null : null;
};
const detailRoots = '#noteContainer,.note-container,.note-detail-container,.note-detail';
const detailMasks = '.note-detail-mask,.note-detail-modal';
const excludedDetails = '.comment-item,.commentItem,.comments-container,#comment-list,.recommend-container,[data-recommendation]';
// A title is post content, not proof that a modal is open/closed. Some notes have no
// title, and list/recommendation headings may remain visible behind the detail.
const visibleDetailRoots = (document: Document, visible: (element: Element) => boolean) => {
  const roots = [...document.querySelectorAll(detailRoots)].filter(element => visible(element) && !element.closest(excludedDetails));
  return roots.filter(element => !roots.some(other => other !== element && other.contains(element)));
};
export const mainNoteRoot = (document: Document, visible: (element: Element) => boolean) => {
  const roots = visibleDetailRoots(document, visible);
  return roots.length === 1 ? roots[0] : null;
};
export const hasOpenNoteDetail = (document: Document, visible: (element: Element) => boolean) =>
  visibleDetailRoots(document, visible).length > 0 || [...document.querySelectorAll(detailMasks)].some(element => visible(element) && !element.closest(excludedDetails));
const waitFor = async (context: Context, predicate: () => boolean) => {
  const wait = context.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 25; attempt++) {
    const blocked = context.blocked(); if (blocked) return { ok: false as const, reason: blocked };
    if (predicate()) return { ok: true as const, sourceUrl: context.href() };
    await wait(400);
  }
  return { ok: false as const, reason: 'page_transition_unverified' };
};

export async function searchInPage(document: Document, visible: (element: Element) => boolean, keyword: string, context: Context) {
  const blocked = context.blocked(); if (blocked) return { ok: false, reason: blocked };
  if (!keyword.trim() || keyword.length > 100) return { ok: false, reason: 'invalid_search_keyword' };
  if (isSearchList(context.href(), keyword)) return { ok: true, sourceUrl: context.href() };
  const url = new URL(context.href());
  if (url.hostname !== 'www.xiaohongshu.com' || !/^\/(?:explore|search_result(?:_ai)?)?\/?$/.test(url.pathname)) return { ok: false, reason: 'please_return_to_home_or_search_list' };
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input#search-input,input.search-input,input[placeholder*="搜索"],input[aria-label*="搜索"],input[name="keyword"]')].filter(visible);
  if (inputs.length !== 1 || inputs[0].disabled || inputs[0].readOnly) return { ok: false, reason: 'search_input_not_unique_or_disabled' };
  const input = inputs[0]; const window = document.defaultView!;
  input.focus();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, keyword);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  const container = input.closest('form,.search-container,.input-container,.search-input-container') ?? input.parentElement;
  const buttons = [...(container?.querySelectorAll<HTMLElement>('button[type="submit"],.search-icon,.search-button,[aria-label="搜索"]') ?? [])].filter(element => visible(element) && element !== input && !element.matches('[disabled],[aria-disabled="true"]'));
  const leaves = buttons.filter(element => !buttons.some(other => other !== element && element.contains(other)));
  const invalid = context.blocked(); if (invalid) return { ok: false, reason: invalid };
  if (leaves.length > 1) return { ok: false, reason: 'search_submit_not_unique' };
  if (leaves.length === 1) {
    if (typeof leaves[0].click === 'function') leaves[0].click();
    else leaves[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  else input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  return waitFor(context, () => isSearchList(context.href(), keyword));
}

export async function openNoteInPage(document: Document, visible: (element: Element) => boolean, expectedKeyword: string, expectedNoteId: string, context: Context, source: AutoSource = 'search') {
  const blocked = context.blocked(); if (blocked) return { ok: false, reason: blocked, ambiguous: false };
  if (!isTaskList(context.href(), expectedKeyword, source)) return { ok: false, reason: source === 'home' ? 'home_tab_changed' : 'search_tab_or_keyword_changed', ambiguous: false };
  if (hasOpenNoteDetail(document, visible)) return { ok: false, reason: 'previous_detail_not_closed', ambiguous: false };
  const id = expectedNoteId.replace(/^xhs:/, '');
  if (!/^[a-f0-9]+$/i.test(id)) return { ok: false, reason: 'invalid_note_id', ambiguous: false };
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/explore/"],a[href*="/search_result/"]')]
    .filter(link => visible(link) && noteId(link.href) === id && !link.closest('.comment-item,.comments-container,.recommend-container,[data-recommendation]'));
  const cards = new Map<Element, HTMLAnchorElement[]>();
  for (const link of links) {
    const card = link.closest('section.note-item,section,article,[class*="note-item"],[class*="feed-card"]');
    if (card) cards.set(card, [...(cards.get(card) ?? []), link]);
  }
  if (cards.size !== 1) return { ok: false, reason: cards.size ? 'candidate_card_not_unique' : 'candidate_not_in_loaded_list', ambiguous: false };
  const [card, targets] = [...cards.entries()][0];
  const target = targets.find(link => link.matches('.cover')) ?? targets[0];
  // Never click a link that explicitly opens another window or has an external target.
  if (target.target && target.target !== '_self') return { ok: false, reason: 'candidate_link_opens_new_window', ambiguous: false };
  (card as HTMLElement).scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  const invalid = context.blocked(); if (invalid) return { ok: false, reason: invalid, ambiguous: false };
  target.click();
  const result = await waitFor(context, () => noteId(context.href()) === id && visibleDetailRoots(document, visible).length === 1);
  return { ...result, ambiguous: !result.ok, opened: result.ok };
}

export async function closeNoteInPage(document: Document, visible: (element: Element) => boolean, expectedKeyword: string, expectedNoteId: string, context: Context, source: AutoSource = 'search') {
  const blocked = context.blocked(); if (blocked) return { ok: false, reason: blocked };
  if (isTaskList(context.href(), expectedKeyword, source) && !hasOpenNoteDetail(document, visible)) return { ok: true, sourceUrl: context.href() };
  if (`xhs:${noteId(context.href())}` !== expectedNoteId) return { ok: false, reason: 'note_changed_do_not_close' };
  const roots = visibleDetailRoots(document, visible);
  if (roots.length !== 1) return { ok: false, reason: 'detail_close_scope_unverified' };
  const modal = roots[0].closest(`${detailMasks},[role="dialog"]`) ?? roots[0];
  if (!modal) return { ok: false, reason: 'detail_close_scope_unverified' };
  const buttons = [...modal.querySelectorAll<HTMLElement>('.close-circle,.close-button,[aria-label="关闭"],[aria-label="关闭详情"],[title="关闭"],button[data-close-note]')].filter(element => visible(element) && !element.closest(excludedDetails));
  const leaves = buttons.filter(element => !buttons.some(other => other !== element && element.contains(other)));
  if (leaves.length !== 1 || leaves[0].matches('[disabled],[aria-disabled="true"]')) return { ok: false, reason: 'detail_close_control_not_unique_or_disabled' };
  const invalid = context.blocked(); if (invalid) return { ok: false, reason: invalid };
  if (`xhs:${noteId(context.href())}` !== expectedNoteId) return { ok: false, reason: 'note_changed_do_not_close' };
  leaves[0].click();
  return waitFor(context, () => isTaskList(context.href(), expectedKeyword, source) && !hasOpenNoteDetail(document, visible));
}
