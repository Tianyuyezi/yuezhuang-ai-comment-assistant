export function platformRestriction(document: Document, href: string): string | null {
  const url = new URL(href);
  if (url.hostname !== 'www.xiaohongshu.com') return null;
  if (/^\/website-login\/error(?:\/|$)/.test(url.pathname)) return 'account_restricted';
  if (/^\/website-login(?:\/|$)/.test(url.pathname)) return 'login_required';
  const text = document.body?.innerText ?? document.body?.textContent ?? '';
  if (/安全限制/.test(text) && /当前账号存在异常|300011/.test(text)) return 'account_restricted';
  if (/安全验证|滑块验证|请完成验证|请输入验证码/.test(text)) return 'security_challenge';
  if (/操作过于频繁|操作太频繁|访问过于频繁|操作频繁[，,]|访问频繁[，,]/.test(text)) return 'platform_rate_limited';
  return null;
}
