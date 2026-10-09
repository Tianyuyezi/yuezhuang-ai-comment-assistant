import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { platformRestriction } from './pageSafety';
const document = (text: string) => new JSDOM(`<main>${text}</main>`).window.document;
describe('platform restriction stops', () => {
  it('recognizes the actual 300011 screen and its redirect URL', () => {
    expect(platformRestriction(document('安全限制 当前账号存在异常，请切换账号后重试 300011'), 'https://www.xiaohongshu.com/explore')).toBe('account_restricted');
    expect(platformRestriction(document(''), 'https://www.xiaohongshu.com/website-login/error?redirectPath=example')).toBe('account_restricted');
  });
  it.each([['请完成验证', 'security_challenge'], ['操作过于频繁，请稍后再试', 'platform_rate_limited'], ['访问过于频繁', 'platform_rate_limited']])('stops on %s', (text, reason) => {
    expect(platformRestriction(document(text), 'https://www.xiaohongshu.com/explore')).toBe(reason);
  });
  it('does not confuse an ordinary post with the account-error screen', () => {
    expect(platformRestriction(document('上海求租，预算1900'), 'https://www.xiaohongshu.com/explore/abc')).toBeNull();
    expect(platformRestriction(document('上海求租'), 'https://www.xiaohongshu.com/website-login')).toBe('login_required');
  });
});
