// Isolated DOM only: no browser account, external resources, model requests or real interactions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
const noteId = 'xhs:000000000000000000000001';
const title = '上海求租';
const body = '想找上海7号线附近合租房间，预算2000元。';
const likeHtml = '<div class="engage-bar"><div class="buttons"><div class="left"><button class="like-wrapper"><svg><use href="#like_b"></use></svg>25</button></div></div></div>';

async function verify(security = false) {
  const dom = new JSDOM(`<div class="note-container"><h1>${title}</h1><div id="detail-desc">${body}</div>${likeHtml}<div id="comment-list">共0条评论${likeHtml}</div></div><div data-recommendation>${likeHtml}</div>`, {
    url: 'https://www.xiaohongshu.com/explore/000000000000000000000001', runScripts: 'outside-only'
  });
  try {
    const { window } = dom;
    window.Element.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}]; };
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    let listener;
    window.chrome = { runtime: { getManifest: () => manifest, onMessage: { addListener: callback => { listener = callback; }, removeListener: callback => { if (listener === callback) listener = undefined; } } } };
    window.fetch = () => { throw new Error('External requests are forbidden in bundle verification'); };
    const clicks = { main: 0, others: 0 };
    window.document.querySelectorAll('#comment-list button,[data-recommendation] button').forEach(button => { button.onclick = () => { clicks.others++; }; });
    const old = window.document.querySelector('.note-container > .engage-bar .like-wrapper');
    old.onclick = () => {
      clicks.main++;
      if (security) { window.document.body.insertAdjacentHTML('beforeend', '<div>请完成验证</div>'); return; }
      old.outerHTML = '<button class="like-wrapper"><svg><use href="#liked_b"></use></svg>26</button>';
      window.document.querySelector('.note-container > .engage-bar .like-wrapper').onclick = () => { clicks.main++; };
    };
    window.eval(bundle);
    const request = type => new Promise(resolve => listener({ type, expectedNoteId: noteId, expectedTitle: title, expectedBody: body }, {}, resolve));
    const note = await request('ASSISTANT_READ_NOTE');
    assert.equal(note.note.completeness, 'complete');
    const result = await request('ASSISTANT_LIKE');
    if (security) {
      assert.equal(result.ok, false); assert.equal(result.reason, 'security_challenge'); assert.equal(result.ambiguous, true);
    } else {
      assert.equal(result.ok, true); assert.equal(result.alreadyLiked, false); assert.equal(old.isConnected, false);
      const state = await request('ASSISTANT_LIKE_STATE'); assert.equal(state.ok, true); assert.equal(state.liked, true);
      const repeat = await request('ASSISTANT_LIKE'); assert.equal(repeat.alreadyLiked, true);
    }
    assert.deepEqual(clicks, { main: 1, others: 0 });
    return { scenario: security ? 'security-challenge-after-click' : 'button-replaced-and-repeat-request', verified: true, clicks };
  } finally { dom.window.close(); }
}
console.log(JSON.stringify(await verify()));
console.log(JSON.stringify(await verify(true)));

