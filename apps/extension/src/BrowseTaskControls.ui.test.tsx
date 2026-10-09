// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchTask } from '@yuezhuang/shared';
import { BrowseTaskControls } from './BrowseTaskControls';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const old: SearchTask = { id: 'search', campaignId: 'c', campaignName: '租房', keyword: '上海求租', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海求租', createdAt: '2026-10-06', status: 'collected' };
const home: SearchTask = { ...old, id: 'home', source: 'home', keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore' };
async function mount(source: 'home' | 'search', locked = false) {
  const handlers = { onSourceChange: vi.fn(), onKeywordChange: vi.fn(), onBind: vi.fn(), onCollect: vi.fn(), onTaskChange: vi.fn() };
  await act(async () => root.render(<BrowseTaskControls source={source} keyword="上海求租" tasks={[old, home]} currentTaskId={source} locked={locked} {...handlers} />));
  return handlers;
}
describe('homepage Auto task controls', () => {
  it('does not require or display search keywords on the home feed', async () => {
    const handlers = await mount('home');
    expect(host.querySelector('#auto-keyword')).toBeNull();
    const buttons = [...host.querySelectorAll('button')];
    await act(async () => buttons.find(button => button.textContent === '绑定当前首页')!.click());
    expect(handlers.onBind).toHaveBeenCalledOnce(); expect(handlers.onKeywordChange).not.toHaveBeenCalled();
    expect(host.querySelector('#auto-task')!.textContent).toContain('首页推荐流');
    expect(host.querySelector('#auto-task')!.textContent).not.toContain('上海求租');
  });
  it('keeps legacy search tasks and their keyword controls separate', async () => {
    const handlers = await mount('search'); expect(host.querySelector<HTMLInputElement>('#auto-keyword')!.value).toBe('上海求租');
    expect(host.querySelector('#auto-task')!.textContent).not.toContain('首页推荐流');
    await act(async () => { const select = host.querySelector<HTMLSelectElement>('#auto-source')!; select.value = 'home'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(handlers.onSourceChange).toHaveBeenCalledWith('home');
  });
  it('locks source, binding, collection and task switching during an active workflow', async () => {
    const handlers = await mount('home', true);
    expect([...host.querySelectorAll<HTMLSelectElement | HTMLButtonElement>('select,button')].every(control => control.disabled)).toBe(true);
    await act(async () => host.querySelector('button')!.click()); expect(handlers.onBind).not.toHaveBeenCalled();
  });
});
