import { describe, expect, it, vi } from 'vitest';
import { ensureBackgroundVersion, EXTENSION_VERSION } from './extensionVersion';

describe('sidepanel/background update guard', () => {
  it('accepts only the same compiled manifest version', async () => {
    const send = vi.fn(async () => ({ version: EXTENSION_VERSION }));
    await expect(ensureBackgroundVersion(send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ type: 'EXTENSION_VERSION' });
  });
  it.each([{ version: '0.9.0' }, undefined, { version: 'future-version' }])('instructs reload on a mismatched or old background: %j', async response => {
    await expect(ensureBackgroundVersion(async () => response)).rejects.toThrow('现有记录保留');
  });
  it('handles a stale extension message port without exposing a raw error', async () => {
    await expect(ensureBackgroundVersion(async () => { throw new Error('Receiving end does not exist'); })).rejects.toThrow('重新加载插件');
  });
});
