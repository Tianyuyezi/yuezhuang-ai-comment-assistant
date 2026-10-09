import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { connectedPageMessage, ensurePageConnection } from './pageConnection';
import { EXTENSION_VERSION } from './extensionVersion';

let url: string; let connected: boolean; let version: string; let blocked: string | null; let keepMissing: boolean;
let inject: ReturnType<typeof vi.fn>; let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  url = 'https://www.xiaohongshu.com/search_result_ai?keyword=上海约妆&sort=time_descending';
  connected = true; version = EXTENSION_VERSION; blocked = null; keepMissing = false;
  inject = vi.fn(async () => { if (!keepMissing) { connected = true; version = EXTENSION_VERSION; } return [{ frameId: 0, documentId: 'test-document' }]; });
  send = vi.fn(async (_id: number, message: any) => {
    if (message.type === 'ASSISTANT_CONTENT_STATUS') {
      if (!connected) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: !blocked, reason: blocked, version, instance: 'page-1', sourceUrl: url };
    }
    return { ok: true, sourceUrl: url };
  });
  vi.stubGlobal('chrome', { tabs: { get: async () => ({ id: 1, url }), sendMessage: send }, scripting: { executeScript: inject } });
});
afterEach(() => vi.unstubAllGlobals());

describe('read-only page connection recovery', () => {
  it('uses a current receiver without injecting or navigating', async () => {
    expect((await ensurePageConnection(1)).version).toBe(EXTENSION_VERSION); expect(inject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(1, { type: 'ASSISTANT_CONTENT_STATUS' }, { frameId: 0 });
  });
  it('repairs the missing receiver before binding without refreshing or losing filters', async () => {
    connected = false;
    await connectedPageMessage(1, { type: 'ASSISTANT_PAGE_GUARD' });
    expect(inject).toHaveBeenCalledExactlyOnceWith({ target: { tabId: 1, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' });
    expect(send.mock.calls.map(call => call[1].type)).toEqual(['ASSISTANT_CONTENT_STATUS', 'ASSISTANT_CONTENT_STATUS', 'ASSISTANT_PAGE_GUARD']);
    expect(url).toContain('sort=time_descending'); expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ connectionVersion: EXTENSION_VERSION, connectionInstance: 'page-1' });
  });
  it('replaces a stale build before sending any action', async () => {
    version = '0.9.6'; await connectedPageMessage(1, { type: 'ASSISTANT_OPEN_NOTE' });
    expect(inject).toHaveBeenCalledOnce(); expect(send.mock.calls.at(-1)?.[1].type).toBe('ASSISTANT_OPEN_NOTE');
  });
  it('serializes concurrent checks for one tab', async () => {
    connected = false; const [a, b] = await Promise.all([ensurePageConnection(1), ensurePageConnection(1)]);
    expect(a).toEqual(b); expect(inject).toHaveBeenCalledOnce();
  });
  it('stops after one unsuccessful injection with an actionable error', async () => {
    connected = false; keepMissing = true;
    await expect(connectedPageMessage(1, { type: 'ASSISTANT_FOLLOW' })).rejects.toThrow('不会自动刷新');
    expect(inject).toHaveBeenCalledOnce(); expect(send.mock.calls.every(call => call[1].type === 'ASSISTANT_CONTENT_STATUS')).toBe(true);
  });
  it('explains missing script permission without retrying a payload', async () => {
    connected = false; inject.mockRejectedValue(new Error('Permission denied'));
    await expect(connectedPageMessage(1, { type: 'ASSISTANT_PUBLISH' })).rejects.toThrow('获准访问小红书');
    expect(send).toHaveBeenCalledOnce();
  });
  it.each(['chrome://extensions/', 'https://example.com/explore', 'file:///tmp/example', 'https://www.xiaohongshu.com.evil.test/explore'])('does not probe or inject into an unrelated URL %s', async value => {
    url = value; await expect(ensurePageConnection(1)).rejects.toThrow('不能连接其他网站');
    expect(send).not.toHaveBeenCalled(); expect(inject).not.toHaveBeenCalled();
  });
  it('does not inject through a platform restriction redirect', async () => {
    url = 'https://www.xiaohongshu.com/website-login/error?code=300011';
    await expect(ensurePageConnection(1)).rejects.toThrow('account_restricted'); expect(inject).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('does not attempt recovery through an in-page security challenge', async () => {
    blocked = 'security_challenge'; await expect(ensurePageConnection(1)).rejects.toThrow('security_challenge'); expect(inject).not.toHaveBeenCalled();
  });
  it('aborts if navigation changes during script injection', async () => {
    connected = false; inject.mockImplementation(async () => { connected = true; url = 'https://www.xiaohongshu.com/explore'; return []; });
    await expect(connectedPageMessage(1, { type: 'ASSISTANT_LIKE' })).rejects.toThrow('页面已变化');
    expect(send.mock.calls.every(call => call[1].type === 'ASSISTANT_CONTENT_STATUS')).toBe(true);
  });
  it.each(['ASSISTANT_FOLLOW', 'ASSISTANT_LIKE', 'ASSISTANT_PUBLISH'])('never retries %s after its response is lost', async type => {
    const normal = send.getMockImplementation()!;
    send.mockImplementation(async (id, message) => { if (message.type === type) throw new Error('Message port closed after click'); return normal(id, message); });
    await expect(connectedPageMessage(1, { type })).rejects.toThrow('未重发操作');
    expect(send.mock.calls.filter(call => call[1].type === type)).toHaveLength(1); expect(inject).not.toHaveBeenCalled();
  });
});
