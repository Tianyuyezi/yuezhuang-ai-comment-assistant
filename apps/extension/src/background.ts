import { assessmentSchema, businessTemplateSchema, campaignBusinessType, campaignConfigurationIssue, campaignFromBusinessTemplate, candidateEngagementPolicy, interactionBlocksFirstContact, makeupAuthorNameBlocked, noteSchema, type Assessment, type BusinessTemplate, type Campaign, type Interaction, type NoteSnapshot, type SearchCandidate } from '@yuezhuang/shared';
import { commitBusinessTemplate, loadBusinessTemplates, loadCampaign, loadInteractions, loadSearchCandidates, loadSearchTasks, saveInteraction, saveSearchCandidate, saveSearchTask } from './storage';
import { AUTO_SCAN_ALARM, initialAutoScanState, orderedCollection, scanDelayMs, type AutoScanState } from './autoScan';
import { orderedCandidates } from './candidateOrder';
import { saveSearchCandidateOrder } from './storage';
import { AUTO_MODE_ALARM, AUTO_MODE_BATCH_SIZE, AUTO_MODE_DELAY_MS, FAST_MODE_DELAY_MS, MIN_COMMENT_DELAY_MS, autoCandidateStatus, commentRecordSkipReason, recoverableCommentStop, initialAutoModeState, nextCommentDelayMs, nextModeDelayMs, type AutoModeState } from './autoMode';
import { autoTaskSource, isXhsRestrictionUrl, isXhsTaskPage, xhsNoteIdFromUrl, type AutoSource } from './xhs';
import { targetIntentIsUsable } from './noteSafety';
import { DEMAND_ALARM, demandCardBatch, initialDemandState, isDemandPage, nextDemandDelayMs, normalizePublished, type DemandState } from './demand';
import { GatewayUnavailableError, gatewayRetryDelayMs, retryableGatewayResponse } from './gatewayRecovery';
import { authorFollowKey, authorFollowSchema, type AuthorFollow } from '@yuezhuang/shared';
import { findAuthorFollow, saveAuthorFollow } from './storage';
import { EXTENSION_VERSION } from './extensionVersion';
import { connectedPageMessage } from './pageConnection';
import { publicationFailureMessage, publicationRecord, type PublicationResult } from './publicationResult';

const STATE_KEY = 'autoScanState';
const MODE_STATE_KEY = 'autoModeState';
const DEMAND_STATE_KEY = 'demandState';
const WATCHDOG_ALARM = 'yuezhuang-auto-watchdog';
const GATEWAY_URL = 'http://127.0.0.1:3417';
const DAILY_COMMENT_LIMIT = 300;
let inFlight = false;
let modeInFlight = false;
let modeStarting = false;
let demandInFlight = false;
let businessChanging = false;
let modelConfigLock: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let modeTimer: ReturnType<typeof setTimeout> | null = null;
const demandLoops = new Set<string>();
const PLATFORM_BLOCK_KEY = 'platformRestriction';
const restrictionCodes = /account_restricted|login_required|security_challenge|platform_rate_limited/;
class PlatformRestrictionError extends Error {}
class PageSessionFailure extends Error { constructor(message: string, readonly ambiguous: boolean) { super(message); } }
type PageSession = { tabId: number; source: AutoSource; keyword: string; noteId: string; runId: string };
let pageSession: PageSession | null = null;
async function releaseReturnedSession(tabId: number) {
  const session = pageSession;
  if (!session || session.tabId !== tabId || modeInFlight || modeStarting) return;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isXhsTaskPage(tab.url, session)) return;
  const result = await pageRequest<SearchResult>(tabId, { type: 'ASSISTANT_FEED_RESULTS', source: session.source, expectedKeyword: session.keyword });
  if (result.ok && result.sourceUrl && isXhsTaskPage(result.sourceUrl, session) && pageSession === session) pageSession = null;
}
const isRestriction = (error: unknown) => error instanceof PlatformRestrictionError || restrictionCodes.test(String(error));
async function pageRequest<T = any>(tabId: number, message: object): Promise<T> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url && isXhsRestrictionUrl(tab.url)) throw new PlatformRestrictionError('account_restricted');
  const result = await connectedPageMessage(tabId, message);
  if (result?.reason && restrictionCodes.test(result.reason)) throw new PlatformRestrictionError(result.reason);
  if (!result) throw new Error('页面脚本未响应，请手动刷新小红书页面后再启动；不会自动刷新或另开窗口。');
  return result as T;
}
async function checkPage(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  let url: URL;
  try { url = new URL(tab.url ?? ''); } catch { throw new Error('当前页面地址无法确认，请打开小红书正常页面。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com') throw new Error('请在当前小红书页面检查平台状态，其他页面不能解除限制锁。');
  const result = await pageRequest<{ ok: boolean; reason?: string }>(tabId, { type: 'ASSISTANT_PAGE_GUARD' });
  if (!result.ok) throw new Error(result.reason ?? '页面安全状态不可确认');
}
async function pauseForRestriction(error: unknown) {
  const reason = `检测到平台限制或登录验证，所有自动操作已暂停。请先通过平台正常处理，再点击“重新检查平台状态”：${String(error)}`.slice(0, 500);
  await chrome.storage.local.set({ [PLATFORM_BLOCK_KEY]: { reason, at: new Date().toISOString() } });
  await pause(reason); await pauseMode(reason); await pauseDemand(reason);
  return readModeState();
}
async function assertNotRestricted() {
  const stored = await chrome.storage.local.get(PLATFORM_BLOCK_KEY);
  if (stored[PLATFORM_BLOCK_KEY]) throw new Error('平台限制已锁定自动操作，请先人工处理，再点击“重新检查平台状态”。');
}
async function openSamePage(candidate: SearchCandidate, tabId: number, keyword: string, runId: string, source: AutoSource) {
  if (pageSession) throw new PageSessionFailure('上一个详情尚未关闭，停止新操作。', true);
  pageSession = { tabId, source, keyword, noteId: candidate.noteId, runId };
  const result = await pageRequest<{ ok: boolean; opened?: boolean; reason?: string; ambiguous?: boolean }>(tabId, { type: 'ASSISTANT_OPEN_NOTE', expectedSource: source, expectedKeyword: keyword, expectedNoteId: candidate.noteId });
  if (!result.ok || !result.opened) {
    if (result.ambiguous === false) pageSession = null;
    throw new PageSessionFailure(result.reason ?? '同页打开详情未确认', result.ambiguous !== false);
  }
}
async function closeSamePage(session: PageSession) {
  try {
    const blocked = await chrome.storage.local.get(PLATFORM_BLOCK_KEY);
    if (blocked[PLATFORM_BLOCK_KEY]) return; // Do not navigate away from a platform restriction screen.
    const result = await pageRequest<{ ok: boolean; sourceUrl?: string; reason?: string }>(session.tabId, { type: 'ASSISTANT_CLOSE_NOTE', expectedSource: session.source, expectedKeyword: session.keyword, expectedNoteId: session.noteId });
    if (!result.ok || !result.sourceUrl || !isXhsTaskPage(result.sourceUrl, session)) throw new PageSessionFailure(`未确认返回原列表，已停止：${result.reason ?? '页面变化'}`, true);
  } catch (error) { if (isRestriction(error)) await pauseForRestriction(error); throw error; }
  finally { if (pageSession?.runId === session.runId && pageSession.noteId === session.noteId) pageSession = null; }
}
type DemandCard = { noteId: string; url: string; title: string; snippet: string; publishedRaw?: string | null };
type DemandPageResult = { ok: boolean; reason?: string; sourceUrl?: string; scrollMoved?: boolean; results?: DemandCard[] };

async function demandPageMessage(tabId: number, message: object): Promise<DemandPageResult> {
  return pageRequest<DemandPageResult>(tabId, message);
}

async function readDemandState(): Promise<DemandState> {
  const stored = await chrome.storage.local.get(DEMAND_STATE_KEY);
  return { ...initialDemandState, ...(stored[DEMAND_STATE_KEY] as Partial<DemandState> | undefined) };
}
async function writeDemandState(state: DemandState) { await chrome.storage.local.set({ [DEMAND_STATE_KEY]: state }); return state; }
async function gatewayHealth(): Promise<{ mode?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    let response: Response;
    try { response = await fetch(`${GATEWAY_URL}/health`, { signal: controller.signal }); }
    catch { throw new GatewayUnavailableError('本机网关暂时连接失败'); }
    if (!response.ok) {
      if (response.status >= 500) throw new GatewayUnavailableError('本机网关暂时不可用');
      throw new Error(`gateway_health_http_${response.status}`);
    }
    try { return await response.json() as { mode?: string }; }
    catch { throw new GatewayUnavailableError('本机网关健康检查响应中断'); }
  } finally { clearTimeout(timeout); }
}
async function retryDemand(runId: string): Promise<DemandState> {
  const current = await readDemandState();
  if (current.status !== 'running' || current.runId !== runId) return current;
  const gatewayFailures = current.gatewayFailures + 1;
  const seconds = gatewayRetryDelayMs(gatewayFailures) / 1000;
  return writeDemandState({ ...current, gatewayFailures, nextRunAt: new Date(Date.now() + seconds * 1000).toISOString(), reason: `网关暂不可用，${seconds} 秒后自动重连；已读取记录保留。` });
}
async function pauseDemand(reason: string, runId?: string) {
  const current = await readDemandState();
  if (runId && current.runId !== runId) return current;
  await chrome.alarms.clear(DEMAND_ALARM);
  if (current.runId) await chrome.storage.local.remove(`demandSeen:${current.runId}`);
  return writeDemandState({ ...current, status: 'paused', runId: null, nextRunAt: null, reason });
}

