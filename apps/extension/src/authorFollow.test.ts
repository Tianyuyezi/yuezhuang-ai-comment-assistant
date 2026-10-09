import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { authorIdFromProfileUrl, followAuthor, inspectAuthorFollow, inspectNoteAuthor } from './authorFollow';

const author = '6ab7d5ab000000001b02ce03';
const other = '6ab7d5ab000000001b02ce04';
const visible = (element: Element) => !element.closest('[hidden],[aria-hidden="true"]');
const wait = async () => {};
function page(label = '关注') {
  return new JSDOM(`<div class="note-container"><div class="author-container"><a href="https://www.xiaohongshu.com/user/profile/${author}">原帖作者</a><button class="follow-btn">${label}</button></div><h1>上海求租</h1><div class="comments-container"><div class="comment-item author-container"><a href="/user/profile/${other}">评论者</a><button>关注</button></div></div></div><div data-recommendation class="author-container"><a href="/user/profile/${other}">推荐用户</a><button>关注</button></div>`, { url: 'https://www.xiaohongshu.com/explore/6ab7d5ab000000001b02ce05' }).window.document;
}
describe('main-author follow adapter', () => {
  it('reads only the main author name even without a follow button', () => {
    const document = page(); document.querySelector('.follow-btn')!.remove();
    document.querySelector('.note-container > .author-container a')!.textContent = '上海美妆老师';
    expect(inspectNoteAuthor(document, visible)).toMatchObject({ authorId: author, authorName: '上海美妆老师' });
    document.querySelector('.note-container > .author-container')!.remove();
    expect(inspectNoteAuthor(document, visible)).toBeNull();
  });
  it('accepts only canonical Xiaohongshu profile identities', () => {
    expect(authorIdFromProfileUrl(`/user/profile/${author}?xsec_token=example`)).toBe(author);
    expect(authorIdFromProfileUrl(`https://example.test/user/profile/${author}`)).toBeNull();
    expect(authorIdFromProfileUrl(`http://www.xiaohongshu.com/user/profile/${author}`)).toBeNull();
    expect(authorIdFromProfileUrl('/user/profile/not-an-id')).toBeNull();
  });
  it('follows only the main author and confirms the changed state without touching other users', async () => {
    const document = page('+ 关注');
    const main = document.querySelector<HTMLButtonElement>('.note-container > .author-container button')!;
    const clicked = vi.fn(() => { main.textContent = '已关注'; }); main.onclick = clicked;
    const otherClicks = vi.fn(); document.querySelectorAll<HTMLButtonElement>('.comment-item button,[data-recommendation] button').forEach(button => { button.onclick = otherClicks; });
    expect(inspectAuthorFollow(document, visible)).toMatchObject({ ok: true, state: { authorId: author, following: false, authorName: '原帖作者' } });
    expect(await followAuthor(document, visible, author, () => null, wait)).toMatchObject({ ok: true, authorId: author, alreadyFollowing: false, followed: true });
    expect(clicked).toHaveBeenCalledTimes(1); expect(otherClicks).not.toHaveBeenCalled();
  });
  it.each(['已关注', '互相关注', '相互关注'])('never clicks an already-following control: %s', async label => {
    const document = page(label); const clicked = vi.fn();
    document.querySelector<HTMLButtonElement>('.follow-btn')!.onclick = clicked;
    expect(await followAuthor(document, visible, author, () => null, wait)).toMatchObject({ ok: true, alreadyFollowing: true });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('blocks a changed author, changed note, disabled control and ambiguous author identities before clicking', async () => {
    const document = page(); const clicked = vi.fn();
    const button = document.querySelector<HTMLButtonElement>('.follow-btn')!; button.onclick = clicked;
    expect(await followAuthor(document, visible, other, () => null, wait)).toMatchObject({ ok: false, ambiguous: false });
    expect(await followAuthor(document, visible, author, () => 'note_content_changed', wait)).toMatchObject({ ok: false, ambiguous: false });
    button.disabled = true;
    expect(inspectAuthorFollow(document, visible)).toMatchObject({ ok: false, reason: 'main_author_follow_disabled' });
    button.disabled = false;
    document.querySelector('.note-container > .author-container')!.insertAdjacentHTML('beforeend', `<a href="/user/profile/${other}">另一用户</a>`);
    expect(inspectAuthorFollow(document, visible)).toMatchObject({ ok: false, reason: 'main_author_identity_not_unique' });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('does not treat recommendation controls or an unverified detail scope as the author', () => {
    const document = page(); document.querySelector('.note-container > .author-container')!.remove();
    expect(inspectAuthorFollow(document, visible).ok).toBe(false);
    document.querySelector('.note-container')!.className = 'unverified';
    expect(inspectAuthorFollow(document, visible)).toMatchObject({ ok: false, reason: 'main_note_author_scope_unverified' });
  });
  it('clicks once and returns unknown if the follow state never changes', async () => {
    const document = page(); const clicked = vi.fn(); document.querySelector<HTMLButtonElement>('.follow-btn')!.onclick = clicked;
    expect(await followAuthor(document, visible, author, () => null, wait)).toMatchObject({ ok: false, ambiguous: true, reason: 'follow_clicked_but_state_unverified' });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('returns ambiguous if the note or author changes after the click', async () => {
    const document = page(); let changed = false;
    document.querySelector<HTMLButtonElement>('.follow-btn')!.onclick = () => { changed = true; };
    expect(await followAuthor(document, visible, author, () => changed ? 'target_note_mismatch' : null, wait)).toMatchObject({ ok: false, ambiguous: true });
  });
});