async function verifySamePage(restricted = false, home = false) {
  const keyword = '上海求租';
  const source = home ? 'https://www.xiaohongshu.com/explore?channel=homefeed' : `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(encodeURIComponent(keyword))}&sort=time_descending`;
  const dom = new JSDOM(`<nav><a href="/user/profile/000000000000000000000004">我</a></nav><div class="search-container"><input id="search-input" placeholder="搜索"><button class="search-button">搜索</button></div><section class="note-item"><a class="cover" href="/explore/000000000000000000000001?xsec_token=fixture">找房</a></section>`, { url: 'https://www.xiaohongshu.com/explore', runScripts: 'outside-only' });
  try {
    const { window } = dom; const { document } = window;
    window.Element.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}]; };
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    let listener;
    window.chrome = { runtime: { getManifest: () => manifest, onMessage: { addListener: callback => { listener = callback; }, removeListener: callback => { if (listener === callback) listener = undefined; } } } };
    window.fetch = () => { throw new Error('External requests are forbidden'); };
    const clicks = { search: 0, open: 0, follow: 0, like: 0, publish: 0, close: 0 };
    document.querySelector('.search-button').onclick = () => { clicks.search++; assert.equal(document.querySelector('input').value, keyword); window.history.pushState({}, '', source); };
    document.querySelector('.cover').onclick = event => {
      event.preventDefault(); clicks.open++; window.history.pushState({}, '', '/explore/000000000000000000000001');
      document.body.insertAdjacentHTML('beforeend', `<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container"><div class="author-container"><a href="/user/profile/000000000000000000000002">原作者</a><button class="follow-btn">关注</button></div><h1>${title}</h1><div id="detail-desc">${body}</div>${likeHtml}<div id="comment-list">共0条评论</div><textarea placeholder="评论"></textarea><button class="send-button">发送</button></div></div>`);
      document.querySelector('.follow-btn').onclick = () => { clicks.follow++; document.querySelector('.follow-btn').textContent = '已关注'; };
      document.querySelector('.note-container .like-wrapper').onclick = () => { clicks.like++; document.querySelector('.note-container .like-wrapper').outerHTML = '<button class="like-wrapper"><svg><use href="#liked_b"></use></svg>26</button>'; };
      document.querySelector('.send-button').onclick = () => { clicks.publish++; const input = document.querySelector('textarea'); document.querySelector('#comment-list').innerHTML = `<div class="comment-item" id="comment-000000000000000000000005"><a href="/user/profile/000000000000000000000004">我</a><span class="note-text">${input.value}</span></div>`; input.value = ''; };
      document.querySelector('.close-circle').onclick = () => { clicks.close++; document.querySelector('.note-detail-mask').remove(); window.history.pushState({}, '', source); };
    };
    if (restricted) window.history.replaceState({}, '', '/website-login/error?code=300011');
    else if (home) window.history.replaceState({}, '', source);
    let scrolls = 0;
    if (home && !restricted) {
      const feed = document.createElement('div'); feed.style.overflowY = 'auto';
      const card = document.querySelector('.note-item'); card.replaceWith(feed); feed.append(card);
      Object.defineProperties(feed, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
      feed.scrollBy = ({ top }) => { scrolls++; feed.scrollTop += top; feed.insertAdjacentHTML('beforeend', '<section class="note-item"><a class="cover" href="/explore/000000000000000000000003?xsec_token=fixture">下一张卡片</a></section>'); };
    }
    window.eval(bundle);
    const request = (type, fields = {}) => new Promise(resolve => listener({ type, source: home ? 'home' : 'search', expectedSource: home ? 'home' : 'search', expectedNoteId: noteId, expectedTitle: title, expectedBody: body, expectedKeyword: home ? '' : keyword, keyword, expectedAuthorId: '000000000000000000000002', ...fields }, {}, resolve));
    const search = await request(home ? 'ASSISTANT_FEED_RESULTS' : 'ASSISTANT_UI_SEARCH');
    if (restricted) {
      assert.equal(search.reason, 'account_restricted');
      assert.deepEqual(clicks, { search: 0, open: 0, follow: 0, like: 0, publish: 0, close: 0 });
    } else {
      assert.equal(search.ok, true); assert.equal(search.sourceUrl, source);
      if (home) assert.equal(search.results[0].noteId, noteId);
      assert.equal((await request('ASSISTANT_OPEN_NOTE')).opened, true);
      assert.equal((await request('ASSISTANT_READ_NOTE')).note.completeness, 'complete');
      assert.equal((await request('ASSISTANT_FOLLOW')).followed, true);
      assert.equal((await request('ASSISTANT_LIKE')).liked, true);
      assert.equal((await request('ASSISTANT_PUBLISH', { text: '求看' })).published, true);
      assert.equal((await request('ASSISTANT_PUBLISH', { text: '求看' })).alreadyPublished, true);
      assert.equal((await request('ASSISTANT_CLOSE_NOTE')).sourceUrl, source);
      if (home) {
        const scrolled = await request('ASSISTANT_SCROLL_FEED');
        assert.equal(scrolled.ok, true); assert.equal(scrolled.scrollMoved, true); assert.equal(scrolled.results.length, 2); assert.equal(scrolls, 1);
      }
      assert.deepEqual(clicks, { search: home ? 0 : 1, open: 1, follow: 1, like: 1, publish: 1, close: 1 });
      assert.equal(window.location.href, source);
    }
    return { scenario: restricted ? `restriction-blocks-${home ? 'home' : 'search'}-actions` : `single-page-${home ? 'home' : 'search'}-open-follow-like-publish-close`, verified: true, clicks, scrolls };
  } finally { dom.window.close(); }
}
console.log(JSON.stringify(await verifySamePage()));
console.log(JSON.stringify(await verifySamePage(true)));
console.log(JSON.stringify(await verifySamePage(false, true)));
console.log(JSON.stringify(await verifySamePage(true, true)));