async function runDemand(runId: string) {
  if (businessChanging || demandInFlight) return readDemandState();
  demandInFlight = true;
  try {
    let state = await readDemandState();
    if (state.status !== 'running' || state.runId !== runId || state.tabId === null || !state.source) return state;
    const campaign = await loadCampaign();
    if (!campaign.confirmedAt || campaign.id !== state.campaignId) return pauseDemand('业务画像已变化。', runId);
    await checkPage(state.tabId);
    const scan = await readState();
    if (scan.status === 'running' && scan.tabId === state.tabId) return pauseDemand('同一页面已有自动收集任务，请先停止它再找需求。', runId);
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab?.url || !isDemandPage(tab.url, state.source, state.keyword)) return pauseDemand('首页或搜索标签页已关闭、跳转。', runId);
    const health = await gatewayHealth();
    if (health.mode !== 'real') return pauseDemand('找需求需要 Real 模型网关。', runId);
    const page = await demandPageMessage(state.tabId, { type: 'DEMAND_PAGE_RESULTS' });
    if (!page.ok || !page.results?.length || !page.sourceUrl || !isDemandPage(page.sourceUrl, state.source, state.keyword)) return pauseDemand(`页面无法读取：${page.reason ?? '结构变化'}`, runId);
    const seenKey = `demandSeen:${runId}`;
    const stored = await chrome.storage.local.get(seenKey);
    const seen = new Set<string>(Array.isArray(stored[seenKey]) ? stored[seenKey] as string[] : []);
    const queue = demandCardBatch(page.results, seen);
    let added = 0;
    for (const card of queue) {
      state = await readDemandState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      const id = xhsNoteIdFromUrl(card.url);
      if (!id || card.noteId !== `xhs:${id}` || !card.title.trim()) {
        seen.add(card.noteId);
        await chrome.storage.local.set({ [seenKey]: [...seen].slice(-2000) });
        await writeDemandState({ ...state, failedRead: state.failedRead + 1, reason: `跳过异常卡片 ${card.noteId}` });
        continue;
      }
      const capturedAt = new Date().toISOString();
      const note: NoteSnapshot = { id: card.noteId, title: card.title.trim(), body: card.snippet.trim() || card.title.trim(), source: 'xhs', capturedAt, completeness: 'partial' };
      const assessment = await gatewayRequest<{ decision: 'match' | 'review' | 'no_match'; evidence: string[]; reason: string; tags: string[]; promptVersion: string }>('/v1/demand/analyze', { campaign, note, inputScope: 'card' });
      const decision = assessment.decision;
      state = await readDemandState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (decision !== 'no_match') {
        const date = normalizePublished(card.publishedRaw ?? null, note.capturedAt);
        await gatewayRequest('/v1/demand/records', {
          noteId: note.id, title: note.title, body: note.body, url: card.url,
          publishedRaw: card.publishedRaw ?? null, publishedAt: date.publishedAt, publishedPrecision: date.precision,
          source: state.source, keyword: state.keyword, campaignId: campaign.id, campaignName: campaign.name,
          businessTemplateId: campaign.businessTemplateId, businessTemplateVersion: campaign.businessTemplateVersion,
          decision, evidence: assessment.evidence, reason: assessment.reason,
          tags: [...assessment.tags, '仅卡片信息'],
          promptVersion: assessment.promptVersion, contentCompleteness: 'card',
          resolutionEvidence: null
        });
        added += Number(decision === 'match');
      }
      state = await readDemandState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      seen.add(card.noteId);
      await chrome.storage.local.set({ [seenKey]: [...seen].slice(-2000) });
      await writeDemandState({ ...state, totalRead: state.totalRead + 1, totalMatched: state.totalMatched + Number(decision === 'match'), lastAdded: added });
    }
    state = await readDemandState();
    if (state.status !== 'running' || state.runId !== runId) return state;
    // Drain already loaded cards before scrolling, otherwise virtualized feeds can discard unprocessed cards.
    const remaining = page.results.some(item => !seen.has(item.noteId));
    if (!remaining) {
      const scrolled = await demandPageMessage(state.tabId!, { type: 'DEMAND_SCROLL', source: state.source, expectedKeyword: state.keyword });
      if (!scrolled.ok) return pauseDemand(`滚动或读取失败：${scrolled.reason ?? '未知'}`, runId);
    }
    state = await readDemandState();
    if (state.status !== 'running' || state.runId !== runId) return state;
    const emptyBatches = queue.length ? 0 : state.emptyBatches + 1;
    const nextRunAt = new Date(Date.now() + nextDemandDelayMs(emptyBatches)).toISOString();
    return writeDemandState({ ...state, lastAdded: added, emptyBatches, gatewayFailures: 0, nextRunAt, reason: queue.length ? '' : '暂时没有新卡片；短暂停顿后继续下拉。' });
  } catch (error) {
    if (isRestriction(error)) { await pauseForRestriction(error); return readDemandState(); }
    if (error instanceof GatewayUnavailableError) return retryDemand(runId);
    return pauseDemand(`找需求已暂停：${String(error)}`, runId);
  }
  finally { demandInFlight = false; }
}

async function demandLoop(runId: string) {
  if (demandLoops.has(runId)) return;
  demandLoops.add(runId);
  try {
    while (true) {
      let state = await readDemandState();
      if (state.status !== 'running' || state.runId !== runId) return;
      const delay = state.nextRunAt ? Math.max(0, Date.parse(state.nextRunAt) - Date.now()) : 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      state = await readDemandState();
      if (state.status !== 'running' || state.runId !== runId) return;
      state = await runDemand(runId);
      if (state.status !== 'running' || state.runId !== runId) return;
    }
  } finally { demandLoops.delete(runId); }
}

async function startDemand(tabId: number, source: 'home' | 'search', keyword: string | null) {
  await assertNotRestricted();
  try { await checkPage(tabId); } catch (error) { if (isRestriction(error)) await pauseForRestriction(error); throw error; }
  const scan = await readState();
  if (scan.status === 'running' && scan.tabId === tabId) throw new Error('同页自动收集正在运行，请先停止再开始找需求。');
  if (businessChanging) throw new Error('业务模板正在更新，请稍候。');
  if (demandInFlight) throw new Error('上一轮找需求尚未结束');
  const current = await readDemandState();
  if (current.status === 'running') throw new Error('找需求已经在运行');
  const campaign = await loadCampaign();
  if (!campaign.confirmedAt || !targetIntentIsUsable(campaign.targetIntent)) throw new Error('请先确认业务画像');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isDemandPage(tab.url, source, keyword)) throw new Error('请在对应的小红书首页或搜索页启动');
  let waitingForGateway = false;
  try {
    const health = await gatewayHealth();
    if (health.mode !== 'real') throw new Error('请先启动 Real 模型网关');
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError)) throw error;
    waitingForGateway = true;
  }
  await chrome.alarms.clear(DEMAND_ALARM);
  const state = await writeDemandState({ ...initialDemandState, status: 'running', runId: crypto.randomUUID(), tabId, campaignId: campaign.id, source, keyword,
    gatewayFailures: Number(waitingForGateway), nextRunAt: waitingForGateway ? new Date(Date.now() + gatewayRetryDelayMs(1)).toISOString() : null,
    reason: waitingForGateway ? '网关暂不可用，15 秒后自动重连；不会读取或评论帖子。' : '' });
  // The alarm recovers a suspended MV3 worker; the in-memory loop controls the normal pace.
  await chrome.alarms.create(DEMAND_ALARM, { periodInMinutes: 0.5 });
  void demandLoop(state.runId!);
  return state;
}

async function stopDemand() {
  await chrome.alarms.clear(DEMAND_ALARM);
  const state = await readDemandState();
  if (state.runId) await chrome.storage.local.remove(`demandSeen:${state.runId}`);
  return writeDemandState({ ...state, status: 'stopped', runId: null, nextRunAt: null, reason: '已由用户停止。' });
}
type SearchResult = {
  ok: boolean; reason?: string; sourceUrl?: string; scrollMoved?: boolean;
  results?: Array<{ noteId: string; url: string; title: string; snippet: string }>;
};

async function readState(): Promise<AutoScanState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...initialAutoScanState, ...(stored[STATE_KEY] as Partial<AutoScanState> | undefined) };
}

async function writeState(state: AutoScanState) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

async function readModeState(): Promise<AutoModeState> {
  const stored = await chrome.storage.local.get(MODE_STATE_KEY);
  return { ...initialAutoModeState, ...(stored[MODE_STATE_KEY] as Partial<AutoModeState> | undefined) };
}

async function writeModeState(state: AutoModeState) {
  await chrome.storage.local.set({ [MODE_STATE_KEY]: state });
  return state;
}

async function scheduleScan(state: AutoScanState) {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  if (state.status !== 'running' || !state.runId || !state.nextRunAt) return;
  const when = Date.parse(state.nextRunAt);
  // Chrome alarms recover a suspended service worker; the short in-memory timer keeps fast mode responsive.
  await chrome.alarms.create(AUTO_SCAN_ALARM, { when: state.paceEnabled ? when : Math.max(when, Date.now() + 30_000) });
  if (!state.paceEnabled) scanTimer = setTimeout(() => { void runScan(state.runId!); }, Math.max(0, when - Date.now()));
}

async function scheduleMode(state: AutoModeState) {
  if (modeTimer) clearTimeout(modeTimer);
  modeTimer = null;
  if (state.status !== 'running' || !state.runId || !state.nextRunAt) return;
  const when = Date.parse(state.nextRunAt);
  await chrome.alarms.create(AUTO_MODE_ALARM, { when: state.paceEnabled ? when : Math.max(when, Date.now() + 30_000) });
  if (!state.paceEnabled) modeTimer = setTimeout(() => { void runMode(state.runId!); }, Math.max(0, when - Date.now()));
}

async function retryMode(runId: string): Promise<AutoModeState> {
  const current = await readModeState();
  if (current.status !== 'running' || current.runId !== runId) return current;
  const gatewayFailures = current.gatewayFailures + 1;
  const seconds = gatewayRetryDelayMs(gatewayFailures) / 1000;
  const updated = await writeModeState({ ...current, gatewayFailures, nextRunAt: new Date(Date.now() + seconds * 1000).toISOString(), reason: `网关暂不可用，${seconds} 秒后自动重连；不会重复发送结果不明的评论。` });
  await scheduleMode(updated);
  return updated;
}

