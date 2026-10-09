import { commentsFullyLoaded, visibleCommentsReady } from './commentCoverage';
import { followAuthor, inspectAuthorFollow, inspectNoteAuthor } from './authorFollow';
import { inspectNoteLike, likeMainNote } from './noteLike';
import { closeNoteInPage, hasOpenNoteDetail, isSearchList, isTaskList, mainNoteRoot, openNoteInPage, searchInPage } from './listNavigation';
import { platformRestriction as detectPlatformRestriction } from './pageSafety';
import { orderedCardLinks } from './listCards';
import { capturePublicationReceipt, inspectPublication, waitForPublication } from './notePublication';

declare const __YUEZHUANG_CONTENT_VERSION__: string;
const contentVersion = __YUEZHUANG_CONTENT_VERSION__;
const runtimeAtLoad = chrome.runtime;
const contentInstance = [...crypto.getRandomValues(new Uint32Array(4))].join('-');
let activeContext = true;
const platformRestriction = (document: Document, href: string) => activeContext ? detectPlatformRestriction(document, href) : 'content_context_replaced';

type Message = { type: 'ASSISTANT_SEARCH_RESULTS' | 'DEMAND_PAGE_RESULTS' | 'ASSISTANT_PAGE_GUARD' } | { type: 'ASSISTANT_FEED_RESULTS' | 'ASSISTANT_SCROLL_FEED'; source: 'home' | 'search'; expectedKeyword: string } | { type: 'ASSISTANT_UI_SEARCH'; keyword: string } | { type: 'ASSISTANT_OPEN_NOTE' | 'ASSISTANT_CLOSE_NOTE'; expectedSource?: 'home' | 'search'; expectedKeyword: string; expectedNoteId: string } | { type: 'ASSISTANT_SCROLL_SEARCH'; expectedKeyword: string } | { type: 'DEMAND_SCROLL'; source: 'home' | 'search'; expectedKeyword: string | null } | { type: 'ASSISTANT_READ_NOTE' } | { type: 'ASSISTANT_COMMENT_DIAGNOSTIC' } | { type: 'ASSISTANT_FILL' | 'ASSISTANT_PUBLISH'; expectedNoteId: string; expectedTitle: string; expectedBody: string; text: string } | { type: 'ASSISTANT_PUBLICATION_STATE'; expectedNoteId: string; expectedTitle: string; expectedBody: string; text: string; expectedSenderId?: string } | { type: 'ASSISTANT_LIKE' | 'ASSISTANT_LIKE_STATE' | 'ASSISTANT_AUTHOR_FOLLOW_STATE'; expectedNoteId: string; expectedTitle: string; expectedBody: string } | { type: 'ASSISTANT_FOLLOW'; expectedNoteId: string; expectedTitle: string; expectedBody: string; expectedAuthorId: string };
let pageSession: { noteId: string; keyword: string; source: 'home' | 'search' } | null = null;
const navigationContext = () => ({ href: () => location.href, blocked: () => platformRestriction(document, location.href) });
const isFixture = () => ['127.0.0.1', 'localhost'].includes(location.hostname);
const isXhs = () => location.hostname === 'www.xiaohongshu.com';
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
// Kept local because MV3 requires content.js to be a standalone script.
const resolutionEvidence = (texts: string[]) => texts.map(compact).find(text => /(?:已经|已)(?:找到|约到|租到|解决|定好)(?:老师|化妆师|妆娘|房子|房源|人|了|啦)?|(?:找到|约到|租到)(?:老师|化妆师|妆娘|房子|房源)了|(?:不用|不需要)(?:再)?(?:推荐|找|了)/.test(text))?.slice(0, 300) ?? null;
const textIsComplete = (title: string, body: string, verified: boolean) => Boolean(title && verified && body.length >= 4 && body.length < 10_000 && !/(?:如图|看图|图[一二三四五六七八九十\d]|[pP][1-9]|图片里|图片上|照片里|图中|见图|要求图片)/.test(`${title} ${body}`) && !/[.。…]{3,}$/.test(body));
const visible = (element: Element) => Boolean((element as HTMLElement).getClientRects().length) && !element.closest('[aria-hidden="true"]');
const xhsNoteIdFromUrl = (value: string) => {
  const url = new URL(value);
  return url.hostname === 'www.xiaohongshu.com' ? url.pathname.match(/^\/(?:explore|search_result)\/([a-f0-9]+)\/?$/i)?.[1] ?? null : null;
};
const isHome = () => isXhs() && /^\/(?:explore)?\/?$/.test(location.pathname);