async function verifyPublication(mode) {
  const sender = '000000000000000000000004';
  const ownRow = `<div class="comment-item" id="comment-000000000000000000000005"><a href="/user/profile/${sender}">我</a><div class="content"><span class="note-text">求<span>看</span></span></div></div>`;
  const nav = mode === 'missing-sender' ? '' : `<nav><a href="/user/profile/${sender}">我</a></nav>`;
  const dom = new JSDOM(`${nav}<button class="unrelated-send">发送</button><div class="note-container"><h1>${title}</h1><div id="detail-desc">${body}</div><div id="comment-list">共0条评论</div><textarea placeholder="评论"></textarea><button class="send-button">发送</button><div class="reply-container"><textarea placeholder="回复评论"></textarea><button class="reply-send">发送</button></div></div>`, { url: 'https://www.xiaohongshu.com/explore/000000000000000000000001', runScripts: 'outside-only' });
  try {
    const { window } = dom; const { document } = window; let listener; let elapsed = 0;
    if (mode === 'pre-existing') document.querySelector('#comment-list').innerHTML = ownRow;
    window.Element.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}]; };
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    window.chrome = { runtime: { getManifest: () => manifest, onMessage: { addListener: callback => { listener = callback; }, removeListener: () => {} } } };
    window.fetch = () => { throw new Error('External requests forbidden'); };
    const nativeTimer = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms) => nativeTimer(() => {
      elapsed += ms;
      if (mode === 'slow-render' && elapsed === 12000) document.querySelector('#comment-list').innerHTML = ownRow;
      callback();
    }, 1);
    const clicks = { main: 0, others: 0 };
    document.querySelectorAll('.unrelated-send,.reply-send').forEach(button => { button.onclick = () => { clicks.others++; }; });
    document.querySelector('.send-button').onclick = () => {
      clicks.main++;
      if (mode !== 'retained-input') document.querySelector('.note-container > textarea').value = '';
      // Partial comment coverage during rerender must not fail the original-post identity check.
      document.querySelector('#comment-list').innerHTML = mode === 'retained-input' ? ownRow : mode === 'wrong-author' ? ownRow.replace(sender, '000000000000000000000002') : '共1条评论';
    };
    window.eval(bundle);
    const request = type => new Promise(resolve => listener({ type, expectedNoteId: noteId, expectedTitle: title, expectedBody: body, text: '求看' }, {}, resolve));
    const result = await request('ASSISTANT_PUBLISH');
    if (mode === 'missing-sender') {
      assert.equal(result.reason, 'comment_sender_identity_unverified'); assert.equal(result.ambiguous, false); assert.equal(clicks.main, 0);
    } else if (mode === 'slow-render') {
      assert.equal(result.published, true); assert.equal(result.senderId, sender); assert.equal(elapsed, 12500); assert.equal(clicks.main, 1);
    } else if (mode === 'pre-existing') {
      assert.equal(result.alreadyPublished, true); assert.equal(result.published, true); assert.equal(clicks.main, 0);
      assert.equal(document.querySelector('.note-container > textarea').value, '');
    } else if (mode === 'retained-input') {
      assert.equal(result.published, true); assert.equal(document.querySelector('.note-container > textarea').value, '求看'); assert.equal(clicks.main, 1);
      assert.equal((await request('ASSISTANT_PUBLISH')).alreadyPublished, true); assert.equal(clicks.main, 1);
    } else {
      assert.equal(result.reason, 'send_clicked_but_publication_unverified'); assert.equal(result.ambiguous, true); assert.equal(elapsed, 20000);
      assert.equal((await request('ASSISTANT_PUBLICATION_STATE')).published, false);
      document.querySelector('#comment-list').innerHTML = ownRow;
      assert.equal((await request('ASSISTANT_PUBLICATION_STATE')).published, true); assert.equal(clicks.main, 1);
    }
    assert.equal(clicks.others, 0);
    return { scenario: `publication-${mode}`, verified: true, clicks, simulatedWaitMs: elapsed };
  } finally { dom.window.close(); }
}
for (const mode of ['slow-render', 'wrong-author', 'missing-sender', 'pre-existing', 'retained-input']) console.log(JSON.stringify(await verifyPublication(mode)));

