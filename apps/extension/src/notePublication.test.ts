import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { capturePublicationReceipt, currentCommentSender, inspectPublication, waitForPublication } from './notePublication';
import { publicationRecord } from './publicationResult';
import { interactionBlocksFirstContact, interactionSchema } from '@yuezhuang/shared';

const sender = '000000000000000000000001';
const other = '000000000000000000000002';
const firstId = '000000000000000000000011';
const secondId = '000000000000000000000012';
const visible = (element: Element) => !element.closest('[hidden],[aria-hidden="true"]');
const row = (author = sender, text = '求看', id = firstId) => `<div class="comment-item" ${id ? `id="comment-${id}"` : ''}><a href="/user/profile/${author}">评论作者</a><div class="content"><span class="note-text">${text}</span></div></div>`;
function page(comments = '') {
  const dom = new JSDOM(`<nav><a href="/user/profile/${sender}">我</a></nav><div class="note-container"><h1>原帖</h1><div id="detail-desc">原帖正文</div><div class="comments-container"><div id="comment-list">${comments}</div></div><textarea placeholder="评论"></textarea><button>发送</button></div>`, { url: 'https://www.xiaohongshu.com/explore/000000000000000000000003' });
  return { dom, document: dom.window.document, list: dom.window.document.querySelector('#comment-list')! };
}

describe('scoped, sender-aware comment publication proof', () => {
  it('recognizes a current-account exact comment with nested text markup', () => {
    const { document } = page(row(sender, '求<span>看</span>'));
    expect(inspectPublication(document, visible, '求看')).toMatchObject({ ok: true, published: true, senderId: sender, commentId: firstId });
  });
  it('does not treat a different author or substring as the sent comment', () => {
    const { document } = page(row(other) + row(sender, '求看一下', secondId));
    expect(inspectPublication(document, visible, '求看')).toMatchObject({ ok: true, published: false, diagnostic: { exactTextRows: 1, ownTextRows: 0 } });
  });
  it('ignores replies, recommendation comments and off-post comments', () => {
    const { document } = page(`<div class="reply-container">${row()}</div>`);
    document.body.insertAdjacentHTML('beforeend', `<div id="comment-list">${row()}</div><div data-recommendation><div class="note-container"><div id="comment-list">${row()}</div></div></div>`);
    expect(inspectPublication(document, visible, '求看')).toMatchObject({ published: false });
  });
  it('rejects old own comments when proving a new send, but can reconcile their existence read-only', () => {
    const { document } = page(row()); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(false);
    expect(inspectPublication(document, visible, '求看', sender).published).toBe(true);
  });
  it('confirms a new identifiable own row even if the editor retains the sent text', () => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    list.innerHTML = row(); document.querySelector('textarea')!.value = '求看';
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(true);
    document.querySelector('textarea')!.value = '';
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(true);
  });
  it('still requires a cleared editor and explicit success when the own row has no ID', () => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    list.innerHTML = row(sender, '求看', ''); document.querySelector('textarea')!.value = '求看';
    document.body.insertAdjacentHTML('beforeend', '<div class="toast">评论发布成功</div>');
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(false);
    document.querySelector('textarea')!.value = '';
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(true);
  });
  it('never treats a cleared editor, increased count or success toast alone as proof', () => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    list.innerHTML = `共1条评论${row(other)}`; document.body.insertAdjacentHTML('beforeend', '<div role="status">发送成功</div>');
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline)).toMatchObject({ published: false, diagnostic: { inputCleared: true, successHint: true } });
  });
  it('does not confirm an optimistic row lacking an ID without a success hint', () => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!; list.innerHTML = row(sender, '求看', '');
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(false);
    document.body.insertAdjacentHTML('beforeend', '<div class="toast">评论发布成功</div>');
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(true);
  });
  it.each(['row', 'ancestor'])('ignores pending %s even when the row has author, text and ID', pending => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    list.innerHTML = pending === 'row' ? row().replace('class="comment-item"', 'class="comment-item sending"') : `<div data-state="pending">${row()}</div>`;
    expect(inspectPublication(document, visible, '求看', sender, receipt.baseline).published).toBe(false);
  });
  it('identifies only the navigation account, not the note author', () => {
    const { document } = page(); document.querySelector('.note-container')!.insertAdjacentHTML('afterbegin', `<aside><a href="/user/profile/${other}">笔记作者</a></aside>`);
    expect(currentCommentSender(document, visible)).toBe(sender);
    document.querySelector('nav')!.remove(); expect(capturePublicationReceipt(document, visible, '求看')).toBeNull();
  });
  it('refuses conflicting own-account links or a changed logged-in account', () => {
    const { document } = page(row()); document.querySelector('nav a')!.setAttribute('href', `/user/profile/${other}`);
    expect(inspectPublication(document, visible, '求看', sender)).toMatchObject({ ok: false, published: false, reason: 'comment_sender_changed' });
    document.querySelector('nav')!.insertAdjacentHTML('beforeend', `<a href="/user/profile/${sender}">另一个我</a>`);
    expect(currentCommentSender(document, visible)).toBeNull();
  });
  it('continues past the old 8-second limit and confirms a row appearing after 12 seconds twice', async () => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!; let elapsed = 0;
    const result = await waitForPublication(document, visible, receipt, () => null, async ms => { elapsed += ms; if (elapsed === 12000) list.innerHTML = row(); });
    expect(result).toMatchObject({ ok: true, published: true, ambiguous: false }); expect(elapsed).toBe(12500);
  });
  it('does not confirm a row seen only for one observation', async () => {
    const { document, list } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!; let attempts = 0;
    const result = await waitForPublication(document, visible, receipt, () => null, async () => { attempts++; list.innerHTML = attempts === 1 ? row() : ''; });
    expect(result).toMatchObject({ ok: false, ambiguous: true, reason: 'send_clicked_but_publication_unverified' }); expect(attempts).toBe(40);
  });
  it('retains the original sender identity when the account changes after clicking send', async () => {
    const { document } = page(); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    const result = await waitForPublication(document, visible, receipt, () => null, async () => { document.querySelector('nav a')!.setAttribute('href', `/user/profile/${other}`); });
    expect(result).toMatchObject({ ok: false, reason: 'comment_sender_changed', senderId: sender, ambiguous: true });
  });
  it.each(['security_challenge', 'target_note_mismatch', 'content_context_replaced'])('stops observing on %s and preserves uncertainty', async reason => {
    const { document } = page(row()); const receipt = capturePublicationReceipt(document, visible, '求看')!;
    expect(await waitForPublication(document, visible, receipt, () => reason, async () => {})).toMatchObject({ ok: false, reason, ambiguous: true });
  });
});