async function pauseMode(reason: string, runId?: string) {
  const state = await readModeState();
  if (runId && state.runId !== runId) return state;
  await chrome.alarms.clear(AUTO_MODE_ALARM);
  if (modeTimer) clearTimeout(modeTimer);
  modeTimer = null;
  return writeModeState({ ...state, status: 'paused', nextRunAt: null, reason });
}

async function pause(reason: string, runId?: string) {
  const state = await readState();
  if (runId && state.runId !== runId) return state;
  await chrome.alarms.clear(AUTO_SCAN_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  const mode = await readModeState();
  if (mode.status === 'running' && mode.taskId === state.taskId) await pauseMode(`自动收集暂停：${reason}`);
  return writeState({ ...state, status: 'paused', nextRunAt: null, reason });
}

async function gatewayRequest<T>(path: string, body: unknown): Promise<T> {
  const session = await chrome.storage.session.get('gatewayPairingToken');
  const token = String(session.gatewayPairingToken ?? '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${GATEWAY_URL}${path}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(token && !/^sk-/i.test(token) ? { 'x-yuezhuang-pairing-token': token } : {}) },
        body: JSON.stringify(body)
      });
    } catch { throw new GatewayUnavailableError('本机网关连接中断或请求超时'); }
    let data: T & { error?: string };
    try { data = await response.json() as T & { error?: string }; }
    catch { throw new GatewayUnavailableError('网关响应中断'); }
    if (!response.ok) {
      const error = data.error ?? `gateway_http_${response.status}`;
      if (retryableGatewayResponse(response.status, error)) throw new GatewayUnavailableError('网关上游暂时不可用');
      throw new Error(error);
    }
    return data;
  } finally { clearTimeout(timeout); }
}

async function readCandidateNote(candidate: SearchCandidate, tabId: number): Promise<NoteSnapshot> {
  if (!xhsNoteIdFromUrl(candidate.url) || candidate.noteId !== `xhs:${xhsNoteIdFromUrl(candidate.url)}`) throw new Error('候选 URL 与帖子 ID 不匹配');
    let partial: NoteSnapshot | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) throw new Error('帖子标签页已关闭');
      if (!current.url) continue;
      if (isXhsRestrictionUrl(current.url)) throw new PlatformRestrictionError('account_restricted');
      if (xhsNoteIdFromUrl(current.url) !== xhsNoteIdFromUrl(candidate.url)) throw new Error('帖子标签页跳转到了其他页面');
      if (current.status !== 'complete') continue;
      try {
        const result = await pageRequest<{ ok: boolean; reason?: string; note?: NoteSnapshot }>(tabId, { type: 'ASSISTANT_READ_NOTE' });
        if (!result.ok && result.reason === 'security_challenge') throw new Error('security_challenge');
        if (result.ok && result.note?.id === candidate.noteId) {
          const note = noteSchema.parse(result.note);
          if (note.completeness === 'complete' || note.resolutionEvidence) return note;
          partial = note;
        }
      } catch (error) {
        if (isRestriction(error)) throw error;
        /* 内容脚本可能尚未注入，继续有界重试。 */
      }
    }
    if (partial) return partial;
    throw new Error('帖子内容未能可靠读取');
}

class JobCancelled extends Error {}

class CommentPolicyDenied extends Error {}
class PublicationUncertain extends Error {
  constructor(message: string, readonly skipAndContinue = false) { super(message); }
}
async function publishCandidate(candidate: SearchCandidate, note: NoteSnapshot, draft: string, campaign: Campaign, assessment: Assessment, canProceed: () => Promise<boolean>, tabId: number): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (current?.url && isXhsRestrictionUrl(current.url)) throw new PlatformRestrictionError('account_restricted');
      if (!current?.url || xhsNoteIdFromUrl(current.url) !== xhsNoteIdFromUrl(candidate.url)) throw new Error('评论标签页已关闭或跳转');
      if (current.status !== 'complete') continue;
      let latest: { ok: boolean; note?: NoteSnapshot };
      try { latest = await pageRequest(tabId, { type: 'ASSISTANT_READ_NOTE' }); }
      catch (error) { if (isRestriction(error)) throw error; continue; }
      if (!latest.ok || !latest.note || latest.note.id !== note.id) continue;
      if (latest.note.title !== note.title || latest.note.body !== note.body || latest.note.resolutionEvidence) throw new Error('发送前笔记内容或需求状态已变化');
      if (latest.note.completeness !== 'complete') continue;
      const policy = candidateEngagementPolicy(campaign, latest.note, assessment);
      if (!policy.canComment) throw new CommentPolicyDenied(policy.reason || '当前帖不允许评论。');
      if (!(await canProceed())) throw new JobCancelled('任务已停止，未发送评论。');
      const interaction: Interaction = {
        id: crypto.randomUUID(), noteId: note.id, noteHash: `${note.title}:${note.body}`.slice(0, 200),
        accountLabel: campaign.accountLabel, templateId: null, templateVersion: null, body: draft, status: 'unknown',
        businessTemplateId: campaign.businessTemplateId, businessTemplateName: campaign.name, businessTemplateVersion: campaign.businessTemplateVersion,
        source: 'xhs', createdAt: new Date().toISOString(), markedPublishedAt: null
      };
      await saveInteraction(interaction);
      if (!(await canProceed())) {
        await saveInteraction({ ...interaction, status: 'generated' });
        throw new JobCancelled('任务已停止，未发送评论。');
      }
      let result: PublicationResult;
      try { result = await pageRequest(tabId, { type: 'ASSISTANT_PUBLISH', expectedNoteId: note.id, expectedTitle: note.title, expectedBody: note.body, text: draft }); }
      catch (error) {
        await saveInteraction({ ...interaction, publicationCheckedAt: new Date().toISOString(), publicationReason: '发送请求响应丢失，结果不明；防重锁保留。' });
        if (isRestriction(error)) throw error;
        throw new PublicationUncertain('发送请求响应丢失，防重锁保留；跳过本帖，不能自动重发。', true);
      }
      await saveInteraction(publicationRecord(interaction, result));
      if (!result.ok || !result.published) {
        const reason = publicationFailureMessage(result.reason ?? '评论发送未得到页面确认');
        if (result.ambiguous === false) throw new CommentPolicyDenied(reason);
        throw new PublicationUncertain(reason, result.reason === 'send_clicked_but_publication_unverified');
      }
      return !result.alreadyPublished;
    }
    throw new Error('评论标签页未就绪');
}

async function recheckPublication(interactionId: string, tabId: number) {
  if (modeStarting || modeInFlight || inFlight || demandInFlight || (await readModeState()).status === 'running') throw new Error('请先停止自动任务，再只读核对评论。');
  const interaction = (await loadInteractions()).find(item => item.id === interactionId);
  if (!interaction || interaction.status !== 'unknown' || interaction.source !== 'xhs') throw new Error('没有需要核对的真实评论未知记录。');
  const campaign = await loadCampaign();
  if (interaction.accountLabel !== campaign.accountLabel) throw new Error('当前运营账号与记录不一致，防重锁保留。');
  const candidates = (await loadSearchCandidates()).filter(item => item.noteId === interaction.noteId && item.note && `${item.note.title}:${item.note.body}`.slice(0, 200) === interaction.noteHash);
  const note = candidates[0]?.note;
  if (!note) throw new Error('缺少原帖内容快照，不能自动核对；请人工查看原帖，防重锁保留。');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || !tab.url || `xhs:${xhsNoteIdFromUrl(tab.url)}` !== interaction.noteId) throw new Error('请先在当前页面打开这条原帖；核对不会导航或再次发送。');
  modeInFlight = true; // Read-only observation must not race a new Auto run or collection.
  try {
    await checkPage(tabId);
    const probe = () => pageRequest<PublicationResult>(tabId, { type: 'ASSISTANT_PUBLICATION_STATE', expectedNoteId: note.id, expectedTitle: note.title, expectedBody: note.body, text: interaction.body, expectedSenderId: interaction.publicationSenderId });
    let result = await probe();
    if (result.ok && result.published && (!result.senderId || !/^[a-f0-9]{24}$/i.test(result.senderId) || interaction.publicationSenderId && result.senderId !== interaction.publicationSenderId)) {
      result = { ...result, ok: false, published: false, reason: 'comment_sender_identity_unverified' };
    }
    if (result.ok && result.published) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const second = await probe();
      if (second.senderId !== result.senderId || second.commentId !== result.commentId) result = { ...second, published: false, reason: '两次评论观察不一致，防重锁保留。' };
      else result = second;
    }
    const checked = publicationRecord(interaction, { ...result, ambiguous: true, alreadyPublished: true });
    // Reconciliation proves existence, not a new send; do not move its daily-limit timestamp to today.
    if (checked.status === 'marked_published') checked.markedPublishedAt = interaction.createdAt;
    else checked.publicationReason = publicationFailureMessage(result.reason ?? '当前已加载评论中未确认同文评论；不代表未发布，防重锁保留。');
    await saveInteraction(checked);
    if (checked.status === 'marked_published') {
      for (const item of candidates) if (['needs_review', 'skipped'].includes(item.status) && item.draft === interaction.body && /^(自动评论已停止|评论结果不明|评论未确认，已跳过|已保留评论防重锁)：/.test(item.reason)) {
        await saveSearchCandidate({ ...item, status: 'published', reason: '只读核对确认当前账号的同文评论存在；没有再次发送。' });
      }
    }
    return { confirmed: checked.status === 'marked_published', interaction: checked, diagnostic: result.diagnostic,
      notice: checked.status === 'marked_published' ? '已确认当前账号的同文评论存在，没有再次发送。Auto 不会自动恢复；请关闭详情回原列表后手动启动。' : checked.publicationReason };
  } catch (error) { if (isRestriction(error)) await pauseForRestriction(error); throw error; }
  finally { modeInFlight = false; }
}

