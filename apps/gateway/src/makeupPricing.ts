import { campaignBusinessType, type Campaign } from '@yuezhuang/shared';

/** Service fees are quote facts, never the customer's budget filter. */
export function configuredMakeupQuote(campaign: Campaign): string | null {
  if (campaignBusinessType(campaign) !== 'makeup') return null;
  const profile = campaign.makeupProfile;
  if (!profile || profile.priceFrom === null) return null;
  return profile.priceTo === null ? `${profile.priceFrom}元起` : `${profile.priceFrom}–${profile.priceTo}元`;
}

export function guardMakeupQuote(campaign: Campaign, draft: { body: string; warnings: string[] }) {
  const quote = configuredMakeupQuote(campaign);
  if (!quote || !draft.body.trim()) return draft;
  const profile = campaign.makeupProfile!;
  // The prompt requires a canonical numeric quote. Do not let a second, spelled-out
  // amount evade the numeric check (e.g. 359元起 followed by 两百元就能上门).
  for (const match of draft.body.matchAll(/[零〇一二两三四五六七八九十百千万]+(?:\s*[-–~～至]\s*[零〇一二两三四五六七八九十百千万]+)?\s*(?:元|块|rmb)/gi)) {
    if (!profile.priceNotes.includes(match[0])) return { body: '', warnings: [...draft.warnings.slice(0, 4), '草稿金额与配置收费不一致，未自动采用。'] };
  }
  const allowed = new Set([profile.priceFrom, profile.priceTo]);
  // Explicit additional fees may only come from the configured fee notes.
  for (const match of profile.priceNotes.matchAll(/(?:[¥￥]\s*)?(\d+(?:\.\d+)?)\s*(?:元|块|[¥￥]|rmb)/gi)) allowed.add(Number(match[1]));
  for (const match of draft.body.matchAll(/(?:[¥￥]\s*)(\d+(?:\.\d+)?)|(?<![\d.])(\d+(?:\.\d+)?)(?:\s*[-–~～至]\s*(\d+(?:\.\d+)?))?\s*(?:元|块|rmb)/gi)) {
    if (match.slice(1).some(value => value !== undefined && !allowed.has(Number(value)))) {
      return { body: '', warnings: [...draft.warnings.slice(0, 4), '草稿金额与配置收费不一致，未自动采用。'] };
    }
  }
  // Keep a valid model reply, but include the actual quote if it omitted pricing.
  const body = draft.body.includes(quote) ? draft.body : `${quote}，${draft.body}`;
  return { ...draft, body };
}
