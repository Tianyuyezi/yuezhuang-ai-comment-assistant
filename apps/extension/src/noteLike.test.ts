import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { inspectNoteLike, likeMainNote } from './noteLike';

const visible = (element: Element) => !element.closest('[hidden],[aria-hidden="true"]');
const wait = async () => {};
const controlHtml = (icon = '#like_b') => `<div class="engage-bar"><div class="buttons"><div class="left"><button class="like-wrapper"><svg><use href="${icon}"></use></svg><span>25</span></button></div></div></div>`;
function page(icon = '#like_b') {
  return new JSDOM(`<div class="note-container"><h1>上海求租</h1>${controlHtml(icon)}<div id="comment-list">${controlHtml()}</div></div><div data-recommendation>${controlHtml()}</div>`).window.document;
}
const main = (document: Document) => document.querySelector<HTMLButtonElement>('.note-container > .engage-bar .like-wrapper')!;

describe('main-note like confirmation', () => {
  it('reproduces and fixes a framework replacing the button after clicking', async () => {
    const document = page();
    const old = main(document);
    const clicked = vi.fn(() => { old.outerHTML = '<button class="like-wrapper"><svg><use href="#liked_b"></use></svg>26</button>'; });
    old.onclick = clicked;
    const others = vi.fn(); document.querySelectorAll<HTMLButtonElement>('#comment-list button,[data-recommendation] button').forEach(button => { button.onclick = others; });
    expect(await likeMainNote(document, visible, () => null, wait)).toEqual({ ok: true, liked: true, alreadyLiked: false });
    expect(old.isConnected).toBe(false); expect(old.querySelector('use')!.getAttribute('href')).toBe('#like_b');
    expect(clicked).toHaveBeenCalledTimes(1); expect(others).not.toHaveBeenCalled();
  });
  it('waits for a slow update beyond the old three-second timeout', async () => {
    const document = page(); const clicked = vi.fn(); main(document).onclick = clicked;
    let elapsed = 0;
    const wait = async (ms: number) => { elapsed += ms; if (elapsed >= 4000) main(document).setAttribute('aria-pressed', 'true'); };
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: true, alreadyLiked: false });
    expect(elapsed).toBeGreaterThan(3000); expect(clicked).toHaveBeenCalledTimes(1);
  });
  it.each(['#liked_b', '#like_a'])('does not toggle an already liked icon: %s', async icon => {
    const document = page(icon); const clicked = vi.fn(); main(document).onclick = clicked;
    expect(await likeMainNote(document, visible, () => null, wait)).toEqual({ ok: true, liked: true, alreadyLiked: true });
    expect(clicked).not.toHaveBeenCalled();
  });
  it.each(['aria-pressed', 'data-liked'])('recognizes explicit %s state without relying on a changing SVG', async attribute => {
    const document = page(); main(document).setAttribute(attribute, 'true'); const clicked = vi.fn(); main(document).onclick = clicked;
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: true, alreadyLiked: true });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('supports namespaced SVG attributes and full sprite URLs', async () => {
    const document = page(); const use = main(document).querySelector('use')!;
    use.removeAttribute('href'); use.setAttribute('xlink:href', 'https://www.xiaohongshu.com/icons.svg#like_b');
    main(document).onclick = () => { use.setAttribute('xlink:href', '#liked_b'); };
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: true, alreadyLiked: false });
  });
  it('requires two consecutive confirmations and ignores a transient optimistic state', async () => {
    const document = page(); const clicked = vi.fn(); main(document).onclick = clicked; let check = 0;
    const wait = async () => { main(document).setAttribute('aria-pressed', String(++check === 1)); };
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: false, ambiguous: true });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('ignores changing counts, never retries the click, and returns unknown', async () => {
    const document = page(); const clicked = vi.fn(() => { main(document).querySelector('span')!.textContent = '26'; }); main(document).onclick = clicked;
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: false, ambiguous: true, reason: expect.stringContaining('like_clicked_but_state_unverified') });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('blocks unknown icons, conflicting states, disabled controls and unverified scope', async () => {
    const document = page('#like_future'); const clicked = vi.fn(); main(document).onclick = clicked;
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: false, ambiguous: false, reason: 'main_like_state_unknown' });
    main(document).setAttribute('aria-pressed', 'true'); main(document).setAttribute('data-liked', 'false');
    expect(inspectNoteLike(document, visible)).toMatchObject({ ok: false, reason: 'main_like_state_conflicting' });
    main(document).removeAttribute('data-liked'); main(document).setAttribute('aria-pressed', 'false'); main(document).disabled = true;
    expect(inspectNoteLike(document, visible)).toMatchObject({ ok: false, reason: 'main_like_control_disabled' });
    document.querySelector('.note-container')!.className = 'unknown';
    expect(inspectNoteLike(document, visible)).toMatchObject({ ok: false, reason: 'main_note_like_scope_unverified' }); expect(clicked).not.toHaveBeenCalled();
  });
  it('stops verification if the note changes or a security challenge appears after clicking', async () => {
    const document = page(); let clicked = false; main(document).onclick = () => { clicked = true; };
    expect(await likeMainNote(document, visible, () => clicked ? 'security_challenge' : null, wait)).toEqual({ ok: false, reason: 'security_challenge', ambiguous: true });
  });
  it('never toggles a filled heart when a stale attribute says unliked', async () => {
    const document = page('#liked_b'); main(document).setAttribute('aria-pressed', 'false'); const clicked = vi.fn(); main(document).onclick = clicked;
    expect(await likeMainNote(document, visible, () => null, wait)).toMatchObject({ ok: false, ambiguous: false, reason: 'main_like_state_conflicting' });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('does not interpret a generic action label as a conflicting negative state', async () => {
    const document = page(); main(document).setAttribute('aria-label', '点赞'); main(document).setAttribute('aria-pressed', 'true');
    expect(inspectNoteLike(document, visible)).toMatchObject({ ok: true, liked: true });
  });
});