class LikeFailure extends Error {
  constructor(message: string, readonly ambiguous: boolean) { super(message); }
}
async function likeCandidate(candidate: SearchCandidate, note: NoteSnapshot, canProceed: () => Promise<boolean>, tabId: number, readOnly = false): Promise<'liked' | 'already_liked'> {
  let sent = false;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (current?.url && isXhsRestrictionUrl(current.url)) throw new PlatformRestrictionError('account_restricted');
      if (!current?.url || xhsNoteIdFromUrl(current.url) !== xhsNoteIdFromUrl(candidate.url)) throw new Error('点赞标签页已关闭或跳转');
      if (current.status !== 'complete') continue;
      let latest: { ok: boolean; note?: NoteSnapshot; reason?: string };
      try { latest = await pageRequest(tabId, { type: 'ASSISTANT_READ_NOTE' }); }
      catch (error) { if (isRestriction(error)) throw error; continue; }
      if (latest.reason === 'security_challenge') throw new LikeFailure(latest.reason, false);
      if (!latest.ok || !latest.note || latest.note.id !== note.id) continue;
      if (latest.note.title !== note.title || latest.note.body !== note.body || latest.note.resolutionEvidence) throw new Error('点赞前笔记内容或需求状态已变化');
      if (latest.note.completeness !== 'complete') continue;
      if (!(await canProceed())) throw new JobCancelled('任务已停止，未点赞。');
      const expected = { expectedNoteId: note.id, expectedTitle: note.title, expectedBody: note.body };
      let failureReason = '点赞未得到页面确认';
      if (!readOnly) {
        sent = true;
        try {
          const result = await pageRequest<{ ok: boolean; liked?: boolean; alreadyLiked?: boolean; reason?: string; ambiguous?: boolean }>(tabId, { type: 'ASSISTANT_LIKE', ...expected });
          if (result.ok && result.liked) return result.alreadyLiked ? 'already_liked' : 'liked';
          failureReason = result.reason ?? failureReason;
          if (result.ambiguous === false || /security_challenge/.test(failureReason)) throw new LikeFailure(failureReason, result.ambiguous === true);
        } catch (error) {
          if (error instanceof LikeFailure || isRestriction(error)) throw error;
          failureReason = String(error);
        }
      }
      // These messages only inspect. Never send a second toggle after an uncertain click.
      let confirmations = 0;
      for (let check = 0; check < 4; check += 1) {
        await new Promise(resolve => setTimeout(resolve, 600));
        if (!(await canProceed())) throw new JobCancelled('任务已停止，不再检查点赞。');
        const current = await chrome.tabs.get(tabId).catch(() => null);
        if (current?.url && isXhsRestrictionUrl(current.url)) throw new PlatformRestrictionError('account_restricted');
        if (!current?.url || xhsNoteIdFromUrl(current.url) !== xhsNoteIdFromUrl(candidate.url)) break;
        try {
          const observed = await pageRequest<{ ok: boolean; liked?: boolean; reason?: string }>(tabId, { type: 'ASSISTANT_LIKE_STATE', ...expected });
          if (/security_challenge/.test(observed.reason ?? '')) throw new LikeFailure(observed.reason!, sent);
          confirmations = observed.ok && observed.liked === true ? confirmations + 1 : 0;
          if (confirmations >= 2) return readOnly ? 'already_liked' : 'liked';
        } catch (error) { if (error instanceof LikeFailure || isRestriction(error)) throw error; confirmations = 0; }
      }
      throw new LikeFailure(readOnly ? '上次点赞结果仍未确认，已锁定本帖点赞，不重复点击。' : failureReason, readOnly || sent);
    }
    throw new Error('点赞标签页未就绪');
  } catch (error) {
    if (error instanceof JobCancelled || error instanceof LikeFailure || isRestriction(error)) throw error;
    throw new LikeFailure(String(error), sent || readOnly);
  }
}

class FollowFailure extends Error {
  constructor(message: string, readonly ambiguous: boolean, readonly record?: AuthorFollow) { super(message); }
}
type FollowResult = { record: AuthorFollow; status: 'followed' | 'already_following' | 'skipped'; reason: string };
async function followCandidate(candidate: SearchCandidate, note: NoteSnapshot, campaign: Campaign, canProceed: () => Promise<boolean>, tabId: number): Promise<FollowResult> {
  if (!(await canProceed())) throw new JobCancelled('任务已停止，未关注。');
  let record: AuthorFollow | undefined;
  let sent = false;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (!(await canProceed())) throw new JobCancelled('任务已停止，未关注。');
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (current?.url && isXhsRestrictionUrl(current.url)) throw new PlatformRestrictionError('account_restricted');
      if (!current?.url || xhsNoteIdFromUrl(current.url) !== xhsNoteIdFromUrl(candidate.url)) throw new Error('关注标签页已关闭或跳转');
      if (current.status !== 'complete') continue;
      const expected = { expectedNoteId: note.id, expectedTitle: note.title, expectedBody: note.body };
      const target = await pageRequest<{ ok: boolean; authorId?: string; authorName?: string; authorUrl?: string; following?: boolean; reason?: string }>(tabId, { type: 'ASSISTANT_AUTHOR_FOLLOW_STATE', ...expected });
      if (!target.ok) throw new Error(target.reason ?? '未能核验原帖作者');
      if (typeof target.following !== 'boolean' || !target.authorId || target.authorUrl !== `https://www.xiaohongshu.com/user/profile/${target.authorId}`) throw new Error('原帖作者身份未核验');
      if (campaignBusinessType(campaign) === 'makeup' && (!target.authorName?.trim() || makeupAuthorNameBlocked(target.authorName))) throw new FollowFailure('原帖作者名称无法核验或含“妆”，不关注。', false);
      const previous = await findAuthorFollow(campaign.accountLabel, target.authorId);
      const now = new Date().toISOString();
      record = authorFollowSchema.parse({
        id: authorFollowKey(campaign.accountLabel, target.authorId), accountLabel: campaign.accountLabel,
        authorId: target.authorId, authorName: target.authorName ?? '', authorUrl: target.authorUrl, noteId: note.id,
        businessTemplateId: campaign.businessTemplateId, businessTemplateName: campaign.name, businessTemplateVersion: campaign.businessTemplateVersion,
        status: 'pending', createdAt: previous?.createdAt ?? now, updatedAt: now, reason: '关注操作准备中'
      });
      if (target.following) {
        record = { ...record, status: 'already_following', reason: '原帖作者已关注，未重复点击。' };
        await saveAuthorFollow(record);
        return { record, status: 'already_following', reason: record.reason };
      }
      if (previous && ['pending', 'unknown'].includes(previous.status)) throw new FollowFailure('此作者上次关注结果不明，需核对后再运行。', true, previous);
      if (previous && ['followed', 'already_following'].includes(previous.status)) {
        return { record: previous, status: 'skipped', reason: '本机已有此作者的成功关注记录，未重复操作。' };
      }
      if (!(await canProceed())) throw new JobCancelled('任务已停止，未关注。');
      await saveAuthorFollow(record);
      if (!(await canProceed())) {
        await saveAuthorFollow({ ...record, status: 'cancelled', updatedAt: new Date().toISOString(), reason: '任务停止，未点击关注。' });
        throw new JobCancelled('任务已停止，未关注。');
      }
      sent = true;
      const result = await pageRequest<{ ok: boolean; authorId?: string; followed?: boolean; alreadyFollowing?: boolean; ambiguous?: boolean; reason?: string }>(tabId, { type: 'ASSISTANT_FOLLOW', ...expected, expectedAuthorId: target.authorId });
      if (!result.ok || !result.followed || result.authorId !== target.authorId) {
        if (!result.ok && result.ambiguous === false) {
          await saveAuthorFollow({ ...record, status: 'cancelled', updatedAt: new Date().toISOString(), reason: result.reason ?? '页面未执行关注。' });
          throw new FollowFailure(result.reason ?? '页面未执行关注。', false, record);
        }
        throw new Error(result.reason ?? '关注未得到页面确认');
      }
      record = { ...record, status: result.alreadyFollowing ? 'already_following' : 'followed', updatedAt: new Date().toISOString(), reason: result.alreadyFollowing ? '原帖作者已关注，未重复点击。' : '原帖作者关注状态已在页面确认。' };
      await saveAuthorFollow(record);
      return { record, status: result.alreadyFollowing ? 'already_following' : 'followed', reason: record.reason };
    }
    throw new Error('关注标签页未就绪');
  } catch (error) {
    if (error instanceof JobCancelled || error instanceof FollowFailure) throw error;
    const reason = String(error).slice(0, 500);
    if (sent && record) {
      record = { ...record, status: 'unknown', updatedAt: new Date().toISOString(), reason };
      await saveAuthorFollow(record);
    }
    if (isRestriction(error)) throw error;
    throw new FollowFailure(reason, sent, record);
  }
}

async function reachedDailyLimit(accountLabel: string): Promise<boolean> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const interactions = await loadInteractions();
  return interactions.filter(item => item.accountLabel === accountLabel && item.status === 'marked_published' &&
    new Date(item.markedPublishedAt ?? item.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === today).length >= DAILY_COMMENT_LIMIT;
}

const commentCooldownKey = (accountLabel: string) => `nextAutoCommentAt:${encodeURIComponent(accountLabel)}`;

async function nextAllowedCommentAt(accountLabel: string): Promise<number> {
  const key = commentCooldownKey(accountLabel);
  const stored = await chrome.storage.local.get(key);
  const saved = Number(stored[key] ?? 0);
  const recent = (await loadInteractions())
    .filter(item => item.accountLabel === accountLabel && ['marked_published', 'unknown'].includes(item.status))
    .map(item => Date.parse(item.markedPublishedAt ?? item.createdAt))
    .filter(Number.isFinite);
  return Math.max(Number.isFinite(saved) ? saved : 0, ...recent.map(time => time + MIN_COMMENT_DELAY_MS), 0);
}