function demandCardDetails(card: Element, link: HTMLAnchorElement) {
  const titleLink = card.querySelector<HTMLAnchorElement>('a.title[href]');
  const title = compact(titleLink?.textContent || link.getAttribute('title') || link.textContent || '').slice(0, 300);
  // Card metadata (author, likes) is not post text and must not be sent as a summary.
  const summary = card.querySelector('[data-result-snippet], .note-desc, .note-summary, [class*="note-desc"], [class*="note-summary"]');
  const snippet = compact(summary?.textContent ?? '').replace(title, '').trim().slice(0, 500);
  const dateText = compact(card.querySelector('.date, .publish-time, [class*="publish-time"]')?.textContent ?? '');
  const publishedRaw = /20\d{2}[-/.年]\d{1,2}|\d+\s*(?:分钟|小时|天)前/.test(dateText) ? dateText.slice(0, 100) : null;
  return { url: titleLink?.href ?? link.href, title, snippet, publishedRaw };
}

function readDemandResults() {
  const blocked = platformRestriction(document, location.href);
  if (blocked) return { ok: false, reason: blocked };
  if (isXhs() && /^\/search_result(?:_ai)?\/?$/.test(location.pathname)) return readSearchResults();
  if (!isHome()) return { ok: false, reason: 'not_xhs_home_or_search' };
  if (/安全验证|滑块验证|请完成验证|请输入验证码/.test(document.body.innerText)) return { ok: false, reason: 'security_challenge' };
  const seen = new Set<string>();
  const results = orderedCardLinks(document, visible).flatMap(link => {
    const id = xhsNoteIdFromUrl(link.href);
    if (!id || seen.has(id)) return [];
    const card = link.closest('section.note-item,section,article,[class*="note-item"],[class*="feed-card"]') ?? link;
    const details = demandCardDetails(card, link);
    const { title } = details;
    if (!title) return [];
    seen.add(id);
    return [{ noteId: `xhs:${id}`, ...details }];
  });
  return results.length ? { ok: true, sourceUrl: location.href, results } : { ok: false, reason: 'home_structure_unverified' };
}

async function scrollDemand(source: 'home' | 'search', expectedKeyword: string | null) {
  if (source === 'home' && !isHome()) return { ok: false, reason: 'home_tab_changed' };
  if (source === 'search' && (!expectedKeyword || !isSearchList(location.href, expectedKeyword))) return { ok: false, reason: 'search_tab_or_keyword_changed' };
  const first = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/explore/"],a[href*="/search_result/"]')].find(link => visible(link) && xhsNoteIdFromUrl(link.href));
  if (!first) return { ok: false, reason: 'feed_structure_unverified' };
  let target: Element | null = first.parentElement;
  while (target && target !== document.body) {
    const style = getComputedStyle(target);
    if (/auto|scroll/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 100) break;
    target = target.parentElement;
  }
  const scroller = (target && target !== document.body ? target : document.scrollingElement) as HTMLElement | null;
  if (!scroller) return { ok: false, reason: 'scroll_container_unavailable' };
  const before = scroller.scrollTop;
  scroller.scrollBy({ top: Math.max(450, Math.floor(window.innerHeight * 0.8)), behavior: 'auto' });
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (!isTaskList(location.href, expectedKeyword ?? '', source)) return { ok: false, reason: 'task_list_changed_during_scroll' };
  return { ...readDemandResults(), scrollMoved: scroller.scrollTop > before };
}

