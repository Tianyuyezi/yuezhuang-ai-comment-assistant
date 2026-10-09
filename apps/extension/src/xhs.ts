export function xhsNoteIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'www.xiaohongshu.com') return null;
    return url.pathname.match(/^\/(?:explore|search_result)\/([a-f0-9]+)\/?$/i)?.[1] ?? null;
  } catch { return null; }
}

export function decodedSearchKeyword(value: string | null): string | null {
  if (value === null) return null;
  let keyword = value;
  for (let attempt = 0; attempt < 2 && /%[a-f0-9]{2}/i.test(keyword); attempt++) {
    try { keyword = decodeURIComponent(keyword); } catch { break; }
  }
  return keyword;
}
export function isXhsRestrictionUrl(value: string): boolean {
  try { const url = new URL(value); return url.hostname === 'www.xiaohongshu.com' && /^\/website-login(?:\/|$)/.test(url.pathname); }
  catch { return false; }
}
export function isXhsSearchPage(value: string, keyword: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === 'www.xiaohongshu.com' && /^\/search_result(?:_ai)?\/?$/.test(url.pathname) && decodedSearchKeyword(url.searchParams.get('keyword')) === keyword;
  } catch { return false; }
}

export type AutoSource = 'home' | 'search';
export function autoTaskSource(task: { source?: AutoSource; keyword: string }): AutoSource { return task.source ?? 'search'; }
export function autoTaskLabel(task: { source?: AutoSource; keyword: string }): string { return autoTaskSource(task) === 'home' ? '首页推荐流' : `搜索：${task.keyword}`; }
export function isXhsHomePage(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.xiaohongshu.com' && /^\/(?:explore)?\/?$/.test(url.pathname); }
  catch { return false; }
}
export function isXhsTaskPage(value: string, task: { source?: AutoSource; keyword: string }): boolean {
  return autoTaskSource(task) === 'home' ? isXhsHomePage(value) : isXhsSearchPage(value, task.keyword);
}
