import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorFollowKey, campaignFromBusinessTemplate, createBusinessTemplate, searchCandidateSchema, type Assessment, type AuthorFollow, type Campaign, type Interaction, type NoteSnapshot, type SearchCandidate, type SearchTask } from '@yuezhuang/shared';
import { initialAutoModeState } from './autoMode';
import { initialAutoScanState } from './autoScan';
import { EXTENSION_VERSION } from './extensionVersion';

const memory = vi.hoisted(() => ({ campaign: null as Campaign | null, tasks: [] as SearchTask[], candidates: [] as SearchCandidate[], follows: [] as AuthorFollow[], interactions: [] as Interaction[] }));
vi.mock('./storage', () => ({
  loadCampaign: async () => memory.campaign, loadBusinessTemplates: async () => [], commitBusinessTemplate: vi.fn(),
  loadSearchTasks: async () => memory.tasks, saveSearchTask: vi.fn(), loadSearchCandidates: async () => memory.candidates,
  saveSearchCandidate: async (item: SearchCandidate) => { memory.candidates = memory.candidates.some(old => old.id === item.id) ? memory.candidates.map(old => old.id === item.id ? { ...item } : old) : [...memory.candidates, { ...item }]; },
  saveSearchCandidateOrder: async (id: string, listOrder: number) => { memory.candidates = memory.candidates.map(item => item.id === id ? { ...item, listOrder } : item); },
  loadInteractions: async () => memory.interactions, saveInteraction: async (item: Interaction) => { memory.interactions = [...memory.interactions.filter(old => old.id !== item.id), item]; },
  findAuthorFollow: async (account: string, author: string) => memory.follows.find(item => item.id === authorFollowKey(account, author)) ?? null,
  saveAuthorFollow: async (item: AuthorFollow) => { memory.follows = [...memory.follows.filter(old => old.id !== item.id), { ...item }]; }
}));
const author = '6ab7d5ab000000001b02ce03';
const noteId = '6ab7d5ab000000001b02ce05';
let local: Record<string, any>;
let listener: any;
let events: string[];
let authorFollowing: boolean;
let emptyDraft: boolean;
let mismatch: boolean;
let unknownFollow: boolean;
let unavailableFollow: boolean;
let draftFailures: number;
let stopOnAuthorRead: boolean;
let likeFailure: 'unknown' | 'unavailable' | 'security' | 'transport' | null;
let observedLiked: boolean;
let likeProbes: number;
let navigation: string[];
let testTabs: Map<number, string>;
let guardBlocked: boolean;
let restrictOnLike: boolean;
let failClose: boolean;
let missingCard: boolean;
let alarmHandler: any;
let noteOverrides: Partial<NoteSnapshot>;
let assessmentOverrides: Partial<Assessment>;
let artistNameAfterDraft: boolean;
let feedResults: Array<{ noteId: string; url: string; title: string; snippet: string }>;
let scrollResults: typeof feedResults;
let rejectedTitles: Set<string>;
let receiverMissing: boolean;
let unreadableNotes: Set<string>;
let titleChecks: string[];
let openedNoteIds: string[];
let publicationResult: any;
let publicationProbe: any;
let publicationTransportLost: boolean;
let publicationByNote: Map<string, any>;
const event = () => ({ addListener: vi.fn() });
const request = (type: string, fields: object = {}) => new Promise<any>(resolve => listener({ type, ...fields }, {}, resolve));
function candidate(id: string) {
  return searchCandidateSchema.parse({ id, taskId: 'task', noteId: `xhs:${id}`, url: `https://www.xiaohongshu.com/explore/${id}`, title: '上海求租', snippet: '找合租房间', status: 'new', reason: '', capturedAt: '2026-10-05', note: null, draft: '' });
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  local = {}; events = []; authorFollowing = false; emptyDraft = true; mismatch = false; unknownFollow = false; unavailableFollow = false; draftFailures = 0; stopOnAuthorRead = false;
  likeFailure = null; observedLiked = false; likeProbes = 0;
  navigation = []; guardBlocked = false; restrictOnLike = false; failClose = false; missingCard = false;
  noteOverrides = {}; assessmentOverrides = {}; artistNameAfterDraft = false;
  feedResults = []; scrollResults = []; rejectedTitles = new Set();
  receiverMissing = false;
  unreadableNotes = new Set();
  titleChecks = []; openedNoteIds = [];
  publicationResult = { ok: true, published: true, senderId: '000000000000000000000001', commentId: '000000000000000000000011' };
  publicationProbe = { ok: true, published: false }; publicationTransportLost = false;
  publicationByNote = new Map();
  memory.campaign = campaignFromBusinessTemplate(createBusinessTemplate('rental', 'rental'), 'campaign');
  memory.tasks = [{ id: 'task', campaignId: memory.campaign.id, keyword: '上海求租', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海求租', status: 'collected', createdAt: '2026-10-05' }];
  memory.candidates = [candidate(noteId)]; memory.follows = []; memory.interactions = [];
  local.autoScanState = { ...initialAutoScanState, status: 'running', runId: 'scan', taskId: 'task', tabId: 1 };
  local.autoModeState = { ...initialAutoModeState };
  const tabs = new Map<number, string>([[1, memory.tasks[0].sourceUrl]]); testTabs = tabs;
  vi.stubGlobal('chrome', {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener: (handler: any) => { listener = handler; } } }, sidePanel: { setPanelBehavior: vi.fn() },
    alarms: { clear: vi.fn(async () => true), create: vi.fn(async () => {}), onAlarm: { addListener: (handler: any) => { alarmHandler = handler; } } },
    scripting: { executeScript: vi.fn(async () => { receiverMissing = false; return [{ frameId: 0, documentId: 'test-document' }]; }) },
    storage: { local: { get: async (key: string) => ({ [key]: local[key] }), set: async (value: object) => { Object.assign(local, value); }, remove: async (key: string) => { delete local[key]; } }, session: { get: async () => ({}) } },
    tabs: { onRemoved: event(), onUpdated: event(), create: vi.fn(async () => { throw new Error('new_tabs_are_forbidden'); }), reload: vi.fn(async () => { throw new Error('reloads_are_forbidden'); }), remove: vi.fn(async () => { throw new Error('removing_tabs_is_forbidden'); }), get: async (id: number) => ({ id, url: tabs.get(id), status: 'complete', active: true }),
      sendMessage: async (id: number, message: any) => {
        expect(id).toBe(1);
        if (message.type === 'ASSISTANT_CONTENT_STATUS') {
          if (receiverMissing) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { ok: !guardBlocked, reason: guardBlocked ? 'account_restricted' : undefined, version: EXTENSION_VERSION, instance: 'test-page', sourceUrl: tabs.get(id) };
        }
        if (message.type === 'ASSISTANT_PAGE_GUARD') return guardBlocked ? { ok: false, reason: 'account_restricted' } : { ok: true, sourceUrl: tabs.get(id) };
        if (message.type === 'ASSISTANT_OPEN_NOTE') {
          expect(message.expectedSource).toBe(memory.tasks[0].source ?? 'search');
          expect(message.expectedKeyword).toBe(memory.tasks[0].keyword);
          if (missingCard) return { ok: false, reason: 'candidate_not_in_loaded_list', ambiguous: false };
          expect(tabs.get(id)).toBe(memory.tasks[0].sourceUrl);
          navigation.push('open'); openedNoteIds.push(message.expectedNoteId); tabs.set(id, `https://www.xiaohongshu.com/explore/${message.expectedNoteId.slice(4)}`); return { ok: true, opened: true };
        }
        if (message.type === 'ASSISTANT_CLOSE_NOTE') {
          expect(message.expectedSource).toBe(memory.tasks[0].source ?? 'search');
          navigation.push('close'); if (failClose) return { ok: false, reason: 'detail_close_control_not_unique_or_disabled' };
          tabs.set(id, memory.tasks[0].sourceUrl); return { ok: true, sourceUrl: tabs.get(id) };
        }
        if (message.type === 'ASSISTANT_FEED_RESULTS' || message.type === 'ASSISTANT_SCROLL_FEED') {
          expect(message.source).toBe(memory.tasks[0].source ?? 'search'); expect(message.expectedKeyword).toBe(memory.tasks[0].keyword);
          const scrolling = message.type === 'ASSISTANT_SCROLL_FEED'; navigation.push(scrolling ? 'scroll' : 'read-list');
          return { ok: true, sourceUrl: tabs.get(id), results: scrolling ? scrollResults : feedResults, scrollMoved: scrolling && scrollResults.length > 0 };
        }
        if (message.type === 'ASSISTANT_READ_NOTE') {
          const currentId = tabs.get(id)!.split('/').pop()!;
          if (unreadableNotes.has(currentId)) return { ok: false, reason: 'note_structure_unverified' };
          return { ok: true, note: { id: `xhs:${currentId}`, title: '上海求租', body: '找上海合租房间，预算2000，7号线附近。', completeness: 'complete', capturedAt: '2026-10-05', source: 'xhs', ...noteOverrides } };
        }
        if (message.type === 'ASSISTANT_AUTHOR_FOLLOW_STATE') {
          if (stopOnAuthorRead) await request('AUTO_MODE_STOP');
          return unavailableFollow ? { ok: false, reason: 'main_author_follow_control_not_unique' } : { ok: true, authorId: author, authorName: '测试作者', authorUrl: `https://www.xiaohongshu.com/user/profile/${author}`, following: authorFollowing };
        }
        if (message.type === 'ASSISTANT_FOLLOW') { events.push('follow'); if (unknownFollow) return { ok: false, reason: 'follow_clicked_but_state_unverified', ambiguous: true }; authorFollowing = true; return { ok: true, authorId: author, followed: true, alreadyFollowing: false }; }
        if (message.type === 'ASSISTANT_LIKE') {
          events.push('like');
          if (restrictOnLike) { tabs.set(id, 'https://www.xiaohongshu.com/website-login/error?code=300011'); return { ok: false, reason: 'account_restricted' }; }
          if (likeFailure === 'transport') throw new Error('test_lost_message_response');
          if (likeFailure) return { ok: false, reason: likeFailure === 'security' ? 'security_challenge' : likeFailure === 'unavailable' ? 'main_like_control_not_unique' : 'like_clicked_but_state_unverified', ambiguous: likeFailure !== 'unavailable' };
          return { ok: true, liked: true, alreadyLiked: false };
        }
        if (message.type === 'ASSISTANT_LIKE_STATE') { likeProbes++; return { ok: true, liked: observedLiked }; }
        if (message.type === 'ASSISTANT_PUBLISH') { events.push('publish'); if (publicationTransportLost) throw new Error('response_lost'); return publicationByNote.get(message.expectedNoteId) ?? publicationResult; }
        if (message.type === 'ASSISTANT_PUBLICATION_STATE') {
          events.push('publication-probe'); expect(message.expectedNoteId).toBe(`xhs:${noteId}`);
          expect(message.text).toBe(memory.interactions[0].body); return publicationProbe;
        }
        throw new Error(`unexpected_message:${message.type}`);
      }
    }
  });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === '/health') return new Response(JSON.stringify({ mode: 'real' }));
    if (path === '/v1/candidate/title-screen') {
      const title = JSON.parse(init?.body as string).title; titleChecks.push(title);
      expect(local.autoModeState.currentCandidate.stage).toBe('标题初筛');
      return new Response(JSON.stringify({ decision: rejectedTitles.has(title) ? 'reject' : 'inspect', reason: '标题相关性判断', promptVersion: 'title-v-test' }));
    }
    if (path === '/v1/candidate/analyze') return new Response(JSON.stringify({ intent: 'demand', decision: mismatch ? 'hard_skip' : 'eligible_for_review', serviceFit: mismatch ? 'incompatible' : 'compatible', evidence: ['上海求租'], reason: mismatch ? '预算或线路冲突' : '匹配', promptVersion: 'candidate-v-test', ...assessmentOverrides }));
    if (path === '/v1/draft/create') { events.push('draft'); if (draftFailures-- > 0) throw new Error('test_network_outage'); if (artistNameAfterDraft) noteOverrides.authorName = '上海美妆老师'; return new Response(JSON.stringify({ body: emptyDraft ? '' : '我有7号线附近1900元主卧合租。', warnings: ['不适合评论'] })); }
    throw new Error(`unexpected_path:${path}`);
  });
  await import('./background');
});
afterEach(async () => { await request('AUTO_MODE_STOP'); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start(fields: object = {}) {
  const result = await request('AUTO_MODE_START', { taskId: 'task', followEnabled: true, publishEnabled: false, paceEnabled: false, ...fields });
  expect(result.ok, result.reason).toBe(true);
  await vi.advanceTimersByTimeAsync(1900);
}
async function openStoppedForPublicationCheck() {
  await request('AUTO_MODE_STOP'); await request('AUTO_SCAN_STOP');
  testTabs.set(1, `https://www.xiaohongshu.com/explore/${noteId}`);
}

describe('independent Auto follow, like and comment workflow', () => {
  it.each(['unverified', 'transport'] as const)('locks and skips an %s send, safely closes the detail and continues', async failure => {
    emptyDraft = false; publicationTransportLost = failure === 'transport';
    publicationResult = { ok: false, reason: 'send_clicked_but_publication_unverified', ambiguous: true, senderId: '000000000000000000000001' };
    memory.candidates.push(candidate('6ab7d5ab000000001b02ce09'));
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(local.autoModeState.status).toBe('running'); expect(local.autoScanState.status).toBe('running');
    expect(navigation).toEqual(['read-list', 'open', 'close', 'open', 'close']); expect(events.filter(item => item === 'publish')).toHaveLength(2);
    expect(memory.interactions).toHaveLength(2); expect(memory.interactions.every(item => item.status === 'unknown')).toBe(true);
    expect(memory.candidates.every(item => item.status === 'skipped')).toBe(true);
    expect(local.autoModeState).toMatchObject({ skipped: 2, published: 0, needsReview: 0 });
  });
  it('records definite pre-click failures without an unknown-send lock and continues the next post', async () => {
    emptyDraft = false; publicationResult = { ok: false, reason: 'send_button_not_unique_or_disabled', ambiguous: false };
    memory.candidates.push(candidate('6ab7d5ab000000001b02ce09'));
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(memory.interactions.every(item => item.status === 'generated')).toBe(true); expect(memory.interactions).toHaveLength(2);
    expect(memory.candidates.every(item => item.status === 'skipped')).toBe(true); expect(local.autoModeState.status).toBe('running');
    expect(navigation).toEqual(['read-list', 'open', 'close', 'open', 'close']);
  });
  it('does not count an existing own comment as a new publish or add cooldown', async () => {
    emptyDraft = false; publicationResult = { ...publicationResult, alreadyPublished: true };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    expect(memory.candidates[0].status).toBe('skipped'); expect(memory.interactions[0].status).toBe('marked_published');
    expect(local.autoModeState).toMatchObject({ skipped: 1, published: 0, status: 'running' });
  });
  it('reconciles a delayed comment using two read-only probes without sending or restarting Auto', async () => {
    emptyDraft = false; publicationResult = { ok: false, reason: 'send_clicked_but_publication_unverified', ambiguous: true, senderId: '000000000000000000000001' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    await openStoppedForPublicationCheck();
    publicationProbe = { ok: true, published: true, senderId: publicationResult.senderId, commentId: '000000000000000000000011' };
    const check = request('PUBLICATION_RECHECK', { interactionId: memory.interactions[0].id, tabId: 1 });
    await vi.advanceTimersByTimeAsync(600); const result = await check;
    expect(result).toMatchObject({ ok: true, confirmed: true }); expect(memory.candidates[0].status).toBe('published');
    expect(memory.interactions[0].markedPublishedAt).toBe(memory.interactions[0].createdAt);
    expect(events.filter(item => item === 'publish')).toHaveLength(1); expect(events.filter(item => item === 'publication-probe')).toHaveLength(2);
    expect(local.autoModeState.status).toBe('stopped'); expect(local.autoModeState.published).toBe(0); expect(navigation).toEqual(['read-list', 'open', 'close']);
    // A manual close permits a new collection session; the unknown/published record is not reset.
    testTabs.set(1, memory.tasks[0].sourceUrl);
    const restarted = await request('AUTO_SCAN_START', { taskId: 'task', tabId: 1, paceEnabled: false });
    expect(restarted.ok, restarted.reason).toBe(true); expect(events.filter(item => item === 'publish')).toHaveLength(1);
  });
  it('keeps the lock when a read-only check sees no comment, and refuses the wrong post', async () => {
    emptyDraft = false; publicationResult = { ok: false, reason: 'send_clicked_but_publication_unverified', ambiguous: true, senderId: '000000000000000000000001' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    await openStoppedForPublicationCheck();
    expect(await request('PUBLICATION_RECHECK', { interactionId: memory.interactions[0].id, tabId: 1 })).toMatchObject({ ok: true, confirmed: false });
    expect(memory.interactions[0].status).toBe('unknown');
    testTabs.set(1, 'https://www.xiaohongshu.com/explore/6ab7d5ab000000001b02ce09');
    expect(await request('PUBLICATION_RECHECK', { interactionId: memory.interactions[0].id, tabId: 1 })).toMatchObject({ ok: false });
    expect(events.filter(item => item === 'publication-probe')).toHaveLength(1); expect(events.filter(item => item === 'publish')).toHaveLength(1);
  });
  it.each(['missing', 'changed'] as const)('never reconciles a %s sender or changes the original account lock', async mode => {
    emptyDraft = false; const originalSender = '000000000000000000000001';
    publicationResult = { ok: false, reason: 'send_clicked_but_publication_unverified', ambiguous: true, senderId: originalSender };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    await openStoppedForPublicationCheck();
    publicationProbe = { ok: true, published: true, senderId: mode === 'changed' ? '000000000000000000000002' : undefined };
    expect(await request('PUBLICATION_RECHECK', { interactionId: memory.interactions[0].id, tabId: 1 })).toMatchObject({ ok: true, confirmed: false });
    expect(memory.interactions[0]).toMatchObject({ status: 'unknown', publicationSenderId: originalSender });
    expect(memory.candidates[0].status).toBe('skipped'); expect(events.filter(item => item === 'publish')).toHaveLength(1);
  });
  it('skips the uncertain first post and successfully publishes only on the second post', async () => {
    emptyDraft = false;
    const first = memory.candidates[0]; const second = candidate('6ab7d5ab000000001b02ce09'); memory.candidates.push(second);
    publicationByNote.set(first.noteId, { ok: false, ambiguous: true, reason: 'send_clicked_but_publication_unverified' });
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(memory.candidates.find(item => item.id === first.id)?.status).toBe('skipped');
    expect(memory.candidates.find(item => item.id === second.id)?.status).toBe('published');
    expect(memory.interactions.find(item => item.noteId === first.noteId)?.status).toBe('unknown');
    expect(memory.interactions.find(item => item.noteId === second.noteId)?.status).toBe('marked_published');
    expect(local.autoModeState).toMatchObject({ status: 'running', skipped: 1, published: 1 });
    expect(navigation).toEqual(['read-list', 'open', 'close', 'open', 'close']);
  });
  it('still pauses if an uncertain send cannot close its owned detail', async () => {
    emptyDraft = false; failClose = true; publicationResult = { ok: false, ambiguous: true, reason: 'send_clicked_but_publication_unverified' };
    memory.candidates.push(candidate('6ab7d5ab000000001b02ce09'));
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(local.autoModeState.status).toBe('paused'); expect(memory.interactions[0].status).toBe('unknown');
    expect(navigation).toEqual(['read-list', 'open', 'close']); expect(memory.candidates[1].status).toBe('new');
  });
  it.each(['comment_sender_changed', 'target_note_mismatch', 'security_challenge'])('does not treat %s as a harmless duplicate skip', async reason => {
    emptyDraft = false; publicationResult = { ok: false, ambiguous: true, reason };
    memory.candidates.push(candidate('6ab7d5ab000000001b02ce09'));
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(local.autoModeState.status).toBe('paused'); expect(memory.interactions[0].status).toBe('unknown');
    expect(memory.candidates[1].status).toBe('new'); expect(events.filter(item => item === 'publish')).toHaveLength(1);
  });
  it('on restart skips an unknown-send lock even if a new task captured the same note', async () => {
    emptyDraft = false; publicationResult = { ok: false, ambiguous: true, reason: 'send_clicked_but_publication_unverified' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500); await request('AUTO_MODE_STOP');
    const record = { ...memory.interactions[0] }; const second = candidate('6ab7d5ab000000001b02ce09');
    memory.candidates = [{ ...candidate(noteId), id: 'recaptured' }, second]; publicationResult = { ok: true, published: true };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(memory.candidates[0].status).toBe('skipped'); expect(memory.interactions.find(item => item.id === record.id)).toEqual(record);
    expect(openedNoteIds).toEqual([`xhs:${noteId}`, second.noteId]); expect(events.filter(item => item === 'publish')).toHaveLength(2);
  });
  it('converts a legacy comment-timeout review to skipped on restart without changing its lock', async () => {
    emptyDraft = false; publicationResult = { ok: false, ambiguous: true, reason: 'send_clicked_but_publication_unverified' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500); await request('AUTO_MODE_STOP');
    const record = { ...memory.interactions[0] };
    memory.candidates[0] = { ...memory.candidates[0], status: 'needs_review', reason: '自动评论已停止：Error: send_clicked_but_publication_unverified' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(2000);
    expect(memory.candidates[0].status).toBe('skipped'); expect(memory.interactions[0]).toEqual(record);
    expect(openedNoteIds).toHaveLength(1); expect(events.filter(item => item === 'publish')).toHaveLength(1);
  });
  it.each(['home', 'search'] as const)('realigns a shuffled legacy %s queue to page order before the first AI call', async source => {
    if (source === 'home') {
      memory.tasks[0] = { ...memory.tasks[0], source: 'home', keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore' }; testTabs.set(1, memory.tasks[0].sourceUrl);
    }
    const first = { ...candidate('6ab7d5ab000000001b02ce09'), id: 'zzz', title: '第一张上海求租' };
    const second = { ...candidate('6ab7d5ab000000001b02ce07'), id: 'aaa', title: '第二张上海求租' };
    const third = { ...candidate(noteId), title: '第三张上海求租', capturedAt: '2026-10-06T12:00:00Z' };
    memory.candidates = [third, second, first]; feedResults = [first, second, third];
    await start({ followEnabled: false }); await vi.advanceTimersByTimeAsync(6500);
    expect(titleChecks).toEqual([first.title, second.title, third.title]); expect(openedNoteIds).toEqual([first.noteId, second.noteId, third.noteId]);
    expect(local.autoModeState.currentCandidate).toMatchObject({ title: third.title, listOrder: 2 });
    expect(navigation[0]).toBe('read-list'); expect(navigation).not.toContain('scroll');
    expect(chrome.tabs.create).not.toHaveBeenCalled(); expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
  it('shows sequential title skips before opening the first relevant card, without jumping over the first two', async () => {
    const first = { ...candidate('6ab7d5ab000000001b02ce09'), title: '晚餐菜谱' };
    const second = { ...candidate('6ab7d5ab000000001b02ce07'), title: '旅游攻略' };
    const third = { ...candidate(noteId), title: '第三张上海求租' };
    memory.candidates = [third, first, second]; feedResults = [first, second, third]; rejectedTitles.add(first.title); rejectedTitles.add(second.title);
    await start({ followEnabled: false });
    expect(local.autoModeState.currentCandidate).toMatchObject({ title: first.title, listOrder: 0, stage: '已跳过（未打开详情）' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(titleChecks).toEqual([first.title, second.title, third.title]); expect(openedNoteIds).toEqual([third.noteId]);
    expect(memory.candidates.find(item => item.id === first.id)?.status).toBe('skipped');
  });
  it('does not reset or re-comment handled cards when restoring page order on a restart', async () => {
    const first = { ...candidate('6ab7d5ab000000001b02ce09'), status: 'published' as const, draft: '原已发送', likeStatus: 'unknown' as const };
    const second = { ...candidate(noteId), title: '第二张上海求租' };
    memory.candidates = [second, first]; feedResults = [first, second];
    await start({ followEnabled: false }); await vi.advanceTimersByTimeAsync(3500);
    expect(titleChecks).toEqual([second.title]); expect(openedNoteIds).toEqual([second.noteId]);
    expect(memory.candidates.find(item => item.id === first.id)).toEqual({ ...first, listOrder: 0 });
    expect(local.autoModeState.currentCandidate.listOrder).toBe(1);
  });
  it('adds newly loaded page cards at startup ahead of legacy off-page candidates, without scrolling', async () => {
    const loaded = { ...candidate('6ab7d5ab000000001b02ce09'), title: '首屏上海求租' }; feedResults = [loaded];
    await start({ followEnabled: false });
    expect(titleChecks[0]).toBe(loaded.title); expect(openedNoteIds[0]).toBe(loaded.noteId); expect(navigation).not.toContain('scroll');
    expect(local.autoScanState.totalAdded).toBe(1);
  });
  it('recovers the missing page receiver before Auto starts without refreshing or replaying an interaction', async () => {
    receiverMissing = true; await start({ publishEnabled: true });
    expect(chrome.scripting.executeScript).toHaveBeenCalledOnce();
    expect(events.filter(event => event === 'follow')).toHaveLength(1); expect(events.filter(event => event === 'like')).toHaveLength(1);
    expect(chrome.tabs.reload).not.toHaveBeenCalled(); expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  function home() {
    memory.tasks[0] = { ...memory.tasks[0], source: 'home', keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore' };
    testTabs.set(1, memory.tasks[0].sourceUrl);
  }
  function makeup() {
    vi.setSystemTime(new Date('2026-10-06T04:00:00Z'));
    const template = createBusinessTemplate('makeup', 'artist');
    template.config.makeupProfile = { cities: ['上海'], serviceAreas: ['上海'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 359, priceTo: null, priceNotes: '', availability: '' };
    memory.campaign = campaignFromBusinessTemplate(template, 'campaign');
    noteOverrides = { title: '上海求日常妆', body: '需要上海上门日常妆，10月3日', authorName: '测试客户' };
    assessmentOverrides = { evidence: ['上海求日常妆'], topicFit: 'relevant', serviceDate: null };
    memory.candidates[0].title = noteOverrides.title!; emptyDraft = false;
  }
  it('processes several homepage posts sequentially, then scrolls and handles a new post without searching', async () => {
    home(); emptyDraft = false;
    memory.candidates.push(candidate('6ab7d5ab000000001b02ce06'));
    const third = candidate('6ab7d5ab000000001b02ce07');
    scrollResults = [{ noteId: third.noteId, url: third.url, title: third.title, snippet: third.snippet }];
    await start({ publishEnabled: true });
    await vi.advanceTimersByTimeAsync(6000);
    expect(memory.candidates.filter(item => item.status === 'published')).toHaveLength(2);
    expect(navigation).toEqual(['read-list', 'open', 'close', 'open', 'close']);
    alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(100);
    expect(navigation.at(-1)).toBe('read-list'); // The first collector tick captures the current screen.
    alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(5000);
    expect(memory.candidates.find(item => item.noteId === third.noteId)?.status).toBe('published');
    expect(events.filter(event => event === 'publish')).toHaveLength(3);
    expect(events.filter(event => event === 'follow')).toHaveLength(1);
    expect(events.filter(event => event === 'like')).toHaveLength(3);
    expect(navigation).toContain('scroll'); expect(local.autoModeState.status).toBe('running');
    expect(chrome.tabs.create).not.toHaveBeenCalled(); expect(chrome.tabs.reload).not.toHaveBeenCalled(); expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(testTabs.get(1)).toBe(memory.tasks[0].sourceUrl);
  });
  it('collects the initial homepage screen before any downward scroll and deduplicates later reads', async () => {
    home(); local.autoScanState = { ...initialAutoScanState }; memory.candidates = [];
    const card = candidate(noteId); feedResults = [{ noteId: card.noteId, url: card.url, title: card.title, snippet: card.snippet }]; scrollResults = feedResults;
    const result = await request('AUTO_SCAN_START', { taskId: 'task', tabId: 1 });
    expect(result.ok, result.reason).toBe(true); expect(navigation).toEqual(['read-list']); expect(memory.candidates).toHaveLength(1);
    alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(100);
    expect(navigation).toEqual(['read-list', 'scroll']); expect(memory.candidates).toHaveLength(1);
  });
  it('does not scroll past even one unprocessed home card while Auto is running', async () => {
    home(); local.autoModeState = { ...initialAutoModeState, status: 'running', runId: 'mode', taskId: 'task' };
    alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(100);
    expect(navigation).toEqual([]); expect(local.autoScanState.reason).toContain('待分析候选');
  });
  it('rejects homepage Auto on a search page and does not call AI or engage', async () => {
    home(); testTabs.set(1, 'https://www.xiaohongshu.com/search_result?keyword=上海求租');
    const result = await request('AUTO_MODE_START', { taskId: 'task', publishEnabled: true });
    expect(result.ok).toBe(false); expect(events).toEqual([]); expect(navigation).toEqual([]);
  });
  it('uses title rejection on the home feed without opening an irrelevant card', async () => {
    home(); memory.candidates[0].title = '晚餐菜谱'; rejectedTitles.add('晚餐菜谱');
    await start({ publishEnabled: true });
    expect(events).toEqual([]); expect(navigation).toEqual(['read-list']); expect(memory.candidates[0].reason).toContain('标题筛选');
  });
  it('uses the same expired-date and author-name rules on homepage Auto', async () => {
    home(); makeup(); assessmentOverrides.serviceDate = { lastAcceptableDate: '2026-10-03', evidence: '10月3日' }; noteOverrides.authorName = '上海妆娘';
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    expect(events).toEqual(['like']); expect(memory.follows).toHaveLength(0); expect(memory.interactions).toHaveLength(0);
    expect(memory.candidates[0].assessment?.engagementPolicy).toMatchObject({ canLike: true, canFollow: false, canComment: false });
    expect(navigation).toEqual(['read-list', 'open', 'close']);
  });
  it('stops homepage browsing and interactions when the user stops both Auto and its collector', async () => {
    home(); emptyDraft = false; memory.candidates.push(candidate('6ab7d5ab000000001b02ce06'));
    await start({ publishEnabled: true }); await request('AUTO_MODE_STOP'); await request('AUTO_SCAN_STOP');
    await vi.advanceTimersByTimeAsync(1000); // Allow the owned modal to close, without further engagement.
    const before = [...navigation]; const beforeEvents = [...events];
    await vi.advanceTimersByTimeAsync(60000); alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(100);
    expect(navigation).toEqual(before); expect(events).toEqual(beforeEvents); expect(local.autoScanState.status).toBe('stopped');
  });
  it('retains the platform restriction lock on homepage Auto, without bypass or refresh', async () => {
    home(); restrictOnLike = true; emptyDraft = false;
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(['follow', 'like']); expect(navigation).toEqual(['read-list', 'open']); expect(local.platformRestriction).toBeDefined();
    expect(local.autoModeState.status).toBe('paused'); expect(local.autoScanState.status).toBe('paused');
    expect(chrome.tabs.reload).not.toHaveBeenCalled(); expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('continues after an expired request, follows/likes it, and never drafts or publishes', async () => {
    makeup(); assessmentOverrides.serviceDate = { lastAcceptableDate: '2026-10-03', evidence: '10月3日' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    expect(events).toEqual(['follow', 'like']);
    expect(memory.candidates[0]).toMatchObject({ status: 'skipped', assessment: { engagementPolicy: { canLike: true, canFollow: true, canComment: false } } });
    expect(memory.candidates[0].reason).toContain('已过期'); expect(memory.interactions).toHaveLength(0); expect(local.autoModeState.status).toBe('running');
  });
  it.each(['上海化妆师', '美妆老师', '妆妆'])('only likes a relevant post by %s, even if AI mislabels it as a client', async authorName => {
    makeup(); noteOverrides.authorName = authorName;
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    expect(events).toEqual(['like']); expect(memory.follows).toHaveLength(0); expect(memory.interactions).toHaveLength(0);
    expect(memory.candidates[0]).toMatchObject({ followStatus: 'none', likeStatus: 'liked', status: 'skipped' });
  });
  it('only likes a relevant provider even when the model correctly rejects it as customer demand', async () => {
    makeup(); assessmentOverrides = { ...assessmentOverrides, intent: 'supply', decision: 'hard_skip', serviceFit: 'incompatible' };
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1500);
    expect(events).toEqual(['like']); expect(memory.interactions).toHaveLength(0);
  });
  it('rechecks the live author before publishing and continues without an unknown-send lock', async () => {
    makeup(); artistNameAfterDraft = true;
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual(['follow', 'like', 'draft']); expect(memory.interactions).toHaveLength(0);
    expect(memory.candidates[0].status).toBe('skipped'); expect(local.autoModeState.status).toBe('running');
  });
  it('follows and likes a match even when AI produces no comment, and couples likes to follow mode', async () => {
    await start({ likeEnabled: false, publishEnabled: true });
    expect(events).toEqual(['follow', 'like', 'draft']);
    expect(memory.candidates[0]).toMatchObject({ followStatus: 'followed', likeStatus: 'liked', draft: '', status: 'skipped' });
    expect(local.autoModeState).toMatchObject({ followEnabled: true, likeEnabled: true, followed: 1, liked: 1, published: 0, status: 'running' });
    expect(memory.follows[0].status).toBe('followed');
  });
  it('follows, likes and then publishes only an AI-generated usable comment', async () => {
    emptyDraft = false; await start({ publishEnabled: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toEqual(['follow', 'like', 'draft', 'publish']);
    expect(memory.candidates[0].status).toBe('published');
    expect(memory.interactions[0].status).toBe('marked_published');
  });
  it('does not follow or like hard-mismatch posts', async () => {
    mismatch = true; await start();
    expect(events).toEqual([]); expect(memory.follows).toEqual([]);
    expect(memory.candidates[0]).toMatchObject({ status: 'skipped', followStatus: 'none', likeStatus: 'none' });
  });
  it('does not click an already followed author', async () => {
    authorFollowing = true; await start();
    expect(events).toEqual(['like', 'draft']);
    expect(memory.candidates[0].followStatus).toBe('already_following');
    expect(local.autoModeState.followed).toBe(0);
  });
  it('deduplicates one author across multiple matching posts', async () => {
    memory.candidates.push(candidate('6ab7d5ab000000001b02ce06'));
    await start(); await vi.advanceTimersByTimeAsync(4000);
    expect(events.filter(event => event === 'follow')).toHaveLength(1);
    expect(events.filter(event => event === 'like')).toHaveLength(2);
    expect(memory.follows).toHaveLength(1);
    expect(memory.candidates[1].followStatus).toBe('already_following');
  });
  it('does not blindly refollow a recorded author if the live page is now unfollowed', async () => {
    memory.follows.push({ id: authorFollowKey(memory.campaign!.accountLabel, author), accountLabel: memory.campaign!.accountLabel, authorId: author, authorName: '旧作者', authorUrl: `https://www.xiaohongshu.com/user/profile/${author}`, noteId: `xhs:${noteId}`, status: 'followed', createdAt: '2026-10-04', updatedAt: '2026-10-04', reason: '以前关注过' });
    await start(); expect(events).toEqual(['like', 'draft']); expect(memory.candidates[0].followStatus).toBe('skipped');
  });
  it('pauses and persists unknown follows without proceeding to likes or comments', async () => {
    unknownFollow = true; await start();
    expect(events).toEqual(['follow']); expect(local.autoModeState.status).toBe('paused');
    expect(memory.follows[0].status).toBe('unknown');
    expect(memory.candidates[0]).toMatchObject({ followStatus: 'unknown', status: 'needs_review' });
  });
  it.each(['pending', 'unknown'] as const)('does not retry a previous %s author-follow record from a different post or run', async status => {
    memory.follows.push({ id: authorFollowKey(memory.campaign!.accountLabel, author), accountLabel: memory.campaign!.accountLabel, authorId: author, authorName: '旧作者', authorUrl: `https://www.xiaohongshu.com/user/profile/${author}`, noteId: 'xhs:old-post', status, createdAt: '2026-10-04', updatedAt: '2026-10-04', reason: '上次操作中断' });
    await start(); expect(events).toEqual([]); expect(local.autoModeState.status).toBe('paused');
    expect(memory.follows).toHaveLength(1); expect(memory.follows[0].status).toBe(status);
    expect(memory.candidates[0].followStatus).toBe('unknown');
  });
  it('skips unavailable controls safely and keeps likes and AI comments independent', async () => {
    unavailableFollow = true; await start();
    expect(events).toEqual(['like', 'draft']); expect(memory.follows).toHaveLength(0);
    expect(memory.candidates[0].followStatus).toBe('unavailable'); expect(local.autoModeState.status).toBe('running');
  });
  it('retains completed follows and likes when the model gateway disconnects, without duplicating on retry', async () => {
    draftFailures = 1; await start();
    expect(memory.candidates[0]).toMatchObject({ status: 'new', followStatus: 'followed', likeStatus: 'liked' });
    expect(local.autoModeState.gatewayFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(17000);
    expect(events.filter(event => event === 'follow')).toHaveLength(1); expect(events.filter(event => event === 'like')).toHaveLength(1);
    expect(events.filter(event => event === 'draft')).toHaveLength(2);
    expect(memory.candidates[0].status).toBe('skipped');
  });
  it('respects a user stop before the follow click', async () => {
    stopOnAuthorRead = true; await start();
    expect(events).toEqual([]); expect(memory.follows).toHaveLength(0);
    expect(local.autoModeState.status).toBe('stopped'); expect(memory.candidates[0].followStatus).toBe('none');
  });
  it('skips an already commented post without AI, navigation or follow/like/comment actions', async () => {
    memory.interactions.push({ id: 'old-comment', noteId: `xhs:${noteId}`, noteHash: '', accountLabel: memory.campaign!.accountLabel, templateId: null, templateVersion: null, body: '旧评论', status: 'marked_published', source: 'xhs', createdAt: '2026-10-04', markedPublishedAt: '2026-10-04' });
    await start({ publishEnabled: true });
    expect(events).toEqual([]); expect(titleChecks).toEqual([]); expect(openedNoteIds).toEqual([]);
    expect(memory.interactions).toHaveLength(1); expect(memory.candidates[0].status).toBe('skipped');
  });
  it('leaves follow mode disabled for legacy starts that omit the new flag', async () => {
    await start({ followEnabled: false, likeEnabled: false });
    expect(events).toEqual(['draft']); expect(local.autoModeState.followEnabled).toBe(false); expect(memory.follows).toHaveLength(0);
  });
  it('continues AI commenting and the next post when a like remains unconfirmed', async () => {
    likeFailure = 'unknown'; emptyDraft = false; memory.candidates.push(candidate('6ab7d5ab000000001b02ce06'));
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(12000);
    expect(memory.candidates.every(item => item.status === 'published' && item.likeStatus === 'unknown')).toBe(true);
    expect(events.filter(event => event === 'like')).toHaveLength(2);
    expect(events.filter(event => event === 'publish')).toHaveLength(2);
    expect(local.autoModeState).toMatchObject({ status: 'running', published: 2, liked: 0, needsReview: 0 });
    expect(likeProbes).toBe(8);
  });
  it.each(['unknown', 'transport'] as const)('recovers a %s like by read-only confirmation without clicking again', async failure => {
    likeFailure = failure; observedLiked = true;
    await start(); await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual(['follow', 'like', 'draft']); expect(likeProbes).toBe(2);
    expect(memory.candidates[0].likeStatus).toBe('liked'); expect(local.autoModeState.liked).toBe(1);
  });
  it('keeps an unknown like locked across model-gateway retry, without repeating the click', async () => {
    likeFailure = 'unknown'; draftFailures = 1;
    await start(); await vi.advanceTimersByTimeAsync(25000);
    expect(events.filter(event => event === 'like')).toHaveLength(1);
    expect(events.filter(event => event === 'draft')).toHaveLength(2);
    expect(memory.candidates[0]).toMatchObject({ likeStatus: 'unknown', status: 'skipped' });
    expect(local.autoModeState.status).toBe('running');
  });
  it('continues comments when a like control is unavailable before clicking', async () => {
    likeFailure = 'unavailable'; emptyDraft = false;
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1000);
    expect(likeProbes).toBe(0); expect(memory.candidates[0]).toMatchObject({ likeStatus: 'unavailable', status: 'published' });
    expect(local.autoModeState.status).toBe('running');
  });
  it('still stops on a security challenge instead of continuing to comment', async () => {
    likeFailure = 'security'; emptyDraft = false;
    await start({ publishEnabled: true });
    expect(events).toEqual(['follow', 'like']); expect(local.autoModeState.status).toBe('paused');
    expect(memory.candidates[0].status).toBe('needs_review');
  });
  it('recovers legacy like-only pauses on start while preserving the follow and like locks', async () => {
    memory.candidates[0] = { ...memory.candidates[0], status: 'needs_review', likeStatus: 'unknown', followStatus: 'followed', reason: '自动点赞未确认：Error: like_clicked_but_state_unverified',
      note: { id: `xhs:${noteId}`, title: '上海求租', body: '找上海合租房间，预算2000，7号线附近。', completeness: 'complete', capturedAt: '2026-10-05', source: 'xhs' },
      assessment: { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海求租'], reason: '匹配' } };
    emptyDraft = false;
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(['draft', 'publish']); expect(likeProbes).toBe(4);
    expect(memory.candidates[0]).toMatchObject({ status: 'published', likeStatus: 'unknown', followStatus: 'followed' });
  });
  it('does not recover legacy unknown comments or unknown follows as a like-only failure', async () => {
    memory.candidates[0] = { ...memory.candidates[0], status: 'needs_review', likeStatus: 'unknown', followStatus: 'unknown', reason: '自动点赞未确认：Error: like_clicked_but_state_unverified' };
    await start(); expect(memory.candidates[0].status).toBe('needs_review'); expect(events).toEqual([]);
  });
  it('does not repeat a like locked by another search task for the same note', async () => {
    memory.candidates.push({ ...candidate(noteId), id: 'older-task-post', taskId: 'older-task', status: 'skipped', likeStatus: 'unknown' });
    await start(); await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(['follow', 'draft']); expect(likeProbes).toBe(4);
    expect(memory.candidates[0].likeStatus).toBe('unknown');
  });
  it('never requeues a legacy like failure when a comment send is already unknown', async () => {
    memory.candidates[0] = { ...memory.candidates[0], status: 'needs_review', likeStatus: 'unknown', reason: '自动点赞未确认：Error: like_clicked_but_state_unverified',
      note: { id: `xhs:${noteId}`, title: '上海求租', body: '找上海合租房间，预算2000，7号线附近。', completeness: 'complete', capturedAt: '2026-10-05', source: 'xhs' },
      assessment: { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['上海求租'], reason: '匹配' } };
    memory.interactions.push({ id: 'unknown-send', noteId: `xhs:${noteId}`, noteHash: '', accountLabel: memory.campaign!.accountLabel, templateId: null, templateVersion: null, body: '旧评论', status: 'unknown', source: 'xhs', createdAt: '2026-10-04', markedPublishedAt: null });
    await start({ publishEnabled: true }); expect(events).toEqual([]); expect(memory.candidates[0].status).toBe('needs_review');
  });
  it('reports the compiled version without starting an automatic task', async () => {
    expect(await request('EXTENSION_VERSION')).toMatchObject({ version: EXTENSION_VERSION });
    expect(local.autoModeState.status).toBe('stopped'); expect(events).toEqual([]);
  });
  it('uses exactly one same-tab detail session for reading, following, liking and publishing', async () => {
    emptyDraft = false; await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(['follow', 'like', 'draft', 'publish']); expect(navigation).toEqual(['read-list', 'open', 'close']);
    expect(testTabs.get(1)).toBe(memory.tasks[0].sourceUrl);
    expect(chrome.tabs.create).not.toHaveBeenCalled(); expect(chrome.tabs.remove).not.toHaveBeenCalled(); expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
  it('skips a stale unloaded card without ever navigating to its deep link', async () => {
    missingCard = true; await start();
    expect(events).toEqual([]); expect(navigation).toEqual(['read-list']); expect(memory.candidates[0].status).toBe('skipped');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('pauses if closing the detail cannot be verified, instead of opening another note', async () => {
    failClose = true; memory.candidates.push(candidate('6ab7d5ab000000001b02ce06'));
    await start(); await vi.advanceTimersByTimeAsync(5000);
    expect(navigation).toEqual(['read-list', 'open', 'close']); expect(local.autoModeState.status).toBe('paused');
    expect(memory.candidates[1].status).toBe('new');
  });
  it.each(['home', 'search'] as const)('closes an unreadable %s note and continues to the next candidate without interacting with it', async source => {
    if (source === 'home') {
      memory.tasks[0] = { ...memory.tasks[0], source: 'home', keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore?channel=homefeed' };
      testTabs.set(1, memory.tasks[0].sourceUrl);
    }
    unreadableNotes.add(noteId); memory.candidates.push(candidate('6ab7d5ab000000001b02ce06')); emptyDraft = false;
    await start({ followEnabled: false, likeEnabled: false, publishEnabled: false }); await vi.advanceTimersByTimeAsync(20000);
    expect(navigation).toEqual(['read-list', 'open', 'close', 'open', 'close']);
    expect(memory.candidates[0].status).toBe('skipped'); expect(memory.candidates[0].reason).toContain('详情无法可靠读取');
    expect(memory.candidates[1].status).toBe('drafted'); expect(local.autoModeState.status).toBe('running');
    expect(events).toEqual(['draft']); expect(memory.interactions).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled(); expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
  it('stops all jobs and never closes, retries or comments through a 300011 restriction', async () => {
    restrictOnLike = true; emptyDraft = false;
    await start({ publishEnabled: true }); await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(['follow', 'like']); expect(navigation).toEqual(['read-list', 'open']);
    expect(local.autoModeState.status).toBe('paused'); expect(local.autoScanState.status).toBe('paused'); expect(local.demandState.status).toBe('paused');
    expect(local.platformRestriction.reason).toContain('平台限制');
    const retry = await request('AUTO_MODE_START', { taskId: 'task' }); expect(retry.ok).toBe(false);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
  it('checks restrictions before any model calls or detail clicks on start', async () => {
    guardBlocked = true;
    const result = await request('AUTO_MODE_START', { taskId: 'task' });
    expect(result.ok).toBe(false); expect(navigation).toEqual([]); expect(events).toEqual([]);
    expect(local.platformRestriction).toBeDefined();
  });
  it('requires an explicit healthy-page recheck and does not automatically resume jobs', async () => {
    guardBlocked = true; await request('AUTO_MODE_START', { taskId: 'task' });
    expect((await request('PLATFORM_RECHECK', { tabId: 1 })).ok).toBe(false);
    guardBlocked = false; expect((await request('PLATFORM_RECHECK', { tabId: 1 })).ok).toBe(true);
    expect(local.platformRestriction).toBeUndefined(); expect(local.autoModeState.status).toBe('paused'); expect(navigation).toEqual([]);
  });
  it('does not clear a platform restriction by checking an unrelated page or local fixture', async () => {
    local.platformRestriction = { reason: '平台限制', at: '2026-10-05' };
    testTabs.set(1, 'http://127.0.0.1:4173/search.html');
    const result = await request('PLATFORM_RECHECK', { tabId: 1 });
    expect(result.ok).toBe(false); expect(result.reason).toContain('其他页面不能解除限制锁');
    expect(local.platformRestriction).toBeDefined(); expect(navigation).toEqual([]); expect(events).toEqual([]);
  });
  it('does not scroll the shared page while a note is being processed', async () => {
    const result = await request('AUTO_MODE_START', { taskId: 'task', followEnabled: true }); expect(result.ok).toBe(true);
    alarmHandler({ name: 'yuezhuang-auto-scan' });
    await vi.advanceTimersByTimeAsync(1900);
    expect(navigation).toEqual(['read-list', 'open', 'close']);
    expect(local.autoScanState.reason).toContain('同页 Auto');
  });
  it('does not automatically refresh the list when it reaches the bottom', async () => {
    alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(100);
    alarmHandler({ name: 'yuezhuang-auto-scan' }); await vi.advanceTimersByTimeAsync(100);
    expect(navigation).toEqual(['read-list', 'scroll']); expect(chrome.tabs.reload).not.toHaveBeenCalled();
    expect(local.autoScanState.reason).toContain('不自动刷新');
  });
});