function readSearchResults() {
  const blocked = platformRestriction(document, location.href);
  if (blocked) return { ok: false, reason: blocked };
  if (isFixture()) {
    const cards = [...document.querySelectorAll<HTMLElement>('[data-search-result]')].filter(visible);
    return { ok: true, sourceUrl: location.href, results: cards.map(card => {
      const link = card.querySelector<HTMLAnchorElement>('a[href]');
      const url = link ? new URL(link.href, location.href).href : '';
      return { noteId: card.dataset.noteId ?? '', url, title: compact(card.querySelector('[data-result-title]')?.textContent ?? ''), snippet: compact(card.querySelector('[data-result-snippet]')?.textContent ?? ''), publishedRaw: null };
    }).filter(item => item.noteId && item.url && item.title).slice(0, 30) };
  }
  if (!isXhs() || !/^\/search_result(?:_ai)?\/?$/.test(location.pathname)) return { ok: false, reason: 'not_a_supported_search_page' };
  const seen = new Set<string>();
  const results = orderedCardLinks(document, visible).flatMap(link => {
    const url = new URL(link.href, location.href);
    const id = xhsNoteIdFromUrl(url.href);
    const card = link.closest('section,article,[class*="note-item"],[class*="feed-card"]') ?? link;
    const details = demandCardDetails(card, link);
    const { title } = details;
    if (!id || !title || seen.has(id)) return [];
    seen.add(id);
    return [{ noteId: `xhs:${id}`, ...details }];
  });
  return results.length ? { ok: true, sourceUrl: location.href, results } : { ok: false, reason: 'search_structure_unverified' };
}

async function scrollSearch(expectedKeyword: string) {
  if (!isSearchList(location.href, expectedKeyword)) return { ok: false, reason: 'search_tab_or_keyword_changed' };
  const firstCard = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/search_result/"],a[href*="/explore/"]')].find(link => visible(link) && xhsNoteIdFromUrl(link.href));
  if (!firstCard) return { ok: false, reason: 'search_structure_unverified' };
  let target: Element | null = firstCard.parentElement;
  while (target && target !== document.body) {
    const style = getComputedStyle(target);
    if (/auto|scroll/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 100) break;
    target = target.parentElement;
  }
  const scroller = (target && target !== document.body ? target : document.scrollingElement) as HTMLElement | null;
  if (!scroller) return { ok: false, reason: 'search_scroll_container_unavailable' };
  const before = scroller.scrollTop;
  scroller.scrollBy({ top: Math.max(450, Math.floor(window.innerHeight * 0.8)), behavior: 'auto' });
  await new Promise(resolve => setTimeout(resolve, 1200));
  return { ...readSearchResults(), scrollMoved: scroller.scrollTop > before };
}