async function runMode(runId: string) {
  if (businessChanging || modeInFlight) return readModeState();
  modeInFlight = true;
  try {
    let state = await readModeState();
    if (state.status !== 'running' || state.runId !== runId || !state.taskId) return state;
    if (inFlight) {
      const updated = await writeModeState({ ...state, nextRunAt: new Date(Date.now() + 2_000).toISOString(), reason: '同页收集正在结束，随后处理下一帖。' });
      await scheduleMode(updated); return updated;
    }
    const scan = await readState();
    const task = (await loadSearchTasks()).find(item => item.id === state.taskId);
    const campaign = await loadCampaign();
    if (!task || !campaign.confirmedAt || campaignConfigurationIssue(campaign) || !targetIntentIsUsable(campaign.targetIntent) || task.campaignId !== campaign.id || scan.status !== 'running' || scan.taskId !== task.id || scan.tabId === null) return pauseMode('浏览任务、业务资料或自动收集已变化。请检查配置。', runId);
    const pageTabId = scan.tabId;
    await checkPage(pageTabId);
    const searchTab = scan.tabId === null ? null : await chrome.tabs.get(scan.tabId).catch(() => null);
    if (!searchTab?.url || !isXhsTaskPage(searchTab.url, task) || searchTab.active === false) return pauseMode('任务标签页已关闭、不再活动或离开对应首页/搜索列表。', runId);
    const health = await gatewayHealth();
    if (health.mode !== 'real') return pauseMode('网关不是 Real 模式，自动分析已暂停。', runId);
    if (state.publishEnabled && state.paceEnabled) {
      const nextAllowed = await nextAllowedCommentAt(campaign.accountLabel);
      if (nextAllowed > Date.now()) {
        const nextRunAt = new Date(nextAllowed).toISOString();
        const updated = await writeModeState({ ...state, nextRunAt, reason: '等待同一账号的 3–5 分钟评论间隔。' });
        await scheduleMode(updated);
        return updated;
      }
    }
    const queue = orderedCandidates((await loadSearchCandidates()).filter(item => item.taskId === task.id && item.status === 'new')).slice(0, AUTO_MODE_BATCH_SIZE);
    let publishedThisRun = false;
    for (const candidate of queue) {
      const canInteract = async () => {
        const current = await readModeState();
        const tab = await chrome.tabs.get(pageTabId).catch(() => null);
        if (!tab || tab.active === false) { await pauseMode('当前任务标签页已关闭或不再活动，Auto 暂停。', runId); return false; }
        return !businessChanging && current.status === 'running' && current.runId === runId && (await loadCampaign()).id === campaign.id;
      };
      const stillCurrent = async () => {
        const latestCampaign = await loadCampaign();
        if (latestCampaign.id !== campaign.id || latestCampaign.confirmedAt !== campaign.confirmedAt) throw new Error('业务画像已变化');
        return (await loadSearchCandidates()).some(item => item.id === candidate.id && item.status === 'new');
      };
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (!(await stillCurrent())) continue;
      const duplicateReason = commentRecordSkipReason(await loadInteractions(), candidate.noteId, campaign.accountLabel);
      if (duplicateReason) {
        await saveSearchCandidate({ ...candidate, status: 'skipped', reason: duplicateReason });
        await writeModeState({ ...state, skipped: state.skipped + 1, currentCandidate: { noteId: candidate.noteId, title: candidate.title, listOrder: candidate.listOrder ?? null, stage: '已跳过（防重）', reason: duplicateReason } });
        continue; // No model, detail navigation or interaction for this already handled post.
      }
      state = await writeModeState({ ...state, currentCandidate: { noteId: candidate.noteId, title: candidate.title, listOrder: candidate.listOrder ?? null, stage: '标题初筛', reason: '' } });
      const titleScreen = await gatewayRequest<{ decision: 'inspect' | 'reject'; reason: string; promptVersion: string }>('/v1/candidate/title-screen', { campaign, title: candidate.title, snippet: candidate.snippet });
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (titleScreen.decision === 'reject') {
        await saveSearchCandidate({ ...candidate, status: 'skipped', reason: `标题筛选：${titleScreen.reason}`.slice(0, 500), promptVersion: titleScreen.promptVersion });
        await writeModeState({ ...state, analyzed: state.analyzed + 1, skipped: state.skipped + 1, currentCandidate: { ...state.currentCandidate!, stage: '已跳过（未打开详情）', reason: titleScreen.reason } });
        continue;
      }
      state = await writeModeState({ ...state, currentCandidate: { ...state.currentCandidate!, stage: '读取详情', reason: '' } });
      let retainUncertainDetail = false;
      let newlyPublished = false;
      try {
      let note: NoteSnapshot;
      try {
        if (!(await canInteract())) return readModeState();
        await openSamePage(candidate, pageTabId, task.keyword, runId, autoTaskSource(task));
        note = await readCandidateNote(candidate, pageTabId);
      }
      catch (error) {
        if (isRestriction(error)) return await pauseForRestriction(error);
        if (error instanceof PageSessionFailure && error.ambiguous) throw error;
        state = await readModeState();
        if (state.status !== 'running' || state.runId !== runId) return state;
        if (!(await stillCurrent())) continue;
        await saveSearchCandidate({ ...candidate, status: 'skipped', reason: `详情无法可靠读取，自动跳过：${String(error)}`.slice(0, 500) });
        await writeModeState({ ...state, analyzed: state.analyzed + 1, skipped: state.skipped + 1, reason: '部分帖子无法可靠读取，已跳过。', currentCandidate: { ...state.currentCandidate!, stage: '已跳过', reason: '详情无法可靠读取' } });
        continue;
      }
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (!(await stillCurrent())) continue;
      const commentAlreadyHandled = interactionBlocksFirstContact(await loadInteractions(), candidate.noteId, campaign.accountLabel);
      if (note.resolutionEvidence) {
        await saveSearchCandidate({ ...candidate, note, status: 'skipped', reason: `原帖或评论显示需求已解决：${note.resolutionEvidence}`.slice(0, 500) });
        await writeModeState({ ...state, analyzed: state.analyzed + 1, skipped: state.skipped + 1, currentCandidate: { ...state.currentCandidate!, stage: '已跳过', reason: '需求已解决' } });
        continue;
      }
      const response = await gatewayRequest<Assessment & { promptVersion?: string; decisionSource?: 'model' | 'safety_rule' }>('/v1/candidate/analyze', { campaign, note });
      const assessment = assessmentSchema.parse(response);
      const policy = candidateEngagementPolicy(campaign, note, assessment);
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      state = await writeModeState({ ...state, currentCandidate: { ...state.currentCandidate!, stage: '按匹配结果处理', reason: policy.reason } });
      const status = autoCandidateStatus(note, assessment);
      const reason = `${response.decisionSource === 'safety_rule' ? '安全规则' : '模型判断'}：${assessment.reason}；${policy.reason ? `${policy.reason}；` : ''}证据：${assessment.evidence.join('、') || '无'}；${note.completeness === 'complete' ? '文本已核验' : '内容不完整，已跳过'}`.slice(0, 500);
      let updated: SearchCandidate = { ...candidate, note, authorName: note.authorName ?? candidate.authorName, status: policy.canComment ? status : 'skipped', reason, promptVersion: response.promptVersion ?? null, assessment: { ...assessment, engagementPolicy: policy } };
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (!(await stillCurrent())) continue;
      if (policy.canFollow && state.followEnabled) {
        if (['pending', 'unknown'].includes(updated.followStatus)) {
          await saveSearchCandidate({ ...updated, status: 'needs_review', followStatus: 'unknown', reason: '上次关注结果不明，需核对原帖作者。' });
          return pauseMode('关注结果不明，已停机防重。', runId);
        }
        if (updated.followStatus === 'none' || updated.followStatus === 'unavailable') {
          await saveSearchCandidate({ ...updated, status: 'new', followStatus: 'pending' });
          try {
            const result = await followCandidate(candidate, note, campaign, canInteract, pageTabId);
            updated = { ...updated, authorId: result.record.authorId, authorName: result.record.authorName, authorUrl: result.record.authorUrl, followStatus: result.status, followedAt: result.status === 'skipped' ? null : result.record.updatedAt, followReason: result.reason };
            await saveSearchCandidate({ ...updated, status: 'new' });
            const current = await readModeState();
            await writeModeState({ ...current, followed: current.followed + Number(result.status === 'followed') });
          } catch (error) {
            if (isRestriction(error)) return await pauseForRestriction(error);
            if (error instanceof JobCancelled) { await saveSearchCandidate({ ...updated, status: 'new', followStatus: 'none' }); return readModeState(); }
            const ambiguous = !(error instanceof FollowFailure) || error.ambiguous;
            const record = error instanceof FollowFailure ? error.record : undefined;
            updated = { ...updated, authorId: record?.authorId ?? updated.authorId, authorName: record?.authorName ?? updated.authorName, authorUrl: record?.authorUrl ?? updated.authorUrl,
              followStatus: ambiguous ? 'unknown' : 'unavailable', followReason: String(error).slice(0, 500) };
            if (ambiguous || /security_challenge/.test(String(error))) {
              await saveSearchCandidate({ ...updated, status: 'needs_review', reason: `自动关注已停止：${String(error)}`.slice(0, 500) });
              const current = await readModeState();
              await writeModeState({ ...current, analyzed: current.analyzed + 1, needsReview: current.needsReview + 1 });
              return pauseMode(`关注未获可靠确认，已停机：${String(error)}`, runId);
            }
            // An unavailable control before any click is safe to skip; likes/comments remain independent.
            await saveSearchCandidate({ ...updated, status: 'new' });
          }
        }
      }
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (policy.canLike && state.likeEnabled) {
        const previouslyUncertain = updated.likeStatus === 'pending' || updated.likeStatus === 'unknown' ||
          (updated.likeStatus === 'none' && (await loadSearchCandidates()).some(item => item.id !== updated.id && item.noteId === updated.noteId && ['pending', 'unknown'].includes(item.likeStatus)));
        if (updated.likeStatus === 'none' || previouslyUncertain) {
          updated = { ...updated, likeStatus: previouslyUncertain ? 'unknown' : 'pending' };
          await saveSearchCandidate({ ...updated, status: 'new' });
          try {
            const likeStatus = await likeCandidate(candidate, note, canInteract, pageTabId, previouslyUncertain);
            updated = { ...updated, likeStatus, likedAt: new Date().toISOString(), likeReason: likeStatus === 'liked' ? '原帖点赞已确认。' : '页面已点赞，未重复点击。' };
            await saveSearchCandidate({ ...updated, status: 'new' });
            const latestState = await readModeState();
            await writeModeState({ ...latestState, liked: latestState.liked + Number(likeStatus === 'liked') });
          } catch (error) {
            if (isRestriction(error)) {
              await saveSearchCandidate({ ...updated, status: 'needs_review', likeStatus: 'unknown', likeReason: '平台限制，点赞已锁定，停止操作。' });
              return await pauseForRestriction(error);
            }
            if (error instanceof JobCancelled) {
              // Once a request may have been sent, retain the lock even when the user stops.
              await saveSearchCandidate({ ...updated, status: 'new', likeStatus: 'unknown', likeReason: '任务停止，点赞结果未确认；只允许只读复查。' });
              return readModeState();
            }
            const ambiguous = previouslyUncertain || !(error instanceof LikeFailure) || error.ambiguous;
            updated = { ...updated, likeStatus: ambiguous ? 'unknown' : 'unavailable', likeReason: `${ambiguous ? '点赞结果未确认，已锁定本帖点赞，不重复点击' : '本帖未点赞，按钮或页面不可用'}：${String(error)}`.slice(0, 500) };
            if (/security_challenge/.test(String(error))) {
              await saveSearchCandidate({ ...updated, status: 'needs_review', reason: '站点要求安全验证，已停止自动互动。' });
              return pauseMode('站点要求安全验证，已停止自动互动。', runId);
            }
            // A like is independent of a comment: preserve the lock, but do not stop the queue.
            await saveSearchCandidate({ ...updated, status: 'new' });
          }
        }
      }
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (policy.canComment && status === 'eligible') {
        if (commentAlreadyHandled) updated = { ...updated, status: 'skipped', reason: `${reason}；此账号已有评论或不确定发送记录，不重复评论。`.slice(0, 500) };
        else {
          const draft = await gatewayRequest<{ body?: string; warnings?: string[] }>('/v1/draft/create', { campaign, note, assessment, style: state.style });
          if (draft.body?.trim()) updated = { ...updated, draft: draft.body, status: 'drafted', reason: `${reason}；AI 短评已生成`.slice(0, 500) };
          else updated = { ...updated, status: 'skipped', reason: `${reason}；AI 未生成可用短评，不评论：${draft.warnings?.join('；') || '模型未提供原因'}`.slice(0, 500) };
        }
      }
      state = await readModeState();
      if (state.status !== 'running' || state.runId !== runId) return state;
      if (updated.status === 'drafted' && state.publishEnabled) {
        if (await reachedDailyLimit(campaign.accountLabel)) return pauseMode(`今日已达到 ${DAILY_COMMENT_LIMIT} 条上限。`, runId);
        try {
          if (interactionBlocksFirstContact(await loadInteractions(), candidate.noteId, campaign.accountLabel)) throw new CommentPolicyDenied('已有互动或不确定发送记录，跳过本帖，不重复发送。');
          newlyPublished = await publishCandidate(candidate, note, updated.draft, campaign, assessment, canInteract, pageTabId);
          if (newlyPublished && state.paceEnabled) await chrome.storage.local.set({ [commentCooldownKey(campaign.accountLabel)]: Date.now() + nextCommentDelayMs() });
          publishedThisRun ||= newlyPublished;
          updated = { ...updated, status: newlyPublished ? 'published' : 'skipped', reason: `${reason}；${newlyPublished ? '已在原站确认评论出现' : '当前账号已有同文评论，自动跳过，未再次发送'}`.slice(0, 500) };
        } catch (error) {
          if (isRestriction(error)) { await saveSearchCandidate({ ...updated, status: 'needs_review', reason: '平台限制，停止评论并保留发送防重记录。' }); return await pauseForRestriction(error); }
          if (error instanceof JobCancelled) { await saveSearchCandidate(updated); return readModeState(); }
          if (error instanceof CommentPolicyDenied) {
            updated = { ...updated, status: 'skipped', reason: `${reason}；发送前检查：${error.message}`.slice(0, 500) };
          } else if (error instanceof PublicationUncertain && error.skipAndContinue) {
            // Never unlock/retry the send. Close only our original detail; a failed close
            // or platform/account/page change still stops the workflow safely.
            updated = { ...updated, status: 'skipped', reason: `评论未确认，已跳过：${error.message} 防重锁保留，继续下一帖。`.slice(0, 500) };
          } else {
          retainUncertainDetail = error instanceof PublicationUncertain;
          updated = { ...updated, status: 'needs_review', reason: `自动评论已停止：${String(error)}`.slice(0, 500) };
          await saveSearchCandidate(updated);
          await writeModeState({ ...state, analyzed: state.analyzed + 1, needsReview: state.needsReview + 1 });
          if (retainUncertainDetail) await pause('评论结果未确认，保留当前详情供核对；关闭详情后请手动启动。');
          return pauseMode(`评论未获可靠确认，已停机：${String(error)}`, runId);
          }
        }
      }
      await saveSearchCandidate(updated);
      state = await readModeState();
      await writeModeState({ ...state, analyzed: state.analyzed + 1, drafted: state.drafted + Number(updated.status === 'drafted'), needsReview: state.needsReview + Number(updated.status === 'needs_review'), skipped: state.skipped + Number(updated.status === 'skipped'), published: state.published + Number(newlyPublished), reason: '', currentCandidate: { ...state.currentCandidate!, stage: updated.status === 'skipped' ? '已跳过' : '已处理', reason: updated.reason } });
      } finally {
        const session = pageSession;
        if (!retainUncertainDetail && session && session.runId === runId && session.noteId === candidate.noteId) await closeSamePage(session);
      }
    }
    state = await readModeState();
    if (state.status !== 'running' || state.runId !== runId) return state;
    const delay = nextModeDelayMs(state.paceEnabled, queue.length > 0);
    const nextRunAt = new Date(state.paceEnabled && publishedThisRun ? await nextAllowedCommentAt(campaign.accountLabel) : Date.now() + delay).toISOString();
    const updated = await writeModeState({ ...state, gatewayFailures: 0, lastRunAt: new Date().toISOString(), nextRunAt, reason: queue.length ? '' : '当前候选已处理完，等待自动收集新增。' });
    await scheduleMode(updated);
    return updated;
  } catch (error) {
    if (isRestriction(error)) return pauseForRestriction(error);
    if (error instanceof GatewayUnavailableError) return retryMode(runId);
    return pauseMode(`Auto 模式暂停：${String(error)}`, runId);
  }
  finally { modeInFlight = false; }
}

