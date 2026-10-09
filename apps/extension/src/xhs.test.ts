import { describe, expect, it } from 'vitest';
import { autoTaskLabel, autoTaskSource, isXhsHomePage, isXhsRestrictionUrl, isXhsSearchPage, isXhsTaskPage, xhsNoteIdFromUrl } from './xhs';

describe('Xiaohongshu route parsing', () => {
  it('recognizes home lists without mistaking details, restrictions or search pages for a home list', () => {
    expect(isXhsHomePage('https://www.xiaohongshu.com/')).toBe(true);
    expect(isXhsHomePage('https://www.xiaohongshu.com/explore?channel=homefeed')).toBe(true);
    for (const url of ['https://www.xiaohongshu.com/explore/123', 'https://www.xiaohongshu.com/website-login/error', 'https://www.xiaohongshu.com/search_result?keyword=上海约妆', 'https://example.com/explore', 'http://www.xiaohongshu.com/explore', 'invalid']) expect(isXhsHomePage(url)).toBe(false);
  });
  it('keeps home and search task scopes separate, with old tasks defaulting to search', () => {
    const home = { source: 'home' as const, keyword: '' }; const old = { keyword: '上海约妆' };
    expect(autoTaskSource(old)).toBe('search'); expect(autoTaskLabel(home)).toBe('首页推荐流');
    expect(isXhsTaskPage('https://www.xiaohongshu.com/explore', home)).toBe(true);
    expect(isXhsTaskPage('https://www.xiaohongshu.com/explore', old)).toBe(false);
    expect(isXhsTaskPage('https://www.xiaohongshu.com/search_result?keyword=上海约妆', home)).toBe(false);
    expect(isXhsTaskPage('https://www.xiaohongshu.com/search_result?keyword=上海约妆', old)).toBe(true);
  });
  it('accepts both live result links and explore detail URLs', () => {
    expect(xhsNoteIdFromUrl('https://www.xiaohongshu.com/search_result/6ab7d5ab000000001b02ce03?xsec_token=test')).toBe('6ab7d5ab000000001b02ce03');
    expect(xhsNoteIdFromUrl('https://www.xiaohongshu.com/explore/6ab7d5ab000000001b02ce03')).toBe('6ab7d5ab000000001b02ce03');
  });
  it('rejects non-note links and foreign hosts', () => {
    expect(xhsNoteIdFromUrl('https://www.xiaohongshu.com/search_result?keyword=%E4%B8%8A%E6%B5%B7')).toBeNull();
    expect(xhsNoteIdFromUrl('https://example.com/explore/6ab7d5ab000000001b02ce03')).toBeNull();
  });
  it('accepts the optional search path slash and site-added parameters', () => {
    expect(isXhsSearchPage('https://www.xiaohongshu.com/search_result/?keyword=%E4%B8%8A%E6%B5%B7%E7%BA%A6%E5%A6%86&sort=time_descending&type=51', '上海约妆')).toBe(true);
  });
  it('accepts the current AI search route with a double-encoded keyword', () => {
    expect(isXhsSearchPage(`https://www.xiaohongshu.com/search_result_ai?keyword=${encodeURIComponent(encodeURIComponent('上海约妆'))}&sort=time_descending`, '上海约妆')).toBe(true);
    expect(isXhsSearchPage('https://www.xiaohongshu.com/search_result_ai?keyword=%XX', '上海约妆')).toBe(false);
  });
  it('identifies login/error routes without treating another host as Xiaohongshu', () => {
    expect(isXhsRestrictionUrl('https://www.xiaohongshu.com/website-login/error?code=300011')).toBe(true);
    expect(isXhsRestrictionUrl('https://example.com/website-login/error')).toBe(false);
  });
});