function readNote() {
  const blocked = platformRestriction(document, location.href);
  if (blocked) return { ok: false, reason: blocked };
  if (isFixture()) {
    const title = compact(document.querySelector('[data-yuezhuang-note-title]')?.textContent ?? '');
    const body = compact(document.querySelector('[data-yuezhuang-note-body]')?.textContent ?? '');
    const id = document.querySelector<HTMLElement>('[data-note-id]')?.dataset.noteId ?? `fixture:${location.pathname}`;
    return title && body ? { ok: true, note: { id, title, body, source: 'fixture', capturedAt: new Date().toISOString(), completeness: 'complete' } } : { ok: false, reason: 'fixture_note_unavailable' };
  }
  if (!isXhs()) return { ok: false, reason: 'unsupported_page' };
  if (/安全验证|滑块验证|请完成验证|请输入验证码/.test(document.body.innerText)) return { ok: false, reason: 'security_challenge' };
  const id = location.pathname.match(/^\/(?:explore|search_result)\/([^/?#]+)/)?.[1];
  if (!id) return { ok: false, reason: 'not_a_single_note' };
  const root = mainNoteRoot(document, visible);
  if (!root) return { ok: false, reason: 'note_structure_unverified' };
  const titles = [...root.querySelectorAll('h1')].filter(element => visible(element) && !element.closest('.comment-item,.comments-container,#comment-list,.recommend-container,[data-recommendation]'));
  const title = titles.length === 1 ? compact(titles[0].textContent ?? '') : '';
  const verifiedBody = root.querySelector('#detail-desc');
  const bodyElement = [verifiedBody, root.querySelector('[class*="note-content"]'), root.querySelector('article')].find((item): item is Element => Boolean(item && visible(item) && compact(item.textContent ?? '').length >= (item === verifiedBody ? 4 : 20)));
  const body = compact(bodyElement?.textContent ?? '');
  const { commentArea, commentItems, commentsReady } = commentCoverage();
  const comments = [commentArea, ...commentItems].filter((element): element is HTMLElement => Boolean(element)).map(element => compact(element.textContent ?? ''));
  const resolved = resolutionEvidence([`${title} ${body}`, ...comments]);
  const completeness = textIsComplete(title, body, bodyElement === verifiedBody && Boolean(verifiedBody) && commentsReady) ? 'complete' : 'partial';
  const author = inspectNoteAuthor(document, visible);
  const publishedRaw = compact(root?.querySelector('.bottom-container .date,.note-date,.publish-date')?.textContent ?? '').slice(0, 100) || null;
  return title && body ? { ok: true, note: { id: `xhs:${id}`, title, body: body.slice(0, 10_000), source: 'xhs', capturedAt: new Date().toISOString(), completeness, resolutionEvidence: resolved, authorName: author?.authorName ?? null, publishedRaw } } : { ok: false, reason: 'note_structure_unverified' };
}

function commentCoverage() {
  const commentArea = [...document.querySelectorAll<HTMLElement>('#comment-list, [class*="comments-container"], [class*="comment-list"], [class*="commentList"]')].find(visible);
  const commentItems = [...document.querySelectorAll<HTMLElement>('[class*="comment-item"], [class*="commentItem"]')].filter(element => visible(element) && Boolean(compact(element.textContent ?? '')));
  const declaredMatch = commentArea?.textContent?.match(/共\s*(\d+)\s*条评论/);
  const declaredComments = declaredMatch ? Number(declaredMatch[1]) : null;
  const collapsedReplies = /展开\s*\d+\s*条回复|查看更多评论|加载更多/.test(commentArea?.textContent ?? '');
  const commentsReady = visibleCommentsReady(Boolean(commentArea), declaredComments, commentItems.length);
  const allCommentsLoaded = commentsFullyLoaded(declaredComments, commentItems.length, collapsedReplies);
  return { commentArea, commentItems, declaredComments, collapsedReplies, commentsReady, allCommentsLoaded };
}

function commentDiagnostic() {
  if (!isXhs() || !/^\/(?:explore|search_result)\//.test(location.pathname)) return { ok: false, reason: 'not_a_single_xhs_note' };
  const inputs = [...document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible);
  const note = readNote();
  const coverage = commentCoverage();
  return { ok: true, count: inputs.length, completeness: note.ok ? note.note?.completeness : null, resolutionEvidence: note.ok ? note.note?.resolutionEvidence : null, loadedComments: coverage.commentItems.length, declaredComments: coverage.declaredComments, collapsedReplies: coverage.collapsedReplies, commentsReady: coverage.commentsReady, allCommentsLoaded: coverage.allCommentsLoaded, inputs: inputs.slice(0, 10).map(element => ({
    tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? '',
    className: String(element.className).slice(0, 160), placeholder: element.getAttribute('placeholder') ?? '',
    dataPlaceholder: element.getAttribute('data-placeholder') ?? '', ariaLabel: element.getAttribute('aria-label') ?? '',
    parentClassName: String(element.parentElement?.className ?? '').slice(0, 160)
  })) };
}

function commentInput(): HTMLElement | null {
  const targets = isFixture()
    ? [...document.querySelectorAll<HTMLElement>('[data-yuezhuang-comment-input]')]
    : [...(mainNoteRoot(document, visible)?.querySelectorAll<HTMLElement>('p.content-input[contenteditable="true"],textarea,[contenteditable="true"]') ?? [])]
      .filter(element => visible(element) && !element.closest('.comment-item,.commentItem,.reply-container,.reply-item,[data-comment-reply],.recommend-container,[data-recommendation]') && (element.matches('p.content-input') || /评论|comment/i.test(`${element.getAttribute('placeholder') ?? ''} ${element.getAttribute('aria-label') ?? ''}`)));
  return targets.length === 1 ? targets[0] : null;
}

function fill(expectedNoteId: string, expectedTitle: string, expectedBody: string, text: string) {
  const result = readNote();
  if (!result.ok || !result.note || result.note.id !== expectedNoteId) return { ok: false, reason: 'target_note_mismatch' };
  if (result.note.title !== expectedTitle || result.note.body !== expectedBody) return { ok: false, reason: 'note_content_changed' };
  if (result.note.resolutionEvidence) return { ok: false, reason: 'request_already_resolved' };
  if (result.note.completeness !== 'complete') return { ok: false, reason: 'note_not_text_complete' };
  if (!text.trim() || text.length > 500) return { ok: false, reason: 'invalid_draft' };
  const target = commentInput();
  if (!target) return { ok: false, reason: 'comment_input_not_unique' };
  if (target.matches('[readonly],[disabled]')) return { ok: false, reason: 'comment_input_disabled' };
  const existing = target instanceof HTMLTextAreaElement ? target.value : compact(target.textContent ?? '');
  if (existing) return { ok: false, reason: 'comment_input_not_empty' };
  target.focus();
  if (target instanceof HTMLTextAreaElement) {
    target.value = text;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } else {
    document.execCommand('insertText', false, text);
    if (compact(target.textContent ?? '') !== text) {
      target.textContent = text;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  return { ok: (target instanceof HTMLTextAreaElement ? target.value : target.textContent) === text, adapter: isFixture() ? 'fixture' : 'xhs_experimental' };
}

async function publish(expectedNoteId: string, expectedTitle: string, expectedBody: string, text: string) {
  const invalid = validateFollowNote(expectedNoteId, expectedTitle, expectedBody);
  if (invalid) return { ok: false, reason: invalid, ambiguous: false };
  if (!text.trim() || text.length > 500) return { ok: false, reason: 'invalid_draft', ambiguous: false };
  const existing = inspectPublication(document, visible, text);
  if (!existing.ok) return { ...existing, ambiguous: false };
  if (existing.published) return { ...existing, alreadyPublished: true, ambiguous: false };
  const receipt = capturePublicationReceipt(document, visible, text);
  if (!receipt) return { ok: false, reason: 'comment_sender_identity_unverified', ambiguous: false };
  const result = fill(expectedNoteId, expectedTitle, expectedBody, text);
  if (!result.ok) return { ...result, senderId: receipt.senderId, ambiguous: false };
  let sendButtons: HTMLButtonElement[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const blocked = platformRestriction(document, location.href);
    if (blocked) return { ok: false, reason: blocked, ambiguous: false };
    sendButtons = [...(mainNoteRoot(document, visible)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(button => visible(button) && !button.closest('.comment-item,.commentItem,.reply-container,.reply-item,[data-comment-reply],.recommend-container,[data-recommendation]') && compact(button.textContent ?? '') === '发送' && !button.disabled);
    if (sendButtons.length) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (sendButtons.length !== 1) return { ok: false, reason: 'send_button_not_unique_or_disabled', ambiguous: false };
  const beforeSend = validateFollowNote(expectedNoteId, expectedTitle, expectedBody);
  if (beforeSend) return { ok: false, reason: beforeSend, ambiguous: false };
  const senderCheck = inspectPublication(document, visible, text, receipt.senderId);
  if (!senderCheck.ok) return { ...senderCheck, ambiguous: false };
  if (senderCheck.published) return { ...senderCheck, alreadyPublished: true, ambiguous: false };
  sendButtons[0].click();
  return waitForPublication(document, visible, receipt, () => validatePublicationNote(expectedNoteId, expectedTitle, expectedBody));
}

// After the send click, comment rerenders must not re-run the pre-send eligibility gate.
// Still verify the original post, account, context and platform status on every observation.
function validatePublicationNote(expectedNoteId: string, expectedTitle: string, expectedBody: string): string | null {
  const blocked = platformRestriction(document, location.href); if (blocked) return blocked;
  if (!isXhs() || `xhs:${xhsNoteIdFromUrl(location.href)}` !== expectedNoteId) return 'target_note_mismatch';
  const note = readNote();
  if (!note.ok || !note.note) return note.reason ?? 'note_structure_unverified';
  return note.note.title === expectedTitle && note.note.body === expectedBody ? null : 'note_content_changed';
}

async function likeNote(expectedNoteId: string, expectedTitle: string, expectedBody: string) {
  return likeMainNote(document, visible, () => validateFollowNote(expectedNoteId, expectedTitle, expectedBody));
}
function likeState(expectedNoteId: string, expectedTitle: string, expectedBody: string) {
  const invalid = validateFollowNote(expectedNoteId, expectedTitle, expectedBody);
  if (invalid) return { ok: false, reason: invalid };
  const target = inspectNoteLike(document, visible);
  return target.ok ? { ok: true, liked: target.liked } : target;
}

function validateFollowNote(expectedNoteId: string, expectedTitle: string, expectedBody: string): string | null {
  if (!isXhs() || !/^\/(?:explore|search_result)\/[a-f0-9]+\/?$/i.test(location.pathname)) return 'not_a_single_xhs_note';
  const result = readNote();
  if (!result.ok || !result.note) return result.reason ?? 'note_structure_unverified';
  if (result.note.id !== expectedNoteId) return 'target_note_mismatch';
  if (result.note.title !== expectedTitle || result.note.body !== expectedBody) return 'note_content_changed';
  if (result.note.resolutionEvidence || result.note.completeness !== 'complete') return 'note_no_longer_eligible';
  return null;
}
function authorFollowState(expectedNoteId: string, expectedTitle: string, expectedBody: string) {
  const invalid = validateFollowNote(expectedNoteId, expectedTitle, expectedBody);
  if (invalid) return { ok: false, reason: invalid };
  const target = inspectAuthorFollow(document, visible);
  return target.ok ? { ok: true, ...target.state } : target;
}

const handleMessage = (message: (Message | { type: 'ASSISTANT_CONTENT_STATUS' }) & { connectionVersion?: string; connectionInstance?: string }, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  const blocked = platformRestriction(document, location.href);
  if (message.type === 'ASSISTANT_CONTENT_STATUS') return sendResponse({ ok: !blocked, reason: blocked ?? undefined, version: contentVersion, instance: contentInstance, sourceUrl: location.href });
  if ((message.connectionVersion && message.connectionVersion !== contentVersion) || (message.connectionInstance && message.connectionInstance !== contentInstance)) return sendResponse({ ok: false, reason: 'page_connection_changed_before_action', ambiguous: false });
  if (blocked) return sendResponse({ ok: false, reason: blocked, ambiguous: false });
  if (message.type === 'ASSISTANT_PAGE_GUARD') return sendResponse({ ok: true, sourceUrl: location.href });
  if (message.type === 'ASSISTANT_UI_SEARCH') { void searchInPage(document, visible, message.keyword, navigationContext()).then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error) })); return true; }
  if (message.type === 'ASSISTANT_OPEN_NOTE') {
    const source = message.expectedSource ?? 'search';
    if (pageSession && isTaskList(location.href, pageSession.keyword, pageSession.source) && !hasOpenNoteDetail(document, visible)) pageSession = null;
    if (pageSession) return sendResponse({ ok: false, reason: 'previous_detail_not_closed', ambiguous: false });
    if (!isTaskList(location.href, message.expectedKeyword, source)) return sendResponse({ ok: false, reason: source === 'home' ? 'home_tab_changed' : 'search_tab_or_keyword_changed', ambiguous: false });
    pageSession = { noteId: message.expectedNoteId, keyword: message.expectedKeyword, source };
    void openNoteInPage(document, visible, message.expectedKeyword, message.expectedNoteId, navigationContext(), source).then(result => { if (!result.ok && !result.ambiguous) pageSession = null; sendResponse(result); }).catch(error => sendResponse({ ok: false, reason: String(error), ambiguous: true })); return true;
  }
  if (message.type === 'ASSISTANT_CLOSE_NOTE') {
    if (!pageSession || pageSession.noteId !== message.expectedNoteId || pageSession.keyword !== message.expectedKeyword || pageSession.source !== (message.expectedSource ?? 'search')) return sendResponse({ ok: false, reason: 'detail_not_owned_by_this_task' });
    void closeNoteInPage(document, visible, message.expectedKeyword, message.expectedNoteId, navigationContext(), pageSession.source).then(result => { if (result.ok) pageSession = null; sendResponse(result); }).catch(error => sendResponse({ ok: false, reason: String(error) })); return true;
  }
  if (message.type === 'ASSISTANT_FEED_RESULTS' || message.type === 'ASSISTANT_SCROLL_FEED') {
    if (pageSession && isTaskList(location.href, pageSession.keyword, pageSession.source) && !hasOpenNoteDetail(document, visible)) pageSession = null;
    if (pageSession || !isTaskList(location.href, message.expectedKeyword, message.source) || hasOpenNoteDetail(document, visible)) return sendResponse({ ok: false, reason: 'task_list_changed_or_detail_open' });
    if (message.type === 'ASSISTANT_FEED_RESULTS') return sendResponse(message.source === 'home' ? readDemandResults() : readSearchResults());
    void (message.source === 'home' ? scrollDemand('home', null) : scrollSearch(message.expectedKeyword)).then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error) })); return true;
  }
  if (message.type === 'DEMAND_PAGE_RESULTS') return sendResponse(readDemandResults());
  if (message.type === 'DEMAND_SCROLL') { void scrollDemand(message.source, message.expectedKeyword).then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error) })); return true; }
  if (message.type === 'ASSISTANT_SEARCH_RESULTS') return sendResponse(readSearchResults());
  if (message.type === 'ASSISTANT_SCROLL_SEARCH') { void scrollSearch(message.expectedKeyword).then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error) })); return true; }
  if (message.type === 'ASSISTANT_READ_NOTE') return sendResponse(readNote());
  if (message.type === 'ASSISTANT_COMMENT_DIAGNOSTIC') return sendResponse(commentDiagnostic());
  if (message.type === 'ASSISTANT_FILL') return sendResponse(fill(message.expectedNoteId, message.expectedTitle, message.expectedBody, message.text));
  if (message.type === 'ASSISTANT_PUBLISH') { void publish(message.expectedNoteId, message.expectedTitle, message.expectedBody, message.text).then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error), ambiguous: true })); return true; }
  if (message.type === 'ASSISTANT_PUBLICATION_STATE') {
    const invalid = validatePublicationNote(message.expectedNoteId, message.expectedTitle, message.expectedBody);
    return sendResponse(invalid ? { ok: false, reason: invalid } : inspectPublication(document, visible, message.text, message.expectedSenderId));
  }
  if (message.type === 'ASSISTANT_LIKE') { void likeNote(message.expectedNoteId, message.expectedTitle, message.expectedBody).then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error), ambiguous: true })); return true; }
  if (message.type === 'ASSISTANT_LIKE_STATE') return sendResponse(likeState(message.expectedNoteId, message.expectedTitle, message.expectedBody));
  if (message.type === 'ASSISTANT_AUTHOR_FOLLOW_STATE') return sendResponse(authorFollowState(message.expectedNoteId, message.expectedTitle, message.expectedBody));
  if (message.type === 'ASSISTANT_FOLLOW') {
    void followAuthor(document, visible, message.expectedAuthorId, () => validateFollowNote(message.expectedNoteId, message.expectedTitle, message.expectedBody))
      .then(sendResponse).catch(error => sendResponse({ ok: false, reason: String(error), ambiguous: true }));
    return true;
  }
};
const pageGlobal = globalThis as typeof globalThis & { __yuezhuangContent?: { version: string; alive: () => boolean; retire: () => void } };
// Re-injection is idempotent: retain a current listener/session, retire only an older build.
if (pageGlobal.__yuezhuangContent?.version !== contentVersion || !pageGlobal.__yuezhuangContent.alive()) {
  pageGlobal.__yuezhuangContent?.retire();
  pageGlobal.__yuezhuangContent = { version: contentVersion, alive: () => {
    try { return runtimeAtLoad.getManifest().version === contentVersion; } catch { return false; }
  }, retire: () => {
    activeContext = false;
    try { chrome.runtime.onMessage.removeListener(handleMessage); } catch { /* Old extension contexts may already be invalid. */ }
  } };
  chrome.runtime.onMessage.addListener(handleMessage);
}
