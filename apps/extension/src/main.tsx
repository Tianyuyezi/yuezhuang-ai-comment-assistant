import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { businessTypeLabel, campaignBusinessType, campaignConfigurationIssue, candidateEngagementPolicy, interactionBlocksFirstContact, templateSchema, type Assessment, type BusinessTemplate, type Campaign, type Interaction, type NoteSnapshot, type SearchCandidate, type SearchTask, type Template } from '@yuezhuang/shared';
import { loadBusinessTemplates, loadCampaign, loadCampaignSnapshots, loadInteractions, loadSearchCandidates, loadSearchTasks, loadTemplates, saveInteraction, saveSearchCandidate, saveSearchTask, saveTemplates } from './storage';
import { BusinessTemplates, type BusinessTemplateAction } from './BusinessTemplates';
import { ModelSettings } from './ModelSettings';
import { createModelSettingsClient } from './modelSettingsClient';
import { autoTaskLabel, autoTaskSource, isXhsTaskPage, type AutoSource } from './xhs';
import { BrowseTaskControls } from './BrowseTaskControls';
import { connectedPageMessage, ensurePageConnection } from './pageConnection';
import { initialAutoScanState, orderedCollection, type AutoScanState } from './autoScan';
import { orderedCandidates } from './candidateOrder';
import { AutoProgress } from './AutoProgress';
import { saveSearchCandidateOrder } from './storage';
import { initialAutoModeState, recheckableAfterPromptUpdate, retryableAfterCommentCoverageFix, type AutoModeState } from './autoMode';
import { targetIntentIsUsable } from './noteSafety';
import { initialDemandState, isDemandPage, matchesDemandListTab, type DemandListTab, type DemandRow, type DemandState } from './demand';
import './styles.css';
import { type AuthorFollow } from '@yuezhuang/shared';
import { loadAuthorFollows } from './storage';
import { ensureBackgroundVersion, EXTENSION_VERSION } from './extensionVersion';
import { publicationFailureMessage, publicationRecord, type PublicationResult } from './publicationResult';

type Tab = '首页' | '找需求' | '搜索' | '候选' | '话术' | '设置' | '记录';
type Result<T> = { ok: boolean; reason?: string; note?: T; sourceUrl?: string; results?: Array<{ noteId: string; url: string; title: string; snippet: string }> };
const gatewayUrl = 'http://127.0.0.1:3417';
const splitWords = (value: string) => value.split(/[,，、\n]/).map(word => word.trim()).filter(Boolean);
const joinWords = (words: string[]) => words.join('，');

async function gatewayHealth(): Promise<{ mode: string; modelId: string }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${gatewayUrl}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally { window.clearTimeout(timeout); }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('无法确认当前标签页');
  return tab;
}
async function pageMessage<T>(message: object): Promise<Result<T>> {
  const tab = await activeTab();
  return connectedPageMessage(tab.id!, message);
}