async function startMode(taskId: string, style: string, publishEnabled: boolean, likeEnabled: boolean, paceEnabled: boolean, followEnabled = false) {
  if (modeStarting) throw new Error('Auto 正在核对页面顺序，请稍候。');
  if (inFlight) throw new Error('当前收集尚未完成，请稍后再启动 Auto。');
  modeStarting = true;
  try { return await beginMode(taskId, style, publishEnabled, likeEnabled, paceEnabled, followEnabled); }
  finally { modeStarting = false; }
}

async function beginMode(taskId: string, style: string, publishEnabled: boolean, likeEnabled: boolean, paceEnabled: boolean, followEnabled = false) {
  await assertNotRestricted();
  if (businessChanging) throw new Error('业务模板正在更新，请稍候。');
  if (modeInFlight) throw new Error('上一轮自动分析尚未结束。');
  const existing = await readModeState();
  if (existing.status === 'running') throw new Error('Auto 模式已运行，请先停止。');
  const scan = await readState();
  if (scan.status !== 'running' || scan.taskId !== taskId) throw new Error('请先启动该任务的自动收集。');
  if (scan.paceEnabled !== paceEnabled) throw new Error('自动收集与 Auto 的间隔设置不一致，请先停止并重新启动自动收集。');
  const campaign = await loadCampaign();
  if (!campaign.confirmedAt || !targetIntentIsUsable(campaign.targetIntent)) throw new Error('目标客户需求描述无效，请在设置中修正并重新确认业务资料。');
  const task = (await loadSearchTasks()).find(item => item.id === taskId);
  if (!task || task.campaignId !== campaign.id) throw new Error('此浏览任务属于旧业务配置，请为当前模板创建新任务。');
  const profileIssue = campaignConfigurationIssue(campaign);
  if (profileIssue) throw new Error(profileIssue);
  if (scan.tabId === null) throw new Error('未确认同页任务标签页。');
  const tab = await chrome.tabs.get(scan.tabId);
  if (!tab.url || !isXhsTaskPage(tab.url, task) || tab.active === false) throw new Error('请在该任务对应的小红书首页/搜索列表启动 Auto。');
  const demand = await readDemandState();
  if (demand.status === 'running' && demand.tabId === scan.tabId) throw new Error('同一页面找需求正在运行，请先停止它。');
  try { await checkPage(scan.tabId); } catch (error) { if (isRestriction(error)) await pauseForRestriction(error); throw error; }
  let waitingForGateway = false;
  try {
    const health = await gatewayHealth();
    if (health.mode !== 'real') throw new Error('请先将本机网关配置为 Real 模式；Mock 草稿不能用于 Auto。');
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError)) throw error;
    waitingForGateway = true;
  }
  if (style.length > 500) throw new Error('草稿风格过长。');
  // Recover legacy posts stopped only by like confirmation. Keep their interaction locks.
  const interactions = await loadInteractions();
  for (const item of await loadSearchCandidates()) {
    if (item.taskId === taskId && recoverableCommentStop(item, interactions, campaign.accountLabel)) {
      await saveSearchCandidate({ ...item, status: 'skipped', reason: `已保留评论防重锁：${commentRecordSkipReason(interactions, item.noteId, campaign.accountLabel)}` });
      continue;
    }
    if (item.taskId === taskId && item.status === 'needs_review' && ['pending', 'unknown'].includes(item.likeStatus) &&
        /^(自动点赞未确认|.*上次点赞结果不明)/.test(item.reason) && !/security_challenge|安全验证/.test(item.reason) &&
        !['pending', 'unknown'].includes(item.followStatus) && !item.draft && item.note && item.assessment &&
        autoCandidateStatus(item.note, item.assessment) === 'eligible' && !interactionBlocksFirstContact(interactions, item.noteId, campaign.accountLabel)) {
      await saveSearchCandidate({ ...item, status: 'new', likeStatus: 'unknown', likeReason: '旧版点赞确认异常，保留防重锁，仅只读复查；评论重新判断。', reason: '重新核验旧版因点赞确认暂停的帖子。' });
    }
  }
  // Start from the first unfinished card in the current visual list, not an old
  // newest-first/UUID queue. This is a read-only page request, never a scroll.
  const page = await pageRequest<SearchResult>(scan.tabId, { type: 'ASSISTANT_FEED_RESULTS', source: autoTaskSource(task), expectedKeyword: task.keyword });
  if (!page.ok || !page.results || !page.sourceUrl || !isXhsTaskPage(page.sourceUrl, task)) throw new Error(`无法核对当前列表顺序：${page.reason ?? '页面变化'}`);
  const collection = orderedCollection(task, await loadSearchCandidates(), page.results, new Date().toISOString(), true);
  const checkpoint = await readState();
  if (checkpoint.status !== 'running' || checkpoint.runId !== scan.runId || checkpoint.taskId !== task.id || (await loadCampaign()).id !== campaign.id) throw new Error('浏览任务或业务资料已变化，Auto 未启动。');
  for (const item of collection.updates) await saveSearchCandidateOrder(item.id, item.listOrder!);
  for (const item of collection.additions) await saveSearchCandidate(item);
  if (collection.additions.length) await writeState({ ...checkpoint, lastAdded: collection.additions.length, totalAdded: checkpoint.totalAdded + collection.additions.length });
  await chrome.alarms.clear(AUTO_MODE_ALARM);
  if (modeTimer) clearTimeout(modeTimer);
  modeTimer = null;
  const nextRunAt = new Date(Date.now() + (waitingForGateway ? gatewayRetryDelayMs(1) : paceEnabled ? AUTO_MODE_DELAY_MS : FAST_MODE_DELAY_MS)).toISOString();
  const state = await writeModeState({ ...initialAutoModeState, status: 'running', runId: crypto.randomUUID(), taskId, style, publishEnabled, likeEnabled: likeEnabled || followEnabled, followEnabled, paceEnabled, nextRunAt,
    gatewayFailures: Number(waitingForGateway), reason: waitingForGateway ? '网关暂不可用，15 秒后自动重连；不会发送评论。' : '' });
  await scheduleMode(state);
  if (!waitingForGateway) void runMode(state.runId!);
  return state;
}

