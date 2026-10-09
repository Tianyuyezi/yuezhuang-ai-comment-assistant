// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoProgress } from './AutoProgress';

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows the page position, title and reason, distinguishing a skipped title from a random jump', async () => {
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => { root.render(<AutoProgress current={{ noteId: 'xhs:a', title: '上海化妆作品展示', listOrder: 0, stage: '已跳过（未打开详情）', reason: '标题与客户需求无关' }} />); });
    expect(container.textContent).toContain('当前第 1 条：上海化妆作品展示');
    expect(container.textContent).toContain('未打开详情'); expect(container.textContent).toContain('标题与客户需求无关');
  } finally { await act(async () => { root.unmount(); }); }
});
it('handles legacy state without inventing a position', async () => {
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => { root.render(<AutoProgress current={undefined} />); });
    expect(container.textContent).toContain('第一个未处理项'); expect(container.textContent).not.toContain('当前第');
  } finally { await act(async () => { root.unmount(); }); }
});
