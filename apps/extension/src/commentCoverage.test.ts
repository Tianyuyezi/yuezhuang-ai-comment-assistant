import { describe, expect, it } from 'vitest';
import { commentsFullyLoaded, visibleCommentsReady } from './commentCoverage';

describe('comment coverage for automatic publication', () => {
  it('reports whether every declared comment and reply was loaded for diagnostics', () => {
    expect(commentsFullyLoaded(60, 12, true)).toBe(false);
    expect(commentsFullyLoaded(60, 60, true)).toBe(false);
    expect(commentsFullyLoaded(60, 60, false)).toBe(true);
  });
  it('does not assume an unknown count is complete', () => {
    expect(commentsFullyLoaded(null, 12, false)).toBe(false);
    expect(commentsFullyLoaded(0, 0, false)).toBe(true);
  });
  it('allows assessment with a visible comment sample even when more comments remain', () => {
    expect(visibleCommentsReady(true, 60, 12)).toBe(true);
    expect(visibleCommentsReady(true, null, 1)).toBe(true);
    expect(visibleCommentsReady(true, 0, 0)).toBe(true);
    expect(visibleCommentsReady(true, 60, 0)).toBe(false);
    expect(visibleCommentsReady(true, null, 0)).toBe(false);
    expect(visibleCommentsReady(false, 60, 12)).toBe(false);
  });
});
