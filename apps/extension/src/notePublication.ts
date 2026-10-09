import { mainNoteRoot } from './listNavigation';
import { authorIdFromProfileUrl } from './authorFollow';

const normalized = (value: string) => value.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g, '');
const excluded = '.reply-container,.reply-item,.comment-reply,[data-comment-reply],.recommend-container,[data-recommendation]';
export type PublicationReceipt = { senderId: string; baseline: string[]; text: string };
type ObservedComment = { text: string; authorId: string; commentId: string | null; key: string };
export type PublicationObservation = {
  ok: boolean; published: boolean; reason?: string; senderId?: string; commentId?: string;
  diagnostic: { commentAreas: number; visibleRows: number; exactTextRows: number; ownTextRows: number; inputCleared: boolean; successHint: boolean };
};

export function currentCommentSender(document: Document, visible: (element: Element) => boolean): string | null {
  const ids = new Set<string>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a[href*="/user/profile/"],aside a[href*="/user/profile/"],[role="navigation"] a[href*="/user/profile/"],.side-bar a[href*="/user/profile/"],.sidebar a[href*="/user/profile/"],.channel-list a[href*="/user/profile/"]')) {
    if (!visible(link) || link.closest('#noteContainer,.note-container,.note-detail-container,.note-detail,section.note-item,[data-recommendation]')) continue;
    const id = authorIdFromProfileUrl(link.href); if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function observedComments(document: Document, visible: (element: Element) => boolean) {
  const root = mainNoteRoot(document, visible);
  const areas = root ? [...root.querySelectorAll('#comment-list,.comments-container,[class*="comment-list"],[class*="commentList"]')].filter(element => visible(element) && !element.closest(excluded)) : [];
  const rows = new Set<Element>();
  for (const area of areas) for (const row of area.querySelectorAll('.comment-item,.commentItem,[data-comment-id]')) {
    if (visible(row) && !row.closest(excluded) && !row.closest('.pending,.sending,[data-state="pending"],[data-status="sending"]')) rows.add(row);
  }
  const comments: ObservedComment[] = [];
  for (const row of rows) {
    const owns = (element: Element) => element.closest('.comment-item,.commentItem,[data-comment-id]') === row && !element.closest(excluded);
    const texts = [...row.querySelectorAll('[data-comment-content],.comment-content,.comment-text,.content,.note-text')].filter(element => visible(element) && owns(element));
    const leaves = texts.filter(element => !texts.some(other => other !== element && element.contains(other)));
    const authors = new Set([...row.querySelectorAll<HTMLAnchorElement>('a[href*="/user/profile/"]')].filter(link => visible(link) && owns(link)).map(link => authorIdFromProfileUrl(link.href)).filter((id): id is string => Boolean(id)));
    if (leaves.length !== 1 || authors.size !== 1) continue;
    const text = normalized(leaves[0].textContent ?? ''); const authorId = [...authors][0];
    if (!text) continue;
    const rawId = row.getAttribute('data-comment-id') || row.getAttribute('data-id') || row.id;
    const commentId = rawId.match(/^(?:comment[-_])?([a-f0-9]{24})$/i)?.[1].toLowerCase() ?? null;
    comments.push({ text, authorId, commentId, key: commentId ? `id:${commentId}` : `text:${authorId}:${text}` });
  }
  const inputs = root ? [...root.querySelectorAll<HTMLElement>('p.content-input[contenteditable="true"],textarea,[contenteditable="true"]')].filter(element => visible(element) && !element.closest('.comment-item,.commentItem,.reply-container,[data-recommendation]') && (element.matches('p.content-input') || /评论|comment/i.test(`${element.getAttribute('placeholder') ?? ''} ${element.getAttribute('aria-label') ?? ''}`))) : [];
  const inputCleared = inputs.length === 1 && !normalized(inputs[0].tagName === 'TEXTAREA' ? (inputs[0] as HTMLTextAreaElement).value : inputs[0].textContent ?? '');
  const successHint = [...document.querySelectorAll('.toast,.message-notification,[role="status"]')].some(element => visible(element) && /^(评论成功|评论发布成功|评论已发送|发送成功)[！!。.]?$/.test((element.textContent ?? '').trim()));
  return { comments, commentAreas: areas.length, visibleRows: rows.size, inputCleared, successHint };
}

export function capturePublicationReceipt(document: Document, visible: (element: Element) => boolean, text: string): PublicationReceipt | null {
  const senderId = currentCommentSender(document, visible);
  return senderId ? { senderId, text, baseline: observedComments(document, visible).comments.map(item => item.key) } : null;
}

// Read-only proof. Counts, a cleared editor or a success toast alone are never enough.
export function inspectPublication(document: Document, visible: (element: Element) => boolean, text: string, expectedSenderId?: string, baseline?: string[]): PublicationObservation {
  const observed = observedComments(document, visible); const senderId = currentCommentSender(document, visible);
  const exact = observed.comments.filter(item => item.text === normalized(text));
  const own = senderId ? exact.filter(item => item.authorId === senderId) : [];
  const diagnostic = { commentAreas: observed.commentAreas, visibleRows: observed.visibleRows, exactTextRows: exact.length, ownTextRows: own.length, inputCleared: observed.inputCleared, successHint: observed.successHint };
  if (!senderId) return { ok: false, published: false, reason: 'comment_sender_identity_unverified', diagnostic };
  if (expectedSenderId && senderId !== expectedSenderId) return { ok: false, published: false, reason: 'comment_sender_changed', senderId, diagnostic };
  // A stable, new own-comment ID is independent of the editor retaining its text.
  // Without an ID, retain the stricter cleared-editor + explicit-success requirement.
  const match = own.find(item => (!baseline || !baseline.includes(item.key)) &&
    (!baseline || item.commentId || (observed.inputCleared && observed.successHint)));
  return { ok: true, published: Boolean(match), senderId, commentId: match?.commentId ?? undefined, diagnostic };
}

export async function waitForPublication(document: Document, visible: (element: Element) => boolean, receipt: PublicationReceipt,
  validate: () => string | null, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let confirmations = 0; let lastKey = ''; let observed: PublicationObservation | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    await wait(500);
    const invalid = validate(); if (invalid) return { ok: false, reason: invalid, ambiguous: true, senderId: receipt.senderId };
    observed = inspectPublication(document, visible, receipt.text, receipt.senderId, receipt.baseline);
    if (!observed.ok) return { ...observed, senderId: receipt.senderId, ambiguous: true };
    const key = `${observed.senderId}:${observed.commentId ?? normalized(receipt.text)}`;
    confirmations = observed.published ? key === lastKey ? confirmations + 1 : 1 : 0; lastKey = key;
    if (confirmations >= 2) return { ...observed, ok: true, published: true, ambiguous: false };
  }
  return { ...observed, ok: false, published: false, reason: 'send_clicked_but_publication_unverified', ambiguous: true, senderId: receipt.senderId };
}