async function stopMode() {
  await chrome.alarms.clear(AUTO_MODE_ALARM);
  if (modeTimer) clearTimeout(modeTimer);
  modeTimer = null;
  const state = await readModeState();
  return writeModeState({ ...state, status: 'stopped', runId: null, nextRunAt: null, reason: '已由用户停止。' });
}

async function runScan(runId: string) {
  if (businessChanging || inFlight) return readState();
  inFlight = true;
  try {
    const state = await readState();
    if (state.status !== 'running' || state.runId !== runId || !state.taskId || state.tabId === null) return state;
    if (modeStarting || modeInFlight || pageSession) {
      const updated = await writeState({ ...state, nextRunAt: new Date(Date.now() + 5_000).toISOString(), reason: '同页 Auto 正在处理详情，返回列表后再下拉。' });
      await scheduleScan(updated); return updated;
    }
    await checkPage(state.tabId);
    const task = (await loadSearchTasks()).find(item => item.id === state.taskId);
    const campaign = await loadCampaign();
    if (!task || !campaign.confirmedAt || task.campaignId !== campaign.id) return pause('业务画像或浏览任务已变化，自动收集暂停。', runId);
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab?.url || !isXhsTaskPage(tab.url, task) || tab.active === false) return pause('任务标签页已关闭、不再活动或离开对应首页/搜索列表，自动收集暂停。', runId);
    const mode = await readModeState();
    if (mode.status === 'running' && mode.taskId === task.id) {
      const queued = (await loadSearchCandidates()).filter(item => item.taskId === task.id && item.status === 'new').length;
      if (queued > 0) {
        const updated = await writeState({ ...state, nextRunAt: new Date(Date.now() + 5_000).toISOString(), reason: `已有 ${queued} 条待分析候选，处理后继续下拉。` });
        await scheduleScan(updated);
        return updated;
      }
    }
    // Read the initial screen before scrolling; during Auto, drain its queue before moving on.
    const firstPass = state.lastRunAt === null;
    const result = await pageRequest<SearchResult>(state.tabId, { type: firstPass ? 'ASSISTANT_FEED_RESULTS' : 'ASSISTANT_SCROLL_FEED', source: autoTaskSource(task), expectedKeyword: task.keyword });
    if (!result.ok || !result.sourceUrl || !isXhsTaskPage(result.sourceUrl, task) || !result.results) return pause(`列表页面无法可靠读取：${result.reason ?? '结构变化'}`, runId);
    const checkpoint = await readState();
    if (checkpoint.runId !== runId || checkpoint.status !== 'running') return checkpoint;
    const now = new Date().toISOString();
    const { additions, updates } = orderedCollection(task, await loadSearchCandidates(), result.results, now, firstPass);
    for (const item of updates) await saveSearchCandidateOrder(item.id, item.listOrder!);
    for (const item of additions) await saveSearchCandidate(item);
    await saveSearchTask({ ...task, status: 'collected' });
    const latest = await readState();
    if (latest.status !== 'running' || latest.runId !== runId) return latest;
    const advanced = firstPass || result.scrollMoved;
    const nextRunAt = new Date(Date.now() + scanDelayMs(latest.paceEnabled, !advanced)).toISOString();
    const updated = await writeState({ ...latest, lastRunAt: now, lastAdded: additions.length, totalAdded: latest.totalAdded + additions.length, nextRunAt, stalledCount: advanced ? 0 : latest.stalledCount + 1, reason: advanced ? '' : '暂时没有更多内容；保留列表与筛选，不自动刷新页面。' });
    await scheduleScan(updated);
    return updated;
  } catch (error) {
    if (isRestriction(error)) { await pauseForRestriction(error); return readState(); }
    return pause(`自动收集失败：${String(error)}`, runId);
  } finally { inFlight = false; }
}

async function start(taskId: string, tabId: number, paceEnabled: boolean) {
  await assertNotRestricted();
  try { await checkPage(tabId); } catch (error) { if (isRestriction(error)) await pauseForRestriction(error); throw error; }
  const demand = await readDemandState();
  if (demand.status === 'running' && demand.tabId === tabId) throw new Error('同页找需求正在运行，请先停止它。');
  if (businessChanging) throw new Error('业务模板正在更新，请稍候。');
  if (inFlight) throw new Error('上一轮收集尚未结束，请稍后重试。');
  await releaseReturnedSession(tabId);
  if (pageSession || modeInFlight) throw new Error('同页详情尚未关闭，请先核对并手动关闭详情返回原列表。');
  if ((await readState()).status === 'running') throw new Error('自动收集已运行，请先停止再绑定新任务。');
  const task = (await loadSearchTasks()).find(item => item.id === taskId);
  const campaign = await loadCampaign();
  const tab = await chrome.tabs.get(tabId);
  if (!task || !campaign.confirmedAt || task.campaignId !== campaign.id) throw new Error('请先确认当前业务画像和浏览任务。');
  if (!tab.url || !isXhsTaskPage(tab.url, task) || tab.active === false) throw new Error('请在该任务对应的小红书首页/搜索列表启动自动收集。');
  await chrome.alarms.clear(AUTO_SCAN_ALARM);
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  const state = await writeState({ ...initialAutoScanState, status: 'running', runId: crypto.randomUUID(), taskId, tabId, paceEnabled });
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  return runScan(state.runId!);
}