function App() {
  const [tab, setTab] = useState<Tab>('首页');
  const [gateway, setGateway] = useState('检查中');
  const [platformNotice, setPlatformNotice] = useState('');
  const [mode, setMode] = useState('mock');
  const [campaign, setCampaign] = useState<Campaign>({ id: 'active', name: '', offering: '', targetIntent: '', cities: [], demandKeywords: [], exclusionKeywords: [], accountLabel: '本地账号', confirmedAt: null });
  const [businessTemplates, setBusinessTemplates] = useState<BusinessTemplate[]>([]);
  const [campaignSnapshots, setCampaignSnapshots] = useState<Campaign[]>([]);
  const [recordTemplateFilter, setRecordTemplateFilter] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [browseSource, setBrowseSource] = useState<AutoSource>('search');
  const [tasks, setTasks] = useState<SearchTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [candidateFilter, setCandidateFilter] = useState<'all' | 'new' | 'needs_review' | 'eligible' | 'drafted' | 'skipped' | 'published'>('all');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewedNoteId, setPreviewedNoteId] = useState<string | null>(null);
  const [reviewedNoteId, setReviewedNoteId] = useState<string | null>(null);
  const [message, setMessage] = useState('在设置中管理业务模板；激活后可开始找需求或创建搜索任务。');
  const [busy, setBusy] = useState(false);
  const [pageConnecting, setPageConnecting] = useState(false);
  const [autoScan, setAutoScan] = useState<AutoScanState>(initialAutoScanState);
  const [autoMode, setAutoMode] = useState<AutoModeState>(initialAutoModeState);
  const [pairingToken, setPairingToken] = useState(() => sessionStorage.getItem('assistant-pairing-token') ?? '');
  const modelSettingsClient = useMemo(() => {
    const client = createModelSettingsClient(gatewayUrl, pairingToken);
    return { ...client, save: async (value: Parameters<typeof client.save>[0]) => {
      const prepared = await chrome.runtime.sendMessage({ type: 'MODEL_CONFIG_PREPARE' }) as { ok: boolean; lockId?: string; reason?: string };
      if (!prepared.ok || !prepared.lockId) throw new Error(prepared.reason ?? 'model_config_busy');
      try { return await client.save(value); }
      finally { await chrome.runtime.sendMessage({ type: 'MODEL_CONFIG_FINISH', lockId: prepared.lockId }).catch(() => undefined); }
    } };
  }, [pairingToken]);
  const draftStyle = campaign.commentStyle ?? localStorage.getItem('assistant-draft-style') ?? '自然、简短、根据帖子具体需求回应，不夸大';
  const [commentDiagnostic, setCommentDiagnostic] = useState('');
  const [publishEnabled, setPublishEnabled] = useState(false);
  const [likeEnabled, setLikeEnabled] = useState(false);
  const [followEnabled, setFollowEnabled] = useState(false);
  const [authorFollows, setAuthorFollows] = useState<AuthorFollow[]>([]);
  const [paceEnabled, setPaceEnabled] = useState(() => localStorage.getItem('assistant-pace-enabled') === 'true');
  const [demandState, setDemandState] = useState<DemandState>(initialDemandState);
  const [demandRows, setDemandRows] = useState<DemandRow[]>([]);
  const [demandKeyword, setDemandKeyword] = useState('');
  const [demandFilter, setDemandFilter] = useState<DemandListTab>('all');
  const [demandStatusFilter, setDemandStatusFilter] = useState('all');
  const [demandTagFilter, setDemandTagFilter] = useState('');
  const [demandSourceFilter, setDemandSourceFilter] = useState<'all' | 'home' | 'search'>('all');
  const [demandSort, setDemandSort] = useState<'discovered' | 'published'>('discovered');
  const [demandPublishedAfter, setDemandPublishedAfter] = useState('');
  const [demandProfileFilter, setDemandProfileFilter] = useState('all');
  const currentTask = tasks.find(item => item.id === activeTaskId && autoTaskSource(item) === browseSource) ?? tasks.find(item => item.campaignId === campaign.id && autoTaskSource(item) === browseSource);
  const taskCandidates = orderedCandidates(candidates.filter(item => item.taskId === currentTask?.id));
  const configurationIssue = campaignConfigurationIssue(campaign);
  const visibleCandidates = taskCandidates.filter(item => candidateFilter === 'all' || item.status === candidateFilter);
  const retryableCandidates = taskCandidates.filter(item => retryableAfterCommentCoverageFix(item) && !interactionBlocksFirstContact(interactions, item.noteId, campaign.accountLabel));
  const recheckableCandidates = taskCandidates.filter(item => recheckableAfterPromptUpdate(item, interactions, campaign.accountLabel));
  const selected = taskCandidates.find(item => item.id === selectedId);
  const unknownTaskComments = interactions.filter(item => item.status === 'unknown' && item.source === 'xhs' && item.accountLabel === campaign.accountLabel && taskCandidates.some(candidate => candidate.noteId === item.noteId));
  const belongsToCurrentCampaign = (item: SearchCandidate) => tasks.find(task => task.id === item.taskId)?.campaignId === campaign.id;

  useEffect(() => {
    const refreshGateway = () => { void gatewayHealth().then(data => { setGateway(`已连接 · ${data.mode} · ${data.modelId}`); setMode(data.mode); }).catch(() => { setGateway('网关暂不可用 · 自动重连中'); setMode('mock'); }); };
    refreshGateway();
    const gatewayTimer = window.setInterval(refreshGateway, 10_000);
    void refreshBusinessConfiguration().catch(() => setMessage('业务模板读取失败'));
    void loadSearchTasks().then(setTasks).catch(() => setMessage('搜索任务读取失败'));
    void loadSearchCandidates().then(setCandidates).catch(() => setMessage('候选队列读取失败'));
    void loadTemplates([]).then(setTemplates).catch(() => setMessage('话术库读取失败'));
    void loadInteractions().then(setInteractions).catch(() => setMessage('记录读取失败'));
    void loadAuthorFollows().then(setAuthorFollows).catch(() => setMessage('关注记录读取失败'));
    void chrome.storage.local.get('platformRestriction').then(result => setPlatformNotice(result.platformRestriction?.reason ?? ''));
    void chrome.runtime.sendMessage({ type: 'AUTO_SCAN_STATUS' }).then((result: { ok: boolean; state?: AutoScanState }) => { if (result.ok && result.state) setAutoScan(result.state); });
    void chrome.runtime.sendMessage({ type: 'AUTO_MODE_STATUS' }).then((result: { ok: boolean; state?: AutoModeState }) => { if (result.ok && result.state) setAutoMode(result.state); });
    void chrome.runtime.sendMessage({ type: 'DEMAND_STATUS' }).then((result: { ok: boolean; state?: DemandState }) => { if (result.ok && result.state) setDemandState(result.state); });
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.autoScanState) setAutoScan(changes.autoScanState.newValue as AutoScanState);
      if (changes.autoModeState) setAutoMode(changes.autoModeState.newValue as AutoModeState);
      if (changes.demandState) setDemandState(changes.demandState.newValue as DemandState);
      if (changes.platformRestriction) setPlatformNotice(changes.platformRestriction.newValue?.reason ?? '');
      if (changes.businessTemplatesRevision) void refreshBusinessConfiguration().catch(() => setMessage('业务模板读取失败'));
      if (changes.autoScanState || changes.autoModeState) {
        void loadSearchCandidates().then(setCandidates);
        void loadSearchTasks().then(setTasks);
        void loadAuthorFollows().then(setAuthorFollows);
        void loadInteractions().then(setInteractions);
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => { window.clearInterval(gatewayTimer); chrome.storage.onChanged.removeListener(onStorageChanged); };
  }, []);

  useEffect(() => {
    setKeyword(campaign.defaultSearchKeywords?.[0] ?? '');
    setDemandKeyword(campaign.defaultSearchKeywords?.[0] ?? '');
    setActiveTaskId(null); setSelectedId(null); setPublishEnabled(false); setLikeEnabled(false); setFollowEnabled(false);
  }, [campaign.id]);

  useEffect(() => {
    if (autoMode.status !== 'running') return;
    setPublishEnabled(autoMode.publishEnabled); setLikeEnabled(autoMode.likeEnabled); setFollowEnabled(autoMode.followEnabled ?? false);
  }, [autoMode.status, autoMode.runId, campaign.id]);

  useEffect(() => {
    const runningTaskId = autoMode.status === 'running' ? autoMode.taskId : autoScan.status === 'running' ? autoScan.taskId : null;
    const runningTask = tasks.find(item => item.id === runningTaskId);
    if (runningTask) { setBrowseSource(autoTaskSource(runningTask)); setActiveTaskId(runningTask.id); }
  }, [tasks, autoMode.status, autoMode.taskId, autoScan.status, autoScan.taskId]);

  async function refreshBusinessConfiguration() {
    const [templates, active, snapshots] = await Promise.all([loadBusinessTemplates(), loadCampaign(), loadCampaignSnapshots()]);
    setBusinessTemplates(templates); setCampaign(active); setCampaignSnapshots(snapshots);
  }
  async function businessTemplateAction(action: BusinessTemplateAction, templateId?: string, template?: BusinessTemplate) {
    if (busy) throw new Error('当前操作尚未结束，请稍后再修改业务模板。');
    setBusy(true);
    try {
      const result = await chrome.runtime.sendMessage({ type: action, templateId, template }) as { ok: boolean; reason?: string; templates?: BusinessTemplate[]; campaign?: Campaign; savedId?: string; notice?: string };
      if (!result.ok || !result.templates || !result.campaign) throw new Error(result.reason ?? '业务模板操作失败。');
      setBusinessTemplates(result.templates); setCampaign(result.campaign);
      setCampaignSnapshots(await loadCampaignSnapshots());
      setMessage(result.notice ?? '业务模板已更新。');
      return result.templates.find(item => item.id === result.savedId);
    } catch (error) { setMessage(String(error).replace(/^Error: /, '')); throw error; }
    finally { setBusy(false); }
  }

  useEffect(() => { if (tab === '找需求') void refreshDemandRows(); }, [tab, campaign.id, demandState.totalRead]);

  useEffect(() => {
    if (demandState.status !== 'running') return;
    const timer = window.setInterval(() => {
      void chrome.runtime.sendMessage({ type: 'DEMAND_STATUS' }).then((result: { ok: boolean; state?: DemandState }) => {
        if (result.ok && result.state) setDemandState(result.state);
      }).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [demandState.status]);

  useEffect(() => {
    if (autoScan.status !== 'running' && autoMode.status !== 'running') return;
    const timer = window.setInterval(() => {
      void chrome.runtime.sendMessage({ type: 'AUTO_SCAN_STATUS' }).catch(() => undefined);
      void chrome.runtime.sendMessage({ type: 'AUTO_MODE_STATUS' }).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [autoScan.status, autoMode.status]);

  function headers() { return { 'content-type': 'application/json', ...(pairingToken && !/^sk-/i.test(pairingToken) ? { 'x-yuezhuang-pairing-token': pairingToken } : {}) }; }
  async function demandApi<T>(path: string, method: 'GET' | 'PATCH' = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${gatewayUrl}${path}`, { method, headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }
  async function refreshDemandRows() {
    try { setDemandRows(await demandApi<DemandRow[]>('/v1/demand/records')); }
    catch (error) { setMessage(`找需求记录读取失败：${String(error)}`); }
  }
  async function openDemandPage(source: 'home' | 'search') {
    if (!campaign.confirmedAt) return setMessage('请先到设置中确认业务画像。');
    if (source === 'search' && !demandKeyword.trim()) return setMessage('请先输入找需求关键词。');
    const url = source === 'home' ? 'https://www.xiaohongshu.com/explore' : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(demandKeyword.trim())}`;
    try {
      const active = await activeTab();
      if (source === 'home') await chrome.tabs.update(active.id!, { url });
      else {
        const result = await pageMessage({ type: 'ASSISTANT_UI_SEARCH', keyword: demandKeyword.trim() });
        if (!result.ok) throw new Error(result.reason ?? '请在当前小红书页面手动搜索');
      }
      setMessage('已在当前标签页打开页面。等待结果加载后点击“开始找需求”。');
    }
    catch (error) { setMessage(`打开页面失败：${String(error)}`); }
  }
  async function startDemand(source: 'home' | 'search') {
    try {
      await ensureBackgroundVersion();
      const active = await activeTab();
      const keyword = source === 'search' ? demandKeyword.trim() : null;
      if (!active.url || !isDemandPage(active.url, source, keyword)) throw new Error('当前标签页不是对应的小红书首页或搜索页');
      await chrome.storage.session.set({ gatewayPairingToken: pairingToken && !/^sk-/i.test(pairingToken) ? pairingToken : '' });
      const result = await chrome.runtime.sendMessage({ type: 'DEMAND_START', tabId: active.id, source, keyword }) as { ok: boolean; reason?: string; state?: DemandState };
      if (!result.ok || !result.state) throw new Error(result.reason ?? '启动失败');
      setDemandState(result.state);
      setMessage('找需求已启动：只分析列表卡片，短暂停顿后持续下拉，直到你停止或遇到异常；不会打开详情或发送评论。');
    } catch (error) { setMessage(`找需求未启动：${String(error)}`); }
  }
  async function stopDemand() {
    const result = await chrome.runtime.sendMessage({ type: 'DEMAND_STOP' }) as { ok: boolean; reason?: string; state?: DemandState };
    if (result.ok && result.state) { setDemandState(result.state); setMessage('找需求已停止。'); }
    else setMessage(`停止失败：${result.reason ?? '未知原因'}`);
  }
  async function patchDemand(row: DemandRow, patch: { status?: DemandRow['manualStatus']; customTags?: string[]; note?: string; opened?: boolean }) {
    try {
      const updated = await demandApi<DemandRow>(`/v1/demand/records/${encodeURIComponent(row.noteId)}`, 'PATCH', { campaignId: row.campaignId, ...patch });
      setDemandRows(rows => rows.map(item => item.noteId === updated.noteId && item.campaignId === updated.campaignId ? updated : item));
      return true;
    } catch (error) { setMessage(`记录更新失败：${String(error)}`); return false; }
  }
  async function openDemand(row: DemandRow) {
    try {
      const url = new URL(row.url);
      if (url.hostname !== 'www.xiaohongshu.com' || !url.pathname.endsWith(`/${row.noteId.slice(4)}`)) throw new Error('原帖链接与 ID 不符');
      const active = await activeTab();
      await chrome.tabs.update(active.id!, { url: row.url });
      if (await patchDemand(row, { opened: true })) setMessage('已打开原帖并移入“已查阅”；只有你手动标记后才会记录为“已评论”。');
    } catch (error) { setMessage(`打开原帖失败：${String(error)}`); }
  }
  async function persistCandidate(item: SearchCandidate) {
    await saveSearchCandidate(item);
    setCandidates(items => [item, ...items.filter(existing => existing.id !== item.id)]);
  }
  async function retryOldCoverageCandidates() {
    if (autoMode.status === 'running') return setMessage('请先停止 Auto，再调整旧候选队列。');
    if (!retryableCandidates.length) return setMessage('没有可按旧评论加载规则重新检查的候选。');
    setBusy(true);
    try {
      const ids = new Set(retryableCandidates.map(item => item.id));
      const refreshed = retryableCandidates.map(item => ({ ...item, status: 'new' as const, reason: '旧版评论加载规则待重新读取；尚未重新确认需求或发布评论。' }));
      for (const item of refreshed) await saveSearchCandidate(item);
      const replacements = new Map(refreshed.map(item => [item.id, item]));
      setCandidates(items => items.map(item => ids.has(item.id) ? replacements.get(item.id)! : item));
      setMessage(`已将 ${refreshed.length} 条旧版完整性待复核候选重新排队。Auto 仍关闭；重新开启后会逐帖核验。`);
    } catch (error) { setMessage(`重新排队失败：${String(error)}`); }
    finally { setBusy(false); }
  }
  async function recheckCurrentTask() {
    if (autoMode.status === 'running') return setMessage('请先停止 Auto，再重新复核旧候选。');
    if (!currentTask || currentTask.campaignId !== campaign.id || !campaign.confirmedAt) return setMessage('当前任务不属于已确认的业务画像，请重新创建搜索任务。');
    if (!recheckableCandidates.length) return setMessage('当前任务没有可安全重新复核的旧候选。');
    setBusy(true);
    try {
      const refreshed = recheckableCandidates.map(item => ({ ...item, status: 'new' as const, reason: '提示词或业务资料变化后待重新核验；尚未评论或点赞。', note: null, draft: '', assessment: null, promptVersion: null }));
      for (const item of refreshed) await saveSearchCandidate(item);
      const replacements = new Map(refreshed.map(item => [item.id, item]));
      setCandidates(items => items.map(item => replacements.get(item.id) ?? item));
      setMessage(`已将当前任务 ${refreshed.length} 条旧候选重新排队。Auto 没有启动；重新开启后会重新读取原帖、调用模型判断。`);
    } catch (error) { setMessage(`重新复核排队失败：${String(error)}`); }
    finally { setBusy(false); }
  }
  function changeBrowseSource(source: AutoSource) {
    if (autoMode.status === 'running' || autoScan.status === 'running' || demandState.status === 'running') return setMessage('请先停止当前任务，再切换浏览来源。');
    setBrowseSource(source); setActiveTaskId(null); setSelectedId(null);
    setPublishEnabled(false); setLikeEnabled(false); setFollowEnabled(false);
    setTab('搜索');
    setMessage(source === 'home' ? '已选择首页推荐流。请打开小红书首页，绑定当前首页，再勾选需要的动作并开启 Auto。尚未启动。' : '已选择搜索结果。请搜索并绑定当前页，再开启 Auto。尚未启动。');
  }
  async function openSearch() {
    if (!campaign.confirmedAt) return setMessage('请先确认业务资料。');
    if (browseSource === 'search' && !keyword.trim()) return setMessage('请输入搜索关键词。');
    setBusy(true);
    try {
      if (autoMode.status === 'running' || autoScan.status === 'running' || demandState.status === 'running') throw new Error('请先停止当前任务，再绑定新的浏览任务。');
      await ensureBackgroundVersion();
      const taskKeyword = browseSource === 'home' ? '' : keyword.trim();
      const active = await activeTab();
      if (browseSource === 'home' && (!active.url || !isXhsTaskPage(active.url, { source: 'home', keyword: '' }))) throw new Error('当前页面是搜索结果或详情，不是首页。请先打开小红书首页，或把浏览来源切换为“关键词搜索结果”。');
      const result = await pageMessage(browseSource === 'home' ? { type: 'ASSISTANT_PAGE_GUARD' } : { type: 'ASSISTANT_UI_SEARCH', keyword: taskKeyword });
      if (!result.ok || !result.sourceUrl || !isXhsTaskPage(result.sourceUrl, { source: browseSource, keyword: taskKeyword })) throw new Error(result.reason ?? (browseSource === 'home' ? '请先手动打开小红书首页并关闭详情，再绑定当前首页。' : '请在当前小红书首页/搜索页手动搜索，然后绑定任务。'));
      const task: SearchTask = { id: crypto.randomUUID(), campaignId: campaign.id, campaignName: campaign.name, businessTemplateId: campaign.businessTemplateId, businessTemplateVersion: campaign.businessTemplateVersion, source: browseSource, keyword: taskKeyword, createdAt: new Date().toISOString(), sourceUrl: result.sourceUrl, status: 'opened' };
      await saveSearchTask(task);
      setTasks(items => [task, ...items]);
      setActiveTaskId(task.id);
      setPublishEnabled(false); setLikeEnabled(false); setFollowEnabled(false);
      setMessage(browseSource === 'home' ? '已绑定当前首页，没有搜索或跳转。勾选需要的动作并开启 Auto 后，会逐帖判断、处理完再下拉。' : '已绑定当前搜索页并保留筛选。勾选需要的动作并开启 Auto 后，会同页点开和关闭详情。');
    } catch (error) { setMessage(`绑定任务失败：${String(error)}`); }
    finally { setBusy(false); }
  }
  async function recheckPlatform() {
    try {
      await ensureBackgroundVersion();
      const active = await activeTab();
      const result = await chrome.runtime.sendMessage({ type: 'PLATFORM_RECHECK', tabId: active.id }) as { ok: boolean; reason?: string; notice?: string };
      if (!result.ok) throw new Error(result.reason ?? '仍无法确认平台状态');
      setPlatformNotice(''); setMessage(result.notice ?? '检查完成，任务未自动启动。');
    } catch (error) { setMessage(`平台状态检查失败：${String(error)}`); }
  }
  async function reconnectPage() {
    setPageConnecting(true);
    try {
      if (autoMode.status === 'running' || autoScan.status === 'running' || demandState.status === 'running') throw new Error('请先停止正在运行的任务，再重新连接。');
      await ensureBackgroundVersion(); const active = await activeTab();
      await ensurePageConnection(active.id!);
      setMessage('当前页面已连接新版脚本；没有刷新、跳转、启动任务或发送互动。请确认浏览来源后绑定任务。');
    } catch (error) { setMessage(`页面连接失败：${String(error).replace(/^Error: /, '')}`); }
    finally { setPageConnecting(false); }
  }
  async function collectResults() {
    if (!currentTask) return setMessage('请先绑定当前首页或搜索页。');
    if (currentTask.campaignId !== campaign.id) return setMessage('浏览任务属于旧业务画像，请重新绑定。');
    try {
      if (autoMode.status === 'running' || autoScan.status === 'running') throw new Error('请先停止 Auto 和自动收集再手动收集。');
      const result = await pageMessage<never>({ type: 'ASSISTANT_FEED_RESULTS', source: autoTaskSource(currentTask), expectedKeyword: currentTask.keyword });
      if (!result.ok || !result.results) return setMessage(`无法收集：${result.reason ?? '页面结构不明'}`);
      const page = new URL(result.sourceUrl!);
      if (page.hostname === 'www.xiaohongshu.com' && !isXhsTaskPage(result.sourceUrl!, currentTask)) return setMessage('当前页面与任务来源不一致，请返回绑定的首页/搜索列表。');
      const now = new Date().toISOString();
      const { additions, updates } = orderedCollection(currentTask, await loadSearchCandidates(), result.results, now, true);
      for (const item of updates) await saveSearchCandidateOrder(item.id, item.listOrder!);
      for (const item of additions) await saveSearchCandidate(item);
      setCandidates(await loadSearchCandidates());
      const updated = { ...currentTask, status: 'collected' as const };
      await saveSearchTask(updated);
      setTasks(items => items.map(item => item.id === updated.id ? updated : item));
      setMessage(`收集 ${additions.length} 条新候选。只读取当前已加载结果，没有自动翻页。`);
      setTab('候选');
    } catch (error) { setMessage(`收集失败：${String(error)}`); }
  }
  async function startAutoScan() {
    if (!currentTask) return setMessage('请先绑定当前首页或搜索页。');
    try {
      await ensureBackgroundVersion();
      const active = await activeTab();
      const result = await chrome.runtime.sendMessage({ type: 'AUTO_SCAN_START', taskId: currentTask.id, tabId: active.id, paceEnabled }) as { ok: boolean; reason?: string; state?: AutoScanState };
      if (!result.ok || !result.state) throw new Error(result.reason ?? '启动失败');
      setAutoScan(result.state);
      setMessage(`自动收集已启动。本轮新增 ${result.state.lastAdded} 条；仅收集候选，不会自动评论。`);
    } catch (error) { setMessage(`自动收集未启动：${String(error)}`); }
  }
  async function stopAutoScan() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'AUTO_SCAN_STOP' }) as { ok: boolean; reason?: string; state?: AutoScanState };
      if (!result.ok || !result.state) throw new Error(result.reason ?? '停止失败');
      setAutoScan(result.state);
      setMessage('自动收集已停止。');
    } catch (error) { setMessage(`停止自动收集失败：${String(error)}`); }
  }
  async function changePacing(enabled: boolean) {
    const previous = paceEnabled;
    setPaceEnabled(enabled);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'AUTO_PACE_SET', paceEnabled: enabled }) as { ok: boolean; reason?: string };
      if (!result.ok) throw new Error(result.reason ?? '切换失败');
      localStorage.setItem('assistant-pace-enabled', String(enabled));
      setMessage(enabled ? '已启用 3–5 分钟等待。' : '已关闭等待：继续逐条处理和向下收集。');
    } catch (error) { setPaceEnabled(previous); setMessage(`切换间隔失败：${String(error)}`); }
  }
  async function startAutoMode() {
    if (!currentTask) return setMessage('请先绑定当前首页或搜索页。');
    if (!targetIntentIsUsable(campaign.targetIntent)) return setMessage('目标客户需求描述无效。请到设置中修正并重新确认业务资料。');
    if (configurationIssue) return setMessage(configurationIssue);
    try {
      await ensureBackgroundVersion();
      const health = await gatewayHealth();
      setGateway(`已连接 · ${health.mode} · ${health.modelId}`); setMode(health.mode);
      if (health.mode !== 'real') throw new Error('当前网关为 Mock 模式。请先启动真实模型网关。');
      const active = await activeTab();
      if (!active.url || !isXhsTaskPage(active.url, currentTask)) throw new Error('请在该任务对应的小红书首页/搜索列表启动 Auto。');
      await chrome.storage.session.set({ gatewayPairingToken: pairingToken && !/^sk-/i.test(pairingToken) ? pairingToken : '' });
      if (autoScan.status === 'running' && autoScan.tabId !== active.id) throw new Error('自动收集绑定了另一个标签页，请先停止它，再在当前页启动 Auto。');
      if (autoScan.status !== 'running' || autoScan.taskId !== currentTask.id) {
        const scan = await chrome.runtime.sendMessage({ type: 'AUTO_SCAN_START', taskId: currentTask.id, tabId: active.id, paceEnabled }) as { ok: boolean; reason?: string; state?: AutoScanState };
        if (!scan.ok || !scan.state) throw new Error(scan.reason ?? '自动收集启动失败');
        setAutoScan(scan.state);
      }
      const result = await chrome.runtime.sendMessage({ type: 'AUTO_MODE_START', taskId: currentTask.id, style: draftStyle, publishEnabled, likeEnabled, followEnabled, paceEnabled }) as { ok: boolean; reason?: string; state?: AutoModeState };
      if (!result.ok || !result.state) throw new Error(result.reason ?? 'Auto 启动失败');
      setAutoMode(result.state);
      setMessage(`Auto 已启动：符合当前业务条件的帖子${followEnabled ? '会关注作者并点赞；' : likeEnabled ? '会点赞，不关注；' : '不关注或点赞；'}${publishEnabled ? '评论由 AI 判断生成后发送。' : 'AI 只生成草稿，不发送评论。'}`);
    } catch (error) { setMessage(/VersionError/.test(String(error)) ? '插件新旧版本未同步，请关闭侧边栏，在 Chrome 扩展页重载最新插件后重新打开。现有记录保留。' : `Auto 未启动：${String(error)}`); }
  }
  async function stopAutoMode() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'AUTO_MODE_STOP' }) as { ok: boolean; reason?: string; state?: AutoModeState };
      if (!result.ok || !result.state) throw new Error(result.reason ?? '停止失败');
      setAutoMode(result.state);
      const scan = await chrome.runtime.sendMessage({ type: 'AUTO_SCAN_STOP' }) as { ok: boolean; reason?: string; state?: AutoScanState };
      if (!scan.ok || !scan.state) throw new Error(scan.reason ?? '自动收集停止失败');
      setAutoScan(scan.state);
      setMessage('Auto 和自动下拉收集均已停止；正在结束的详情会安全返回原列表。');
    } catch (error) { setMessage(`停止 Auto 失败：${String(error)}`); }
  }
  async function openCandidate(item: SearchCandidate) {
    try {
      const active = await activeTab();
      await chrome.tabs.update(active.id!, { url: item.url });
      setSelectedId(item.id);
      setPreviewedNoteId(null); setReviewedNoteId(null);
      setMessage('已打开候选帖子。页面加载完成后点击“读取并分析当前帖”。');
    } catch (error) { setMessage(`打开候选失败：${String(error)}`); }
  }
  async function openAndAnalyze(item: SearchCandidate) {
    if (!belongsToCurrentCampaign(item)) return setMessage('候选属于旧业务画像，请重新搜索。');
    setBusy(true);
    try {
      const active = await activeTab();
      await chrome.tabs.update(active.id!, { url: item.url });
      setSelectedId(item.id); setPreviewedNoteId(null); setReviewedNoteId(null);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 650));
        try {
          const result = await connectedPageMessage<Result<NoteSnapshot>>(active.id!, { type: 'ASSISTANT_READ_NOTE' });
          if (result.ok && result.note?.id === item.noteId && (result.note.completeness === 'complete' || result.note.resolutionEvidence || attempt === 19)) {
            await analyzeCandidate(item);
            return;
          }
        } catch { /* 页面跳转时内容脚本可能尚未就绪，继续有界重试。 */ }
      }
      setMessage('帖子已打开，但未能可靠读取。请检查页面后点“读取并分析当前帖”。');
    } catch (error) { setMessage(`打开并分析失败：${String(error)}`); }
    finally { setBusy(false); }
  }
  async function analyzeCandidate(item: SearchCandidate, manualConfirmed = false) {
    setBusy(true);
    try {
      if (!belongsToCurrentCampaign(item)) throw new Error('候选属于旧业务画像，请重新搜索。');
      if (!targetIntentIsUsable(campaign.targetIntent)) throw new Error('目标客户需求描述无效，请先在设置中修正并重新确认。');
      const result = await pageMessage<NoteSnapshot>({ type: 'ASSISTANT_READ_NOTE' });
      if (!result.ok || !result.note) throw new Error(result.reason ?? '无法读取帖子');
      if (manualConfirmed && (reviewedNoteId !== item.noteId || !item.note || result.note.title !== item.note.title || result.note.body !== item.note.body)) throw new Error('请先展开并核对当前提取内容；内容变化后需重新审核。');
      const note = manualConfirmed ? { ...result.note, completeness: 'complete' as const } : result.note;
      if (note.id !== item.noteId) throw new Error('当前帖子与所选候选 ID 不一致');
      if (note.resolutionEvidence) {
        await persistCandidate({ ...item, note, status: 'skipped', reason: `原帖或评论显示需求已解决：${note.resolutionEvidence}`.slice(0, 500) });
        setMessage('作者或评论区已显示需求解决，已跳过，不生成评论。');
        return;
      }
      if (interactionBlocksFirstContact(interactions, item.noteId, campaign.accountLabel)) {
        await persistCandidate({ ...item, note, status: 'skipped', reason: '此账号已有填入或发布记录，需人工核查。' });
        setMessage('重复互动保护：已跳过。');
        return;
      }
      const response = await fetch(`${gatewayUrl}/v1/candidate/analyze`, { method: 'POST', headers: headers(), body: JSON.stringify({ campaign, note }) });
      const data = await response.json() as Assessment & { error?: string; promptVersion?: string; decisionSource?: 'model' | 'safety_rule' };
      if (!response.ok) throw new Error(data.error ?? '模型分析失败');
      const policy = candidateEngagementPolicy(campaign, note, data);
      const status = !policy.canComment ? 'skipped' : data.decision === 'eligible_for_review' ? 'eligible' : data.decision === 'hard_skip' ? 'skipped' : 'needs_review';
      await persistCandidate({ ...item, note, authorName: note.authorName ?? item.authorName, status, reason: `${data.decisionSource === 'safety_rule' ? '安全规则复核' : '模型判断'}：${data.reason}；${policy.reason}；证据：${data.evidence.join('、') || '无'}`.slice(0, 500), promptVersion: data.promptVersion ?? null, assessment: { ...data, engagementPolicy: policy } });
      if (manualConfirmed) setReviewedNoteId(null);
      setMessage(`分析完成：${data.intent} / ${data.decision}。${manualConfirmed ? '完整性由你人工确认。' : ''}请人工核对结果。`);
    } catch (error) { setMessage(`分析未完成：${String(error)}`); }
    finally { setBusy(false); }
  }
  function changeDraft(item: SearchCandidate, draft: string) {
    if (!belongsToCurrentCampaign(item) || !['eligible', 'drafted'].includes(item.status)) return;
    setCandidates(items => items.map(value => value.id === item.id ? { ...value, draft, status: draft ? 'drafted' : 'eligible' } : value));
  }
  async function persistDraft(item: SearchCandidate) {
    await saveSearchCandidate(item);
  }
  async function useTemplate(item: SearchCandidate, template: Template) {
    if (!campaign.confirmedAt || !belongsToCurrentCampaign(item) || item.status !== 'eligible' || !item.note) return setMessage('请先确认当前业务资料、完整帖子与适用性。');
    const updated = { ...item, draft: template.body, status: 'drafted' as const };
    await persistCandidate(updated);
    const next = templates.map(value => value.id === template.id ? { ...value, selectionCount: value.selectionCount + 1 } : value);
    setTemplates(next); await saveTemplates(next);
  }
  async function generateDraft(item: SearchCandidate) {
    if (!campaign.confirmedAt || !belongsToCurrentCampaign(item) || item.status !== 'eligible' || !item.note || item.note.completeness !== 'complete' || !item.assessment) return setMessage('请先完成当前帖分析与内容完整性核对。');
    setBusy(true);
    try {
      const response = await fetch(`${gatewayUrl}/v1/draft/create`, { method: 'POST', headers: headers(), body: JSON.stringify({ campaign, note: item.note, assessment: item.assessment, style: draftStyle }) });
      const data = await response.json() as { body?: string; warnings?: string[]; promptVersion?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? '草稿生成失败');
      if (!data.body?.trim()) return setMessage(`没有生成草稿：${data.warnings?.join('；') || '内容不足'}`);
      await persistCandidate({ ...item, draft: data.body, status: 'drafted', reason: `${item.reason}；草稿待人工审核` });
      setMessage(`草稿已生成但未填入或发布。${data.warnings?.join('；') ?? ''} 请逐字核对。`);
    } catch (error) { setMessage(`草稿生成失败：${String(error)}`); }
    finally { setBusy(false); }
  }
  async function record(item: SearchCandidate, status: Interaction['status']) {
    const interaction: Interaction = { id: crypto.randomUUID(), noteId: item.noteId, noteHash: `${item.note?.title}:${item.note?.body}`.slice(0, 200), accountLabel: campaign.accountLabel, templateId: null, templateVersion: null, businessTemplateId: campaign.businessTemplateId, businessTemplateName: campaign.name, businessTemplateVersion: campaign.businessTemplateVersion, body: item.draft, status, source: item.note?.source ?? 'manual', createdAt: new Date().toISOString(), markedPublishedAt: status === 'marked_published' ? new Date().toISOString() : null };
    await saveInteraction(interaction); setInteractions(items => [interaction, ...items]);
  }
  async function markPublished(item: SearchCandidate) {
    if (!belongsToCurrentCampaign(item) || !item.draft || !item.note || interactionBlocksFirstContact(interactions, item.noteId, campaign.accountLabel)) return setMessage('无法重复标记，请核查本地互动记录。');
    await record(item, 'marked_published');
    await persistCandidate({ ...item, status: 'published', reason: '用户自行标记：已在原站手动发布' });
    setMessage('已记为“人工发布”；插件本身没有发送评论。');
  }
  function makeupCommentDenied(item: SearchCandidate, note = item.note): string | null {
    if (campaignBusinessType(campaign) !== 'makeup') return null;
    if (!note || !item.assessment || item.assessment.serviceDate === undefined) return '请用新版提示词重新分析，旧草稿缺少约妆日期与作者检查。';
    const policy = candidateEngagementPolicy(campaign, note, item.assessment);
    return policy.canComment ? null : policy.reason || '当前帖子不允许评论。';
  }
  async function fill(item: SearchCandidate) {
    if (!belongsToCurrentCampaign(item)) return setMessage('候选属于旧业务画像，请重新搜索。');
    if (item.status !== 'drafted' || !item.note || !item.draft.trim()) return setMessage('请先审核候选与草稿。');
    if (item.note.completeness !== 'complete') return setMessage('真实站点内容尚未完整验证；请复制草稿，人工粘贴。');
    const denied = makeupCommentDenied(item);
    if (denied) return setMessage(denied);
    if (interactionBlocksFirstContact(interactions, item.noteId, campaign.accountLabel)) return setMessage('已有互动记录，停止填入。');
    try {
      const result = await pageMessage<never>({ type: 'ASSISTANT_FILL', expectedNoteId: item.noteId, expectedTitle: item.note.title, expectedBody: item.note.body, text: item.draft });
      if (!result.ok) throw new Error(result.reason ?? '填入失败');
      await record(item, 'filled');
      await persistCandidate({ ...item, status: 'filled', reason: '仅填入评论框，未发送' });
      setMessage('已填入评论框；没有点击发送。请在页面上自行核对。');
    } catch (error) { setMessage(`未填入：${String(error)}`); }
  }
  async function publishSelected(item: SearchCandidate) {
    if (!belongsToCurrentCampaign(item) || item.status !== 'drafted' || !item.note || item.note.completeness !== 'complete' || !item.draft.trim()) return setMessage('请先完成需求审核与草稿生成。');
    if (interactionBlocksFirstContact(interactions, item.noteId, campaign.accountLabel)) return setMessage('已有互动或不确定发送记录，停止重复评论。');
    const denied = makeupCommentDenied(item);
    if (denied) return setMessage(denied);
    let pending: Interaction | null = null;
    setBusy(true);
    try {
      const current = await pageMessage<NoteSnapshot>({ type: 'ASSISTANT_READ_NOTE' });
      if (!current.ok || !current.note || current.note.id !== item.noteId || current.note.title !== item.note.title || current.note.body !== item.note.body || current.note.resolutionEvidence || current.note.completeness !== 'complete') throw new Error('当前帖子内容或需求状态与草稿不一致');
      const latestDenied = makeupCommentDenied(item, current.note);
      if (latestDenied) throw new Error(latestDenied);
      const interaction: Interaction = { id: crypto.randomUUID(), noteId: item.noteId, noteHash: `${item.note.title}:${item.note.body}`.slice(0, 200), accountLabel: campaign.accountLabel, templateId: null, templateVersion: null, businessTemplateId: campaign.businessTemplateId, businessTemplateName: campaign.name, businessTemplateVersion: campaign.businessTemplateVersion, body: item.draft, status: 'unknown', source: item.note.source, createdAt: new Date().toISOString(), markedPublishedAt: null };
      await saveInteraction(interaction);
      pending = interaction;
      setInteractions(items => [interaction, ...items]);
      const result = await pageMessage<never>({ type: 'ASSISTANT_PUBLISH', expectedNoteId: item.noteId, expectedTitle: item.note.title, expectedBody: item.note.body, text: item.draft }) as PublicationResult;
      const checked = publicationRecord(interaction, result);
      await saveInteraction(checked); setInteractions(items => items.map(value => value.id === checked.id ? checked : value));
      pending = null;
      if (!result.ok || !result.published) {
        await persistCandidate({ ...item, status: result.ambiguous === false ? 'drafted' : 'needs_review', reason: `${result.ambiguous === false ? '未点击发送' : '评论结果不明'}：${checked.publicationReason ?? '发送结果未确认'}`.slice(0, 500) });
        setMessage(`${result.ambiguous === false ? '没有点击发送：' : '评论结果不明，防重锁保留：'}${publicationFailureMessage(result.reason ?? '发送未在原站得到确认')}`);
        return;
      }
      await persistCandidate({ ...item, status: 'published', reason: checked.publicationReason ?? '已在原站确认评论出现' });
      setMessage(result.alreadyPublished ? '当前账号已有同文评论，没有再次发送。' : '评论已发送，并在原站评论区验证出现。');
    } catch (error) {
      if (pending) {
        await saveInteraction({ ...pending, publicationCheckedAt: new Date().toISOString(), publicationReason: '发送请求响应丢失，防重锁保留，请只读核对。' });
        await persistCandidate({ ...item, status: 'needs_review', reason: '评论结果不明：发送请求响应丢失，防重锁保留。' });
      }
      setMessage(`${pending ? '评论未获可靠确认，已锁定防重' : '发布检查未完成'}：${String(error)}`);
    }
    finally { setBusy(false); }
  }
  async function recheckComment(item: Interaction) {
    setBusy(true);
    try {
      await ensureBackgroundVersion();
      const tab = await activeTab();
      const result = await chrome.runtime.sendMessage({ type: 'PUBLICATION_RECHECK', interactionId: item.id, tabId: tab.id });
      if (!result?.ok) throw new Error(result?.reason ?? '只读核对未响应');
      setInteractions(await loadInteractions()); setCandidates(await loadSearchCandidates());
      const d = result.diagnostic;
      setMessage(`${result.notice}${d ? `（已加载评论 ${d.visibleRows} 条，同文 ${d.exactTextRows} 条，当前账号同文 ${d.ownTextRows} 条）` : ''}`);
    } catch (error) { setMessage(`只读核对未确认，防重锁保留：${String(error)}`); }
    finally { setBusy(false); }
  }
  async function inspectCommentInput() {
    try {
      const result = await pageMessage<never>({ type: 'ASSISTANT_COMMENT_DIAGNOSTIC' }) as Result<never> & { count?: number; inputs?: unknown[]; completeness?: string; resolutionEvidence?: string | null; loadedComments?: number; declaredComments?: number | null; collapsedReplies?: boolean };
      setCommentDiagnostic(result.ok ? JSON.stringify({ count: result.count, completeness: result.completeness, resolutionEvidence: result.resolutionEvidence, loadedComments: result.loadedComments, declaredComments: result.declaredComments, collapsedReplies: result.collapsedReplies, inputs: result.inputs }) : `检测失败：${result.reason}`);
    } catch (error) { setCommentDiagnostic(`检测失败：${String(error)}`); }
  }
  async function addTemplate() {
    const item: Template = templateSchema.parse({ id: crypto.randomUUID(), name: '新话术', category: '通用', body: '请填写真实、合规且不夸大的评论文本。', cities: [], serviceTypes: [], businessTemplateId: campaign.businessTemplateId ?? null, enabled: false, approvalStatus: 'draft', version: 1, allowedModes: ['original'], selectionCount: 0, markedPublishedCount: 0 });
    const next = [item, ...templates]; setTemplates(next); await saveTemplates(next);
  }
  async function changeTemplate(id: string, patch: Partial<Template>) {
    const candidate = templates.map(item => item.id === id ? { ...item, ...patch } : item);
    const parsed = templateSchema.array().safeParse(candidate);
    if (!parsed.success) return setMessage('话术未保存：名称和正文不能为空。');
    setTemplates(parsed.data); await saveTemplates(parsed.data);
  }
  const applicable = selected?.status === 'eligible' ? templates.filter(item => item.enabled && item.approvalStatus === 'approved' && !item.archivedAt && (!item.businessTemplateId || item.businessTemplateId === campaign.businessTemplateId) && (!item.cities.length || item.cities.some(city => selected.note?.body.includes(city) || selected.note?.title.includes(city)))) : [];

  const visibleDemandRows = demandRows.filter(row =>
    matchesDemandListTab(row, demandFilter) &&
    (demandStatusFilter === 'all' || row.manualStatus === demandStatusFilter) &&
    (demandSourceFilter === 'all' || row.sources.some(source => source.source === demandSourceFilter)) &&
    (demandProfileFilter === 'all' || (row.businessTemplateId ?? row.campaignId) === demandProfileFilter) &&
    (!demandPublishedAfter || row.publishedAt !== null && new Date(row.publishedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) >= demandPublishedAfter) &&
    (!demandTagFilter || [...row.tags, ...row.customTags].some(tag => tag.includes(demandTagFilter.trim())))
  ).sort((a, b) => demandSort === 'published'
    ? (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')
    : b.firstSeenAt.localeCompare(a.firstSeenAt));
  const demandMatchCount = demandRows.filter(row => matchesDemandListTab(row, 'match')).length;
  const demandReviewCount = demandRows.filter(row => matchesDemandListTab(row, 'review')).length;
  const demandUnreadCount = demandRows.filter(row => matchesDemandListTab(row, 'unread')).length;
  const demandViewedCount = demandRows.filter(row => matchesDemandListTab(row, 'viewed')).length;

  return <><header><h1>定向帖子助手 <small>v{EXTENSION_VERSION}</small></h1><span className="pill">{mode === 'mock' ? '模拟模型' : '真实模型'}</span> <span className="muted">{gateway}</span></header>
    {platformNotice && <section className="warning"><p>{platformNotice}</p><button className="secondary" onClick={() => void recheckPlatform()}>重新检查平台状态（只读）</button></section>}
    <nav>{(['首页', '找需求', '搜索', '候选', '话术', '设置', '记录'] as Tab[]).map(value => <button className={tab === value ? '' : 'secondary'} key={value} onClick={() => setTab(value)}>{value}</button>)}</nav>
    <main><p className="notice">{message}</p><button className="secondary" disabled={pageConnecting || busy || autoMode.status === 'running' || autoScan.status === 'running' || demandState.status === 'running'} onClick={() => void reconnectPage()}>{pageConnecting ? '正在连接页面…' : '重新连接当前页面（不刷新）'}</button>
      <section className="card active-business"><strong>当前业务：{campaign.confirmedAt ? campaign.name : '待激活'}</strong>{campaign.confirmedAt && <span className="pill">{businessTypeLabel(campaignBusinessType(campaign))} · v{campaign.businessTemplateVersion ?? 1}</span>}<button className="secondary" onClick={() => setTab('设置')}>管理业务模板</button></section>
      {tab === '首页' && <><section className="card"><h2>找需求</h2><p>从小红书首页或关键词结果分析列表卡片，保存需求线索、链接和标签；打开原帖后由你人工评论。</p><p className="muted">当前状态：{demandState.status} · 已分析卡片 {demandState.totalRead} · 匹配 {demandState.totalMatched}</p><button onClick={() => setTab('找需求')}>进入找需求</button></section><section className="card"><h2>Auto 浏览与互动</h2><p>可以不搜索，从当前首页逐帖浏览、下拉；也可处理你搜索好的结果。按当前业务模板判断，点赞、关注与评论分别控制，与只读找需求独立。</p><p className="muted">当前状态：{autoMode.status} · 已发布 {autoMode.published}</p><div className="row"><button onClick={() => changeBrowseSource('home')}>首页 Auto（不搜索）</button><button className="secondary" onClick={() => setTab('搜索')}>进入 Auto 设置</button></div></section></>}
      {tab === '找需求' && <>
        <details className="card demand-run">
          <summary>发现新需求 · {demandState.status === 'running' ? '运行中' : demandState.status === 'paused' ? '已暂停' : '未启动'}</summary>
          <p>当前画像：{campaign.name || '未配置'} · {campaign.confirmedAt ? '已确认' : '待确认'}</p>
          <p className="muted">只分析列表卡片的标题与可见摘要，不自动打开详情；信息不足的线索归入待复核。卡片没有发布日期时显示未识别。不会填入或发送评论。</p>
          <div className="row"><button className="secondary" onClick={() => void openDemandPage('home')}>打开小红书首页</button><button disabled={demandState.status === 'running'} onClick={() => void startDemand('home')}>从首页开始找需求</button></div>
          <label>或用关键词查找</label><input value={demandKeyword} onChange={event => setDemandKeyword(event.target.value)} placeholder="例如：上海约妆" />
          <div className="row"><button className="secondary" onClick={() => void openDemandPage('search')}>打开关键词搜索页</button><button disabled={demandState.status === 'running'} onClick={() => void startDemand('search')}>从搜索页开始找需求</button></div>
          <hr /><p>状态：{demandState.status}；已分析卡片 {demandState.totalRead} 条；匹配 {demandState.totalMatched} 条；异常卡片跳过 {demandState.failedRead} 条；本轮匹配 {demandState.lastAdded} 条。</p>
          <p className="muted">分析完当前卡片就继续下拉；每轮仅短暂停顿，暂时没有新卡片时适当放慢。直到你点击停止；页面、验证或网关异常仍会暂停。</p>
          {demandState.nextRunAt && <p className="muted">下一次检查约在 {new Date(demandState.nextRunAt).toLocaleTimeString()}。</p>}
          {demandState.reason && <p className="warning">{demandState.reason}</p>}
          <button className="secondary" disabled={demandState.status !== 'running'} onClick={() => void stopDemand()}>停止找需求</button>
        </details>
        <section className="card">
          <h2>需求记录（{visibleDemandRows.length} / {demandRows.length}）</h2>
          <div className="row demand-toolbar">
            <button className={demandFilter === 'all' ? '' : 'secondary'} onClick={() => setDemandFilter('all')}>全部 {demandRows.length}</button>
            <button className={demandFilter === 'unread' ? '' : 'secondary'} onClick={() => setDemandFilter('unread')}>未查阅 {demandUnreadCount}</button>
            <button className={demandFilter === 'viewed' ? '' : 'secondary'} onClick={() => setDemandFilter('viewed')}>已查阅 {demandViewedCount}</button>
            <button className={demandFilter === 'match' ? '' : 'secondary'} onClick={() => setDemandFilter('match')}>符合需求 {demandMatchCount}</button>
            <button className={demandFilter === 'review' ? '' : 'secondary'} onClick={() => setDemandFilter('review')}>待复核 {demandReviewCount}</button>
            <button className="secondary" onClick={() => void refreshDemandRows()}>刷新</button>
          </div>
          <details className="demand-filters"><summary>高级筛选与排序</summary>
            <label>人工状态</label><select value={demandStatusFilter} onChange={event => setDemandStatusFilter(event.target.value)}><option value="all">全部</option><option value="unhandled">未处理</option><option value="pending">待联系</option><option value="commented">已评论</option><option value="unsuitable">不合适</option></select>
            <label>来源</label><select value={demandSourceFilter} onChange={event => setDemandSourceFilter(event.target.value as typeof demandSourceFilter)}><option value="all">全部</option><option value="home">首页</option><option value="search">搜索</option></select>
            <label>业务模板</label><select value={demandProfileFilter} onChange={event => setDemandProfileFilter(event.target.value)}><option value="all">全部历史业务</option>{[...new Map(demandRows.map(row => [row.businessTemplateId ?? row.campaignId, row.campaignName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
            <label>排序</label><select value={demandSort} onChange={event => setDemandSort(event.target.value as typeof demandSort)}><option value="discovered">首次发现（新到旧）</option><option value="published">发布日期（新到旧）</option></select>
            <label>发布日期不早于</label><input type="date" value={demandPublishedAfter} onChange={event => setDemandPublishedAfter(event.target.value)} />
            <label>标签筛选</label><input value={demandTagFilter} onChange={event => setDemandTagFilter(event.target.value)} placeholder="城市、需求类型或自定义标签" />
          </details>
          <div className="demand-list">{visibleDemandRows.length ? visibleDemandRows.map(row => <article className="card demand-item" key={`${row.noteId}:${row.campaignId}`}>
            <div className="demand-item-heading"><strong>{row.title}</strong><span className="pill">{row.decision === 'match' ? '符合需求' : '待复核'}</span></div>
            <p className="muted">发布日期：{row.publishedRaw ?? '未识别'}{row.publishedPrecision === 'relative' ? '（相对时间估算）' : ''} · 首次发现：{new Date(row.firstSeenAt).toLocaleString()}</p>
            <p className="muted">{row.campaignName}{row.businessTemplateVersion ? ` · v${row.businessTemplateVersion}` : ''} · {row.sources.map(source => source.source === 'home' ? '首页' : `搜索：${source.keyword}`).join('、')} · {row.manualStatus === 'unhandled' ? '未处理' : row.manualStatus === 'pending' ? '待联系' : row.manualStatus === 'commented' ? '已评论' : '不合适'}{row.lastOpenedAt && ` · 已查阅 ${new Date(row.lastOpenedAt).toLocaleString()}`}</p>
            <p>标签：{[...row.tags, ...row.customTags].join('、') || '无'}</p>
            <div className="row"><button onClick={() => void openDemand(row)}>打开原帖</button><button className="secondary" onClick={() => void patchDemand(row, { status: 'pending' })}>待联系</button></div>
            <details className="demand-item-details"><summary>查看判断依据与编辑记录</summary>
              <p>证据：{row.evidence.join('；') || row.reason}</p>
              <p className="muted">{row.reason} · 内容：{row.contentCompleteness === 'card' ? '仅列表卡片' : '原帖文字'}</p>
              {row.resolutionEvidence && <p className="warning">可能已解决：{row.resolutionEvidence}</p>}
              <div className="row"><button className="secondary" onClick={() => void patchDemand(row, { status: 'commented' })}>我已手动评论</button><button className="secondary" onClick={() => void patchDemand(row, { status: 'unsuitable' })}>不合适</button></div>
              <label>自定义标签（逗号分隔）</label><input key={`${row.noteId}:${row.customTags.join(',')}`} defaultValue={row.customTags.join('，')} onBlur={event => { const tags = splitWords(event.target.value); if (tags.join(',') !== row.customTags.join(',')) void patchDemand(row, { customTags: tags }); }} />
              <label>备注</label><textarea key={`${row.noteId}:${row.note}`} defaultValue={row.note} onBlur={event => { if (event.target.value !== row.note) void patchDemand(row, { note: event.target.value }); }} />
            </details>
          </article>) : <p>当前筛选下没有记录。可以切换上方分类或清除高级筛选。</p>}</div>
        </section>
      </>}
      {tab === '搜索' && <section className="card">
        <h2>浏览任务 · 首页 / 搜索</h2>
        <p>当前业务：{campaign.name || '未配置'} · {campaign.confirmedAt ? '已确认' : '待确认'}</p>
        <BrowseTaskControls source={browseSource} keyword={keyword} tasks={tasks} currentTaskId={currentTask?.id} locked={busy || autoScan.status === 'running' || autoMode.status === 'running' || demandState.status === 'running'} onSourceChange={changeBrowseSource} onKeywordChange={setKeyword} onBind={() => void openSearch()} onCollect={() => void collectResults()} onTaskChange={id => { setActiveTaskId(id); setSelectedId(null); setPublishEnabled(false); setLikeEnabled(false); setFollowEnabled(false); }} />
        {currentTask && <p className="muted">已绑定来源：{autoTaskLabel(currentTask)}</p>}
        <hr />
        <h2>自动向下收集</h2>
        <label><input type="checkbox" checked={paceEnabled} onChange={event => void changePacing(event.target.checked)} /> 启用 3–5 分钟等待（下拉与评论）</label>
        <p className="muted">关闭时逐条处理、连续下拉；页面加载和模型分析仍需时间。页面到底后短暂重试。</p>
        <p>状态：{autoScan.status}；累计新增 {autoScan.totalAdded} 条；上轮新增 {autoScan.lastAdded} 条。</p>
        {autoScan.nextRunAt && <p>下次约在 {new Date(autoScan.nextRunAt).toLocaleString()}。{autoScan.paceEnabled ? '每轮随机间隔 3–5 分钟。' : '连续模式。'}</p>}
        {autoScan.reason && <p className="warning">{autoScan.reason}</p>}
        <div className="row"><button disabled={autoScan.status === 'running'} onClick={() => void startAutoScan()}>启动自动收集</button><button className="secondary" disabled={autoScan.status !== 'running'} onClick={() => void stopAutoScan()}>停止</button></div>
        <p className="warning">侧边栏关闭后仍可继续收集；任务页离开首页/对应搜索列表、失去活动状态或关闭则自动暂停。平台限制仍会锁定全部自动操作。</p>
        <hr />
        <h2>Auto 模式 · 关注、点赞与 AI 评论</h2>
        <p>状态：{autoMode.status}；已分析 {autoMode.analyzed} 条；新关注 {autoMode.followed ?? 0} 人；新点赞 {autoMode.liked ?? 0} 条；草稿 {autoMode.drafted} 条；已发布 {autoMode.published} 条；待复核 {autoMode.needsReview} 条；跳过 {autoMode.skipped} 条。</p>
        <p>当前浏览任务：候选 {taskCandidates.length} 条；尚未分析 {taskCandidates.filter(item => item.status === 'new').length} 条；待复核 {taskCandidates.filter(item => item.status === 'needs_review').length} 条；已跳过 {taskCandidates.filter(item => item.status === 'skipped').length} 条；可评论或已拟稿 {taskCandidates.filter(item => item.status === 'eligible' || item.status === 'drafted').length} 条。</p>
        <AutoProgress current={autoMode.taskId === currentTask?.id ? autoMode.currentCandidate : null} />
        {configurationIssue && <p className="warning">{configurationIssue} 请在“设置”编辑并激活业务模板。</p>}
        {autoMode.nextRunAt && <p className="muted">下一轮约在 {new Date(autoMode.nextRunAt).toLocaleString()}。</p>}
        {autoMode.reason && <p className="warning">{autoMode.reason}</p>}
        {unknownTaskComments.length > 0 && <div className="card"><p className="warning">有评论发送结果不明，已保留防重锁；Auto 会跳过这些帖子继续下一条，不会重发。需要核对时先停止 Auto，再手动打开原帖使用只读核对；没看到评论不代表发送失败。</p>{unknownTaskComments.map(item => <div key={item.id}><p>{taskCandidates.find(candidate => candidate.noteId === item.noteId)?.title} · 评论：{item.body}</p><button className="secondary" disabled={busy || autoMode.status === 'running'} onClick={() => void recheckComment(item)}>核对当前帖评论（只读）</button></div>)}</div>}
        <label><input type="checkbox" checked={publishEnabled} disabled={autoMode.status === 'running'} onChange={event => setPublishEnabled(event.target.checked)} /> 自动发布真实评论（每日上限 300 条）</label>
        <label><input type="checkbox" checked={followEnabled} disabled={autoMode.status === 'running'} onChange={event => setFollowEnabled(event.target.checked)} /> 对匹配帖子自动关注作者并点赞</label>
        <label><input type="checkbox" checked={likeEnabled || followEnabled} disabled={autoMode.status === 'running' || followEnabled} onChange={event => setLikeEnabled(event.target.checked)} /> 对确认符合需求且服务匹配的帖子自动点赞</label>
        <p className="muted">同页流程：点列表卡片 → 在弹层读取、判断、关注/点赞及 AI 评论 → 关闭详情 → 回原列表。不会为每一步另开标签页，也不自动刷新触底列表。匹配按当前业务模板核对；评论独立由 AI 判断。</p>
        <div className="row"><button disabled={autoMode.status === 'running'} onClick={() => void startAutoMode()}>开启 Auto</button><button className="secondary" disabled={autoMode.status !== 'running'} onClick={() => void stopAutoMode()}>停止 Auto</button></div>
        <p className="warning">已评论或发送结果不明的帖子防重跳过，继续下一条；不会重复发送，也不会把不明结果记为成功。标题无关、不匹配或内容不完整直接跳过。关注不明、账号/原帖变化、安全验证或无法返回原列表仍停机。扩展更新及浏览器重启会暂停。找需求功能仍为只读。</p>
      </section>}
      {tab === '候选' && <>
        <section className="card"><h2>候选队列（{taskCandidates.length}）</h2>
          <p className="muted">按页面从上到下、同一行从左到右排列。已处理项保留记录；Auto 从第一个未处理项继续，不重复发送。启动时会只读核对当前页面顺序。</p>
          <div className="row"><button className="secondary" disabled={busy || !taskCandidates.some(item => item.status === 'new')} onClick={() => { const next = taskCandidates.find(item => item.status === 'new'); if (next) void openAndAnalyze(next); }}>打开并分析下一条</button><button className="secondary" disabled={busy || autoMode.status === 'running' || !recheckableCandidates.length} onClick={() => void recheckCurrentTask()}>用新版提示词重新复核（{recheckableCandidates.length}）</button><button className="secondary" disabled={busy || autoMode.status === 'running' || !retryableCandidates.length} onClick={() => void retryOldCoverageCandidates()}>重新排队旧版完整性误判（{retryableCandidates.length}）</button></div>
          {selected && <div className="card"><p>当前选择：{selected.title}</p><div className="row"><button disabled={busy} onClick={() => void analyzeCandidate(selected)}>读取并分析当前帖</button><button className="secondary" onClick={() => void inspectCommentInput()}>检测当前评论框（不填入）</button></div>{commentDiagnostic && <p className="muted">{commentDiagnostic}</p>}</div>}
          <label>状态筛选</label><select value={candidateFilter} onChange={event => setCandidateFilter(event.target.value as typeof candidateFilter)}><option value="all">全部</option><option value="new">待处理</option><option value="needs_review">待复核</option><option value="eligible">可审核</option><option value="drafted">待审核草稿</option><option value="published">已发布</option><option value="skipped">已跳过</option></select>
          {visibleCandidates.length ? visibleCandidates.map(item => <article className="card" key={item.id}><strong>{item.title}</strong> <span className="pill">{item.status}</span>{item.likeStatus !== 'none' && <span className="pill">点赞：{{ pending: '准备中', liked: '已点赞', already_liked: '原已点赞', unavailable: '未操作', unknown: '结果未确认·防重锁定' }[item.likeStatus]}</span>}{item.likeReason && <p className="muted">{item.likeReason}</p>}{item.followStatus !== 'none' && <span className="pill">关注：{{ pending: '准备中', followed: '已关注', already_following: '原已关注', skipped: '未重复操作', unavailable: '未操作', unknown: '结果不明' }[item.followStatus]}</span>}{item.followReason && <p className="muted">{item.authorName || '作者'}：{item.followReason}</p>}{item.snippet && <p className="muted">搜索卡片信息：{item.snippet}</p>}<p>{item.reason}</p><div className="row"><button disabled={busy} onClick={() => void openAndAnalyze(item)}>打开并分析</button><button className="secondary" onClick={() => void openCandidate(item)}>仅打开</button><button className="secondary" disabled={busy} onClick={() => void analyzeCandidate(item)}>重试读取</button><button className="secondary" onClick={() => void openCandidate(item)}>查看关注原帖</button><button className="secondary" onClick={() => { setSelectedId(item.id); setPreviewedNoteId(null); setReviewedNoteId(null); }}>审核详情</button><button className="secondary" disabled={item.status === 'published'} onClick={() => void persistCandidate({ ...item, status: 'skipped', reason: '人工跳过' })}>跳过</button></div></article>) : <p>当前筛选下没有候选。</p>}
        </section>
        {selected && <section className="card"><h2>审核：{selected.title}</h2><p>{selected.reason}</p><p className="muted">帖子 ID：{selected.noteId}；来源：{selected.note?.source ?? '尚未读取'}；完整性：{selected.note?.completeness ?? '未知'}；判断版本：{selected.promptVersion ?? '未分析'}</p>
          {selected.assessment?.engagementPolicy && <p className="muted">动作权限：点赞{selected.assessment.engagementPolicy.canLike ? '允许' : '禁止'} · 关注{selected.assessment.engagementPolicy.canFollow ? '允许' : '禁止'} · 评论{selected.assessment.engagementPolicy.canComment ? '允许' : '禁止'}。{selected.assessment.engagementPolicy.reason}</p>}
          {selected.note && <details onToggle={event => { if (event.currentTarget.open) setPreviewedNoteId(selected.noteId); }}><summary>查看提取的笔记内容</summary><p>{selected.note.title}</p><p>{selected.note.body}</p></details>}
          {selected.note?.completeness === 'partial' && <><label><input type="checkbox" checked={reviewedNoteId === selected.noteId} disabled={previewedNoteId !== selected.noteId} onChange={event => setReviewedNoteId(event.target.checked ? selected.noteId : null)} /> 我已对照原站核对标题和正文完整</label><button disabled={busy || reviewedNoteId !== selected.noteId} onClick={() => void analyzeCandidate(selected, true)}>以人工确认的内容重新分析</button></>}
          {applicable.length > 0 && <><label>选用已审核话术</label><div className="row">{applicable.map(item => <button className="secondary" key={item.id} onClick={() => void useTemplate(selected, item)}>{item.name}</button>)}</div></>}
          <div className="row"><button disabled={busy || selected.status !== 'eligible' || !selected.assessment} onClick={() => void generateDraft(selected)}>生成待审核草稿</button></div>
          <label>评论草稿（人工编辑）</label><textarea maxLength={500} disabled={!['eligible', 'drafted'].includes(selected.status)} value={selected.draft} onChange={event => changeDraft(selected, event.target.value)} onBlur={() => void persistDraft(selected)} />
          <div className="row"><button className="secondary" disabled={!selected.draft} onClick={() => void navigator.clipboard.writeText(selected.draft).then(() => record(selected, 'copied')).then(() => setMessage('草稿已复制；未发布。'))}>复制</button><button disabled={!selected.draft || selected.status !== 'drafted'} onClick={() => void fill(selected)}>确认并填入当前帖</button><button disabled={busy || !selected.draft || selected.status !== 'drafted'} onClick={() => void publishSelected(selected)}>发布当前帖评论</button><button className="secondary" disabled={!selected.draft || selected.status === 'published'} onClick={() => void markPublished(selected)}>我已在原站手动发布</button></div>
          <button className="secondary" onClick={() => void inspectCommentInput()}>检测当前评论框（不填入）</button>{commentDiagnostic && <p className="muted">{commentDiagnostic}</p>}
          <p className="warning">“发布当前帖评论”会真实发送。只在原站笔记文本完整、需求未解决且草稿已核对时使用；发送不明会锁定防重。</p>
        </section>}
      </>}
      {tab === '话术' && <section className="card"><h2>话术库</h2><button onClick={() => void addTemplate()}>新增话术</button><p className="muted">离开输入框时保存；每次修改撤销审核，只有明确审核启用的话术参与推荐。</p>{templates.map(item => <article className="card" key={`${item.id}:${item.version}`}><label>名称</label><input defaultValue={item.name} disabled={Boolean(item.archivedAt)} onBlur={event => { if (event.target.value !== item.name) void changeTemplate(item.id, { name: event.target.value, enabled: false, approvalStatus: 'draft', version: item.version + 1 }); }} /><label>正文</label><textarea defaultValue={item.body} disabled={Boolean(item.archivedAt)} onBlur={event => { if (event.target.value !== item.body) void changeTemplate(item.id, { body: event.target.value, enabled: false, approvalStatus: 'draft', version: item.version + 1 }); }} /><label>适用业务模板</label><select value={item.businessTemplateId ?? ''} disabled={Boolean(item.archivedAt)} onChange={event => void changeTemplate(item.id, { businessTemplateId: event.target.value || null, enabled: false, approvalStatus: 'draft', version: item.version + 1 })}><option value="">通用</option>{businessTemplates.map(business => <option key={business.id} value={business.id}>{business.name}{business.archivedAt ? '（已归档）' : ''}</option>)}</select><label>适用城市，留空代表不限</label><input defaultValue={joinWords(item.cities)} disabled={Boolean(item.archivedAt)} onBlur={event => { if (event.target.value !== joinWords(item.cities)) void changeTemplate(item.id, { cities: splitWords(event.target.value), enabled: false, approvalStatus: 'draft', version: item.version + 1 }); }} /><p>{item.approvalStatus} · v{item.version}</p>{!item.archivedAt && <div className="row"><button disabled={item.enabled || !item.body.trim()} onClick={() => void changeTemplate(item.id, { enabled: true, approvalStatus: 'approved' })}>人工审核并启用</button><button className="secondary" onClick={() => void changeTemplate(item.id, { enabled: false, archivedAt: new Date().toISOString() })}>归档</button></div>}</article>)}</section>}
      {tab === '设置' && <>
        <ModelSettings client={modelSettingsClient} gatewayUrl={gatewayUrl} disabled={busy} beforeSave={() => ensureBackgroundVersion()} onSaved={config => { setMode(config.mode); setGateway(`已连接 · ${config.mode} · ${config.modelId}`); }} />
        <details className="card"><summary>本机网关配对设置（不是模型密钥）</summary>
          <label htmlFor="gateway-pairing-token">本机网关配对令牌</label><input id="gateway-pairing-token" type="password" value={pairingToken} autoComplete="off" onChange={event => { setPairingToken(event.target.value); sessionStorage.setItem('assistant-pairing-token', event.target.value); }} />
          {/^sk-/i.test(pairingToken) && <p className="warning">模型密钥应配置在本机网关，请勿填写到配对令牌中。</p>}
          <p>模型模式：{mode}。模型密钥只保存在本机网关。</p>
        </details>
        <BusinessTemplates templates={businessTemplates} active={campaign} onAction={businessTemplateAction} />
      </>}
      {tab === '记录' && <section className="card"><h2>本地操作记录</h2><p className="muted">填入和复制不等于发布。</p>
        <label>业务模板</label><select value={recordTemplateFilter} onChange={event => setRecordTemplateFilter(event.target.value)}><option value="all">全部历史业务</option>{businessTemplates.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}<option value="legacy">未关联的旧记录</option></select>
        {interactions.filter(item => recordTemplateFilter === 'all' || (recordTemplateFilter === 'legacy' ? !item.businessTemplateId : item.businessTemplateId === recordTemplateFilter)).map(item => <article className="card" key={item.id}><p>{new Date(item.createdAt).toLocaleString()} · {item.businessTemplateName ?? '旧业务记录'}{item.businessTemplateVersion ? ` · v${item.businessTemplateVersion}` : ''} · {item.noteId} · {item.status === 'unknown' ? '发送结果不明（防重锁定）' : item.status}</p><p>评论：{item.body}</p>{item.publicationReason && <p className="muted">{item.publicationReason}</p>}{item.status === 'unknown' && item.source === 'xhs' && <button className="secondary" disabled={busy || autoMode.status === 'running'} onClick={() => void recheckComment(item)}>核对当前帖评论（只读）</button>}</article>)}
        <h2>作者关注记录</h2><p className="muted">按运营账号和作者去重；取消关注不会自动重复关注。结果不明的记录不会盲目重试。</p>
        {authorFollows.filter(item => recordTemplateFilter === 'all' || (recordTemplateFilter === 'legacy' ? !item.businessTemplateId : item.businessTemplateId === recordTemplateFilter)).map(item => <article className="card" key={item.id}><strong>{item.authorName || item.authorId}</strong><p>{({ pending: '准备中或操作中断', followed: '已关注', already_following: '原已关注', unknown: '关注结果不明', cancelled: '未执行关注' })[item.status]} · {new Date(item.updatedAt).toLocaleString()} · {item.businessTemplateName ?? '旧业务'}</p><p className="muted">{item.reason}</p><a href={item.authorUrl} target="_blank" rel="noreferrer">查看作者</a></article>)}
      </section>}
    </main></>;
}
createRoot(document.getElementById('root')!).render(<App />);