async function verifyReconnect() {
  const dom = new JSDOM('<div>隔离连接测试</div>', { url: 'https://www.xiaohongshu.com/explore', runScripts: 'outside-only' });
  try {
    const { window } = dom; const listeners = new Set(); let invalid = false;
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    const events = { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback) };
    const runtime = { getManifest: () => { if (invalid) throw new Error('Extension context invalidated'); return manifest; }, onMessage: events };
    window.chrome = { runtime }; window.fetch = () => { throw new Error('External requests forbidden'); };
    const status = () => new Promise(resolve => [...listeners][0]({ type: 'ASSISTANT_CONTENT_STATUS' }, {}, resolve));
    window.eval(bundle); const before = await status(); assert.equal(before.version, manifest.version); assert.equal(listeners.size, 1);
    window.eval(bundle); assert.equal(listeners.size, 1); assert.equal((await status()).instance, before.instance);
    const response = await new Promise(resolve => [...listeners][0]({ type: 'ASSISTANT_UI_SEARCH', connectionVersion: manifest.version, connectionInstance: 'wrong-document', keyword: '测试' }, {}, resolve));
    assert.equal(response.reason, 'page_connection_changed_before_action');
    invalid = true; window.chrome = { runtime: { getManifest: () => manifest, onMessage: events } };
    window.eval(bundle); const after = await status(); assert.equal(listeners.size, 1); assert.notEqual(after.instance, before.instance);
    return { scenario: 'idempotent-reconnect-and-invalid-context-replacement', verified: true, activeListeners: listeners.size };
  } finally { dom.window.close(); }
}
console.log(JSON.stringify(await verifyReconnect()));

async function verifyTitleIndependentNavigation(home = false, titleless = true) {
  const keyword = '上海求租';
  const source = home ? 'https://www.xiaohongshu.com/explore?channel=homefeed' : `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(keyword)}&sort=time_descending`;
  const ids = ['000000000000000000000001', '000000000000000000000003'];
  const dom = new JSDOM(`<header><h1>列表页标题</h1></header>${ids.map(id => `<section class="note-item"><a class="cover" href="/explore/${id}">卡片</a><a class="title" href="/explore/${id}">上海求租</a></section>`).join('')}`, { url: source, runScripts: 'outside-only' });
  try {
    const { window } = dom; const { document } = window;
    window.Element.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}]; };
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    let listener;
    window.chrome = { runtime: { getManifest: () => manifest, onMessage: { addListener: callback => { listener = callback; }, removeListener: callback => { if (listener === callback) listener = undefined; } } } };
    window.fetch = () => { throw new Error('External requests forbidden'); };
    const clicks = { open: 0, close: 0, interactions: 0 };
    for (const link of document.querySelectorAll('.cover')) link.onclick = event => {
      event.preventDefault(); clicks.open++; window.history.pushState({}, '', link.href);
      document.body.insertAdjacentHTML('beforeend', `<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container">${titleless ? '' : `<h1>${title}</h1>`}<div id="detail-desc">${body}</div><div id="comment-list">共0条评论</div><div data-recommendation><h1>推荐标题</h1></div>${likeHtml}<button class="follow-btn">关注</button><button class="send-button">发送</button></div></div>`);
      document.querySelectorAll('.like-wrapper,.follow-btn,.send-button').forEach(button => { button.onclick = () => { clicks.interactions++; }; });
      document.querySelector('.close-circle').onclick = () => { clicks.close++; document.querySelector('.note-detail-mask').remove(); window.history.replaceState({}, '', source); };
    };
    window.eval(bundle);
    const request = (type, id) => new Promise(resolve => listener({ type, source: home ? 'home' : 'search', expectedSource: home ? 'home' : 'search', expectedKeyword: home ? '' : keyword, expectedNoteId: `xhs:${id}`, expectedTitle: title, expectedBody: body, text: '求看' }, {}, resolve));
    for (const id of ids) {
      assert.equal((await request('ASSISTANT_OPEN_NOTE', id)).opened, true);
      const note = await request('ASSISTANT_READ_NOTE', id);
      if (titleless) {
        // List/recommendation headings cannot turn an unreadable note into a sendable one.
        assert.equal(note.ok, false);
        for (const type of ['ASSISTANT_FOLLOW', 'ASSISTANT_LIKE', 'ASSISTANT_PUBLISH']) assert.equal((await request(type, id)).ok, false);
      } else { assert.equal(note.note.title, title); assert.equal(note.note.body, body); }
      assert.equal((await request('ASSISTANT_FEED_RESULTS', id)).ok, false);
      assert.equal((await request('ASSISTANT_CLOSE_NOTE', id)).sourceUrl, source);
      assert.equal((await request('ASSISTANT_FEED_RESULTS', id)).ok, true);
    }
    assert.deepEqual(clicks, { open: 2, close: 2, interactions: 0 });
    assert.equal(window.location.href, source);
    return { scenario: `${home ? 'home' : 'search'}-${titleless ? 'titleless' : 'multiple-page-headings'}-close-and-next-note`, verified: true, clicks };
  } finally { dom.window.close(); }
}
for (const home of [false, true]) for (const titleless of [true, false]) console.log(JSON.stringify(await verifyTitleIndependentNavigation(home, titleless)));