async function stop() {
  await chrome.alarms.clear(AUTO_SCAN_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  const state = await readState();
  const mode = await readModeState();
  if (mode.status === 'running' && mode.taskId === state.taskId) await pauseMode('自动收集已停止，Auto 模式同步暂停。');
  return writeState({ ...state, status: 'stopped', runId: null, nextRunAt: null, reason: '已由用户停止。' });
}

async function setPacing(paceEnabled: boolean) {
  const scan = await readState();
  const mode = await readModeState();
  if (scan.status === 'running') {
    const updated = await writeState({ ...scan, paceEnabled, nextRunAt: new Date(Date.now() + scanDelayMs(paceEnabled, scan.stalledCount > 0)).toISOString(), reason: '' });
    await scheduleScan(updated);
  }
  if (mode.status === 'running') {
    const campaign = await loadCampaign();
    const nextAllowed = paceEnabled && mode.publishEnabled ? await nextAllowedCommentAt(campaign.accountLabel) : 0;
    const nextRunAt = new Date(paceEnabled ? Math.max(Date.now() + AUTO_MODE_DELAY_MS, nextAllowed) : Date.now() + FAST_MODE_DELAY_MS).toISOString();
    const updated = await writeModeState({ ...mode, paceEnabled, nextRunAt, reason: '' });
    await scheduleMode(updated);
  }
  return { paceEnabled };
}

async function stopForBusinessChange() {
  await stopMode();
  await stop();
  await stopDemand();
  const deadline = Date.now() + 45_000;
  while (modeInFlight || inFlight || demandInFlight) {
    if (Date.now() > deadline) throw new Error('当前页面操作尚未结束，任务已停止，请稍后再切换模板。');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // An in-flight result may have written progress after the first stop.
  // Quiesce again once all operations have drained, so no old timer survives.
  await stopMode();
  await stop();
  await stopDemand();
}

async function prepareModelConfigChange() {
  if (businessChanging || modeStarting) throw new Error('model_config_busy');
  businessChanging = true;
  try {
    await stopForBusinessChange();
    const id = crypto.randomUUID();
    // A closed settings panel must not leave the worker locked indefinitely.
    const timer = setTimeout(() => finishModelConfigChange(id), 35_000);
    modelConfigLock = { id, timer };
    return id;
  } catch { businessChanging = false; throw new Error('model_request_in_progress'); }
}

function finishModelConfigChange(id: string) {
  if (modelConfigLock?.id !== id) return false;
  clearTimeout(modelConfigLock.timer); modelConfigLock = null; businessChanging = false;
  return true;
}

async function changeBusinessTemplate(action: string, input?: unknown, templateId?: string) {
  if (businessChanging) throw new Error('业务模板正在更新，请稍候。');
  businessChanging = true;
  try {
    const templates = await loadBusinessTemplates();
    const active = await loadCampaign();
    let saved: BusinessTemplate;
    let nextCampaign: Campaign | null | undefined;
    let notice = '';
    const now = new Date().toISOString();
    if (action === 'BUSINESS_TEMPLATE_SAVE') {
      const proposed = businessTemplateSchema.parse(input);
      const previous = templates.find(item => item.id === proposed.id);
      if (previous && previous.version !== proposed.version) throw new Error('模板已在其他窗口修改，请刷新后再保存。');
      if (previous?.archivedAt) throw new Error('请先恢复已归档模板再编辑。');
      saved = { ...proposed, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt ?? now, updatedAt: now, archivedAt: null };
      if (active.businessTemplateId === saved.id) {
        await stopForBusinessChange();
        try { nextCampaign = campaignFromBusinessTemplate(saved, crypto.randomUUID(), now); notice = '已保存并应用新版本，原任务已停止。'; }
        catch (error) { nextCampaign = null; notice = `已保存草稿并停止原任务；${String(error).replace(/^Error: /, '')}`; }
      } else notice = '业务模板已保存。';
    } else {
      const previous = templates.find(item => item.id === templateId);
      if (!previous) throw new Error('业务模板不存在。');
      saved = { ...previous };
      if (action === 'BUSINESS_TEMPLATE_ACTIVATE') {
        nextCampaign = campaignFromBusinessTemplate(saved, crypto.randomUUID(), now);
        await stopForBusinessChange();
        notice = `已激活「${saved.name}」，请创建新搜索任务。`;
      } else if (action === 'BUSINESS_TEMPLATE_DUPLICATE') {
        saved = { ...previous, id: crypto.randomUUID(), name: `${previous.name.slice(0, 75)} 副本`, version: 1, createdAt: now, updatedAt: now, archivedAt: null };
        notice = '已复制业务模板。';
      } else if (action === 'BUSINESS_TEMPLATE_ARCHIVE') {
        if (active.businessTemplateId === saved.id) { await stopForBusinessChange(); nextCampaign = null; }
        saved = { ...saved, archivedAt: now, updatedAt: now, version: saved.version + 1 };
        notice = '业务模板已归档，历史记录保留。';
      } else if (action === 'BUSINESS_TEMPLATE_RESTORE') {
        saved = { ...saved, archivedAt: null, updatedAt: now, version: saved.version + 1 };
        notice = '业务模板已恢复。';
      } else throw new Error('未知业务模板操作。');
    }
    await commitBusinessTemplate(saved, nextCampaign);
    await chrome.storage.local.set({ businessTemplatesRevision: crypto.randomUUID() });
    return { templates: await loadBusinessTemplates(), campaign: await loadCampaign(), savedId: saved.id, notice };
  } finally { businessChanging = false; }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void pause('扩展更新后自动收集暂停，请手动重新启动。');
  void pauseMode('扩展更新后 Auto 模式暂停，请手动重新启动。');
  void pauseDemand('扩展更新后找需求暂停，请手动重新启动。');
});

chrome.runtime.onStartup.addListener(() => { void pause('浏览器重新启动后自动收集暂停，请手动重新启动。'); void pauseMode('浏览器重新启动后 Auto 模式暂停，请手动重新启动。'); void pauseDemand('浏览器重新启动后找需求暂停，请手动重新启动。'); });

async function resumeOverdueJobs() {
  const scan = await readState();
  if (scan.status === 'running' && scan.runId && scan.nextRunAt && Date.parse(scan.nextRunAt) <= Date.now()) void runScan(scan.runId);
  const mode = await readModeState();
  if (mode.status === 'running' && mode.runId && mode.nextRunAt && Date.parse(mode.nextRunAt) <= Date.now()) void runMode(mode.runId);
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === WATCHDOG_ALARM) void resumeOverdueJobs();
  if (alarm.name === AUTO_SCAN_ALARM) void readState().then(state => state.status === 'running' && state.runId ? runScan(state.runId) : null);
  if (alarm.name === AUTO_MODE_ALARM) void readModeState().then(state => state.status === 'running' && state.runId ? runMode(state.runId) : null);
  if (alarm.name === DEMAND_ALARM) void readDemandState().then(state => state.status === 'running' && state.runId ? demandLoop(state.runId) : null);
});

chrome.tabs.onRemoved.addListener(tabId => {
  void readDemandState().then(state => { if (state.status === 'running' && state.tabId === tabId) return pauseDemand('找需求标签页已关闭。', state.runId ?? undefined); });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void readDemandState().then(state => {
    if (state.status === 'running' && state.tabId === tabId && state.source && !isDemandPage(changeInfo.url!, state.source, state.keyword)) return pauseDemand('找需求标签页已离开原页面。', state.runId ?? undefined);
  });
});

chrome.runtime.onMessage.addListener((message: { type?: string; lockId?: string; interactionId?: string; taskId?: string; tabId?: number; style?: string; publishEnabled?: boolean; likeEnabled?: boolean; followEnabled?: boolean; paceEnabled?: boolean; source?: 'home' | 'search'; keyword?: string | null; template?: unknown; templateId?: string }, _sender, sendResponse) => {
  if (message.type === 'EXTENSION_VERSION') { sendResponse({ version: EXTENSION_VERSION }); return; }
  if (message.type === 'MODEL_CONFIG_PREPARE' || message.type === 'MODEL_CONFIG_FINISH') {
    if (_sender.tab) { sendResponse({ ok: false, reason: 'invalid_origin' }); return; }
    if (message.type === 'MODEL_CONFIG_FINISH') { sendResponse({ ok: Boolean(message.lockId && finishModelConfigChange(message.lockId)) }); return; }
    void prepareModelConfigChange().then(lockId => sendResponse({ ok: true, lockId })).catch(error => sendResponse({ ok: false, reason: error instanceof Error ? error.message : 'model_config_busy' }));
    return true;
  }
  if (message.type === 'PUBLICATION_RECHECK' && message.interactionId && message.tabId !== undefined) {
    void recheckPublication(message.interactionId, message.tabId).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, reason: String(error) }));
    return true;
  }
  if (message.type === 'PLATFORM_RECHECK' && message.tabId !== undefined) {
    void checkPage(message.tabId).then(async () => {
      await chrome.storage.local.remove(PLATFORM_BLOCK_KEY);
      sendResponse({ ok: true, notice: '当前页面未显示限制；任务保持暂停，请人工确认账号正常后再启动。' });
    }).catch(async error => { if (isRestriction(error)) await pauseForRestriction(error); sendResponse({ ok: false, reason: String(error) }); });
    return true;
  }
  if (message.type?.startsWith('BUSINESS_TEMPLATE_')) {
    void changeBusinessTemplate(message.type, message.template, message.templateId)
      .then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, reason: String(error) }));
    return true;
  }
  if (message.type === 'AUTO_PACE_SET') {
    void setPacing(message.paceEnabled === true).then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, reason: String(error) }));
    return true;
  }
  if (message.type?.startsWith('DEMAND_')) {
    const action = message.type === 'DEMAND_START' && message.tabId !== undefined && message.source
      ? startDemand(message.tabId, message.source, message.keyword ?? null)
      : message.type === 'DEMAND_STOP' ? stopDemand() : readDemandState();
    void action.then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, reason: String(error) }));
    return true;
  }
  if (!message.type?.startsWith('AUTO_SCAN_') && !message.type?.startsWith('AUTO_MODE_')) return;
  if (message.type === 'AUTO_SCAN_STATUS' || message.type === 'AUTO_MODE_STATUS') void resumeOverdueJobs();
  const action = message.type === 'AUTO_SCAN_START' && message.taskId && message.tabId !== undefined
    ? start(message.taskId, message.tabId, message.paceEnabled === true)
    : message.type === 'AUTO_SCAN_STOP' ? stop()
    : message.type === 'AUTO_MODE_START' && message.taskId ? startMode(message.taskId, message.style ?? initialAutoModeState.style, message.publishEnabled === true, message.likeEnabled === true, message.paceEnabled === true, message.followEnabled === true)
    : message.type === 'AUTO_MODE_STOP' ? stopMode()
    : message.type === 'AUTO_MODE_STATUS' ? readModeState() : readState();
  void action.then(state => sendResponse({ ok: true, state })).catch(error => sendResponse({ ok: false, reason: String(error) }));
  return true;
});
