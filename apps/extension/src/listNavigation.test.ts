import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { closeNoteInPage, hasOpenNoteDetail, isSearchList, isTaskList, openNoteInPage, searchInPage } from './listNavigation';
import { platformRestriction } from './pageSafety';

const id = '000000000000000000000001';
const keyword = '上海约妆';
const source = `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(encodeURIComponent(keyword))}&sort=time_descending`;
const visible = (element: Element) => !element.closest('[hidden],[aria-hidden="true"]');
const wait = async () => {};
function page() {
  const dom = new JSDOM(`<header><div class="search-container"><input id="search-input" placeholder="搜索小红书"><button class="search-button">搜索</button></div></header><section class="note-item"><a class="cover" href="/explore/${id}?xsec_token=example">封面</a><a class="title" href="/explore/${id}?xsec_token=example">找化妆师</a></section>`, { url: source });
  const document = dom.window.document;
  const context = { href: () => dom.window.location.href, blocked: () => platformRestriction(document, dom.window.location.href), wait };
  return { dom, document, context };
}
describe('normal same-page search and detail navigation', () => {
  it.each(['search', 'home'] as const)('opens and closes a titleless %s note, preserving the original list', async mode => {
    const { dom, document, context } = page();
    if (mode === 'home') dom.window.history.replaceState({}, '', '/explore?channel=homefeed');
    const original = context.href(); const expectedKeyword = mode === 'home' ? '' : keyword;
    document.querySelector<HTMLAnchorElement>('.cover')!.onclick = event => {
      event.preventDefault(); dom.window.history.pushState({}, '', `/explore/${id}`);
      document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container"><div id="detail-desc">图片帖，无文字标题</div></div></div>');
      document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = () => { document.querySelector('.note-detail-mask')!.remove(); dom.window.history.pushState({}, '', original); };
    };
    expect(await openNoteInPage(document, visible, expectedKeyword, `xhs:${id}`, context, mode)).toMatchObject({ ok: true, opened: true });
    expect(hasOpenNoteDetail(document, visible)).toBe(true);
    expect(await closeNoteInPage(document, visible, expectedKeyword, `xhs:${id}`, context, mode)).toEqual({ ok: true, sourceUrl: original });
    expect(hasOpenNoteDetail(document, visible)).toBe(false);
  });
  it.each(['', '<h1>正文标题</h1>'])('ignores unrelated h1 headings when closing a modal with title markup %s', async titleMarkup => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    document.body.insertAdjacentHTML('beforeend', `<header><h1>搜索页</h1></header><div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container">${titleMarkup}<div class="comments-container"><h1>评论标题</h1><button class="close-circle">评论关闭</button></div><div data-recommendation><h1>推荐标题</h1><div class="note-container">推荐内容</div><button class="close-circle">推荐关闭</button></div></div></div>`);
    const others = vi.fn(); document.querySelectorAll<HTMLButtonElement>('.comments-container button,[data-recommendation] button').forEach(button => { button.onclick = others; });
    const close = vi.fn(() => { document.querySelector('.note-detail-mask')!.remove(); dom.window.history.replaceState({}, '', source); });
    document.querySelector<HTMLButtonElement>('.note-detail-mask > .close-circle')!.onclick = close;
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toEqual({ ok: true, sourceUrl: source });
    expect(close).toHaveBeenCalledOnce(); expect(others).not.toHaveBeenCalled();
  });
  it('recognizes a list that is already restored even if it has visible headings', async () => {
    const { document, context } = page();
    document.body.insertAdjacentHTML('beforeend', '<h1>搜索结果</h1><div class="note-container" hidden>旧详情</div>');
    expect(hasOpenNoteDetail(document, visible)).toBe(false);
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toEqual({ ok: true, sourceUrl: source });
  });
  it('does not open another card while a titleless detail is still visible', async () => {
    const { document, context } = page(); const click = vi.fn(); document.querySelector<HTMLAnchorElement>('.cover')!.onclick = click;
    document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><div class="note-container">旧详情</div></div>');
    expect(await openNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'previous_detail_not_closed', ambiguous: false });
    expect(click).not.toHaveBeenCalled();
  });
  it('rejects multiple visible detail roots even when there is exactly one h1', async () => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container"><h1>唯一标题</h1></div><div class="note-container">另一详情</div></div>');
    const click = vi.fn(); document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = click;
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'detail_close_scope_unverified' });
    expect(click).not.toHaveBeenCalled();
  });
  it('treats nested aliases of the same detail as one scope', async () => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-detail-container"><div id="noteContainer" class="note-container">无标题</div></div></div>');
    document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = () => { document.querySelector('.note-detail-mask')!.remove(); dom.window.history.replaceState({}, '', source); };
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: true });
  });
  it('waits for the actual detail to disappear after the route has returned to the list', async () => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container">无标题</div></div>');
    const click = vi.fn(() => { dom.window.history.replaceState({}, '', source); }); document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = click;
    const animation = vi.fn(async () => { expect(hasOpenNoteDetail(document, visible)).toBe(true); document.querySelector('.note-detail-mask')!.remove(); });
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, { ...context, wait: animation })).toEqual({ ok: true, sourceUrl: source });
    expect(animation).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce();
  });
  it('does not claim success while a titleless detail or mask remains visible on the list', async () => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container">无标题</div></div>');
    const click = vi.fn(() => { document.querySelector('.note-container')!.remove(); dom.window.history.replaceState({}, '', source); }); document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = click;
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'page_transition_unverified' });
    expect(click).toHaveBeenCalledOnce(); expect(hasOpenNoteDetail(document, visible)).toBe(true);
  });
  it.each(['missing', 'multiple', 'disabled'] as const)('does not fall back to a global close control when the detail control is %s', async mode => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    const buttons = mode === 'missing' ? '' : mode === 'multiple' ? '<button class="close-circle">A</button><button class="close-circle">B</button>' : '<button class="close-circle" disabled>关闭</button>';
    document.body.insertAdjacentHTML('beforeend', `<button class="close-circle">其他窗口</button><div class="note-detail-mask">${buttons}<div class="note-container">无标题</div></div>`);
    const click = vi.fn(); document.querySelectorAll<HTMLButtonElement>('button.close-circle').forEach(button => { button.onclick = click; });
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'detail_close_control_not_unique_or_disabled' });
    expect(click).not.toHaveBeenCalled();
  });
  it.each(['/', '/explore?channel=homefeed'])('opens and closes home cards on %s without searching or changing the feed', async path => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', path);
    const home = context.href(); const search = vi.fn(); document.querySelector<HTMLButtonElement>('.search-button')!.onclick = search;
    document.querySelector<HTMLAnchorElement>('.cover')!.onclick = event => {
      event.preventDefault(); dom.window.history.pushState({}, '', `/explore/${id}`);
      document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container"><h1>找化妆师</h1></div></div>');
      document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = () => { document.querySelector('.note-detail-mask')!.remove(); dom.window.history.pushState({}, '', home); };
    };
    expect(await openNoteInPage(document, visible, '', `xhs:${id}`, context, 'home')).toMatchObject({ ok: true, opened: true });
    expect(await closeNoteInPage(document, visible, '', `xhs:${id}`, context, 'home')).toEqual({ ok: true, sourceUrl: home });
    expect(search).not.toHaveBeenCalled(); expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('');
  });
  it('rejects a search list for a home session and a home list for a search session', async () => {
    const { dom, document, context } = page();
    expect(await openNoteInPage(document, visible, '', `xhs:${id}`, context, 'home')).toMatchObject({ ok: false, ambiguous: false, reason: 'home_tab_changed' });
    dom.window.history.replaceState({}, '', '/explore');
    expect(await openNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, ambiguous: false, reason: 'search_tab_or_keyword_changed' });
    expect(isTaskList('invalid', '', 'home')).toBe(false);
  });
  it('does not accept returning a home modal to an unrelated search list', async () => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', `/explore/${id}`);
    document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container"><h1>找化妆师</h1></div></div>');
    document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = () => { document.querySelector('.note-detail-mask')!.remove(); dom.window.history.pushState({}, '', source); };
    expect(await closeNoteInPage(document, visible, '', `xhs:${id}`, context, 'home')).toMatchObject({ ok: false, reason: 'page_transition_unverified' });
  });
  it('clicks the existing card once and closes its modal back to the filtered list', async () => {
    const { dom, document, context } = page();
    const click = vi.fn((event: Event) => {
      event.preventDefault(); dom.window.history.pushState({}, '', `/explore/${id}`);
      document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container"><h1>找化妆师</h1></div></div>');
      document.querySelector<HTMLButtonElement>('.close-circle')!.onclick = () => { document.querySelector('.note-detail-mask')!.remove(); dom.window.history.pushState({}, '', source); };
    });
    document.querySelector<HTMLAnchorElement>('.cover')!.onclick = click;
    expect(await openNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: true, opened: true });
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toEqual({ ok: true, sourceUrl: source });
    expect(click).toHaveBeenCalledTimes(1); expect(context.href()).toContain('sort=time_descending');
  });
  it('uses the real search input and submit handler rather than constructing a result URL', async () => {
    const { dom, document, context } = page(); dom.window.history.replaceState({}, '', '/explore');
    const submit = vi.fn(() => { expect(document.querySelector<HTMLInputElement>('input')!.value).toBe(keyword); dom.window.history.pushState({}, '', source); });
    document.querySelector<HTMLButtonElement>('.search-button')!.onclick = submit;
    expect(await searchInPage(document, visible, keyword, context)).toEqual({ ok: true, sourceUrl: source });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('binds an already matching search without resubmitting or resetting its filters', async () => {
    const { document, context } = page(); const submit = vi.fn(); document.querySelector<HTMLButtonElement>('.search-button')!.onclick = submit;
    expect(await searchInPage(document, visible, keyword, context)).toMatchObject({ ok: true, sourceUrl: source });
    expect(submit).not.toHaveBeenCalled();
  });
  it('does not navigate to a candidate no longer present in the loaded list', async () => {
    const { document, context } = page(); const click = vi.fn(); document.querySelector<HTMLAnchorElement>('.cover')!.onclick = click;
    expect(await openNoteInPage(document, visible, keyword, 'xhs:000000000000000000000002', context)).toMatchObject({ ok: false, ambiguous: false, reason: 'candidate_not_in_loaded_list' });
    expect(click).not.toHaveBeenCalled(); expect(context.href()).toBe(source);
  });
  it('blocks ambiguous cards and links explicitly requesting a new window', async () => {
    const { document, context } = page(); const link = document.querySelector<HTMLAnchorElement>('.cover')!; link.target = '_blank';
    expect(await openNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'candidate_link_opens_new_window' });
    link.target = ''; document.body.insertAdjacentHTML('beforeend', `<section><a href="/explore/${id}">另一张卡片</a></section>`);
    expect(await openNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'candidate_card_not_unique' });
  });
  it('does not close a different note the user opened manually', async () => {
    const { dom, document, context } = page(); dom.window.history.pushState({}, '', '/explore/000000000000000000000002');
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'note_changed_do_not_close' });
  });
  it('stops on a restriction redirect after clicking, without a fallback deep link', async () => {
    const { dom, document, context } = page();
    const click = vi.fn((event: Event) => { event.preventDefault(); dom.window.history.pushState({}, '', '/website-login/error?code=300011'); }); document.querySelector<HTMLAnchorElement>('.cover')!.onclick = click;
    expect(await openNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'account_restricted', ambiguous: true });
    expect(click).toHaveBeenCalledTimes(1);
    expect(await closeNoteInPage(document, visible, keyword, `xhs:${id}`, context)).toMatchObject({ ok: false, reason: 'account_restricted' });
  });
  it('recognizes both search routes and bounded double-encoded keywords', () => {
    expect(isSearchList(source, keyword)).toBe(true);
    expect(isSearchList(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, keyword)).toBe(true);
    expect(isSearchList(source, '租房')).toBe(false);
  });
});
