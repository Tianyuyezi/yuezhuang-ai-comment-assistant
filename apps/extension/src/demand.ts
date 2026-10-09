import { isXhsSearchPage } from './xhs';
export const DEMAND_ALARM = 'yuezhuang-find-demand';
export type DemandSource = 'home' | 'search';
export type DemandRow = {
  noteId: string; title: string; body: string; url: string; publishedRaw: string | null;
  publishedAt: string | null; publishedPrecision: 'minute' | 'day' | 'relative' | 'unknown';
  firstSeenAt: string; lastSeenAt: string; sources: Array<{ source: DemandSource; keyword: string | null }>;
  campaignId: string; campaignName: string; decision: 'match' | 'review' | 'no_match'; evidence: string[]; reason: string;
  tags: string[]; customTags: string[]; manualStatus: 'unhandled' | 'pending' | 'commented' | 'unsuitable';
  lastOpenedAt: string | null; note: string; contentCompleteness: 'text' | 'partial' | 'card'; resolutionEvidence: string | null;
  businessTemplateId?: string; businessTemplateVersion?: number;
};
export type DemandListTab = 'all' | 'unread' | 'match' | 'review' | 'viewed';

export function matchesDemandListTab(row: Pick<DemandRow, 'decision' | 'lastOpenedAt'>, tab: DemandListTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'unread') return row.lastOpenedAt === null;
  if (tab === 'viewed') return row.lastOpenedAt !== null;
  return row.lastOpenedAt === null && row.decision === tab;
}

export type DemandState = {
  status: 'stopped' | 'running' | 'paused'; runId: string | null; tabId: number | null;
  campaignId: string | null; source: DemandSource | null; keyword: string | null;
  totalRead: number; totalMatched: number; lastAdded: number; emptyBatches: number;
  failedRead: number;
  gatewayFailures: number;
  nextRunAt: string | null; reason: string;
};
export const initialDemandState: DemandState = {
  status: 'stopped', runId: null, tabId: null, campaignId: null, source: null, keyword: null,
  totalRead: 0, totalMatched: 0, lastAdded: 0, emptyBatches: 0, failedRead: 0, gatewayFailures: 0, nextRunAt: null, reason: ''
};

export function demandCardBatch<T extends { noteId: string }>(cards: T[], seen: ReadonlySet<string>, limit = 15): T[] {
  return cards.filter(card => !seen.has(card.noteId)).slice(0, limit);
}

export function nextDemandDelayMs(emptyBatches: number, random = Math.random): number {
  if (emptyBatches === 0) return 2_000 + Math.floor(random() * 2_001);
  const base = Math.min(18_000, 4_000 + emptyBatches * 2_000);
  return base + Math.floor(random() * 2_001);
}

export function isDemandPage(urlText: string, source: DemandSource, keyword: string | null): boolean {
  try {
    const url = new URL(urlText);
    if (url.hostname !== 'www.xiaohongshu.com') return false;
    return source === 'home'
      ? /^\/(?:explore)?\/?$/.test(url.pathname)
      : keyword !== null && isXhsSearchPage(urlText, keyword);
  } catch { return false; }
}

export function normalizePublished(raw: string | null, capturedAt: string): { publishedAt: string | null; precision: 'minute' | 'day' | 'relative' | 'unknown' } {
  if (!raw) return { publishedAt: null, precision: 'unknown' };
  const exact = raw.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (exact) {
    const [, year, month, day, hour, minute] = exact;
    const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${(hour ?? '00').padStart(2, '0')}:${minute ?? '00'}:00+08:00`);
    return Number.isNaN(date.getTime()) ? { publishedAt: null, precision: 'unknown' } : { publishedAt: date.toISOString(), precision: hour ? 'minute' : 'day' };
  }
  const relative = raw.match(/(\d+)\s*(分钟|小时|天)前/);
  if (relative) {
    const unit = relative[2] === '分钟' ? 60_000 : relative[2] === '小时' ? 3_600_000 : 86_400_000;
    return { publishedAt: new Date(Date.parse(capturedAt) - Number(relative[1]) * unit).toISOString(), precision: 'relative' };
  }
  return { publishedAt: null, precision: 'unknown' };
}