async function verifyVisualFeedOrder(home = false) {
  const keyword = '上海求租';
  const source = home ? 'https://www.xiaohongshu.com/explore?channel=homefeed' : `https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(keyword)}&sort=time_descending`;
  const ids = Array.from({ length: 80 }, (_, index) => (index + 1).toString(16).padStart(24, '0'));
  const dom = new JSDOM([...ids].reverse().map(id => `<section class="note-item" data-id="${id}"><a class="cover" href="/explore/${id}">封面</a><a class="title" href="/explore/${id}">上海求租 ${id}</a></section>`).join(''), { url: source, runScripts: 'outside-only' });
  try {
    const { window } = dom; const { document } = window;
    window.Element.prototype.getClientRects = function () { return [{}]; };
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    for (const card of document.querySelectorAll('section')) {
      const index = ids.indexOf(card.dataset.id);
      card.getBoundingClientRect = () => ({ top: Math.floor(index / 5) * 500, left: index % 5 * 300 });
    }
    let listener;
    window.chrome = { runtime: { getManifest: () => manifest, onMessage: { addListener: callback => { listener = callback; }, removeListener: callback => { if (listener === callback) listener = undefined; } } } };
    window.fetch = () => { throw new Error('External requests forbidden'); };
    const clicked = [];
    document.querySelectorAll('.cover').forEach(link => { link.onclick = event => {
      event.preventDefault(); clicked.push(link.closest('section').dataset.id); window.history.pushState({}, '', link.href);
      document.body.insertAdjacentHTML('beforeend', '<div class="note-detail-mask"><button class="close-circle">关闭</button><div class="note-container">无标题</div></div>');
      document.querySelector('.close-circle').onclick = () => { document.querySelector('.note-detail-mask').remove(); window.history.replaceState({}, '', source); };
    }; });
    window.eval(bundle);
    const request = type => new Promise(resolve => listener({ type, source: home ? 'home' : 'search', expectedSource: home ? 'home' : 'search', expectedKeyword: home ? '' : keyword, expectedNoteId: `xhs:${ids[0]}` }, {}, resolve));
    const list = await request('ASSISTANT_FEED_RESULTS');
    assert.equal(list.ok, true); assert.equal(list.results.length, 80);
    assert.deepEqual(Array.from(list.results, item => item.noteId), ids.map(id => `xhs:${id}`));
    assert.equal((await request('ASSISTANT_OPEN_NOTE')).opened, true); assert.deepEqual(clicked, [ids[0]]);
    assert.equal((await request('ASSISTANT_CLOSE_NOTE')).sourceUrl, source);
    return { scenario: `${home ? 'home' : 'search'}-eighty-cards-visual-order-first-card`, verified: true, collected: list.results.length, opened: clicked.length };
  } finally { dom.window.close(); }
}
for (const home of [false, true]) console.log(JSON.stringify(await verifyVisualFeedOrder(home)));