describe('publication record compatibility and no-resend locks', () => {
  const old = interactionSchema.parse({ id: 'i', noteId: 'xhs:1', noteHash: 'h', accountLabel: '我', templateId: null, templateVersion: null, body: '求看', status: 'unknown', source: 'xhs', createdAt: '2026-10-05T00:00:00Z', markedPublishedAt: null });
  it('keeps an unknown record locked after an inconclusive read-only check', () => {
    const checked = publicationRecord(old, { ok: true, published: false, senderId: sender });
    expect(interactionSchema.parse(checked).publicationSenderId).toBe(sender);
    expect(interactionBlocksFirstContact([checked], old.noteId, old.accountLabel)).toBe(true);
  });
  it('releases only a positively acknowledged no-click outcome, not a transport timeout', () => {
    const noClick = publicationRecord(old, { ok: false, reason: 'send_button_not_unique_or_disabled', ambiguous: false });
    expect(noClick.status).toBe('generated'); expect(interactionBlocksFirstContact([noClick], old.noteId, old.accountLabel)).toBe(false);
    expect(publicationRecord(old, { ok: false }).status).toBe('unknown');
  });
  it('persists verified sender and comment IDs without a database version change', () => {
    const checked = publicationRecord(old, { ok: true, published: true, senderId: sender, commentId: firstId });
    expect(interactionSchema.parse(checked)).toMatchObject({ status: 'marked_published', publicationSenderId: sender, publicationCommentId: firstId });
  });
  it('cannot replace a locked original sender ID through a failed probe of a different account', () => {
    const locked = { ...old, publicationSenderId: sender };
    expect(publicationRecord(locked, { ok: false, senderId: other, reason: 'comment_sender_changed' }).publicationSenderId).toBe(sender);
  });
});
