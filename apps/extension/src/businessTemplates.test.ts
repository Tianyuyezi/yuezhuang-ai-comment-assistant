import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { campaignFromBusinessTemplate, createBusinessTemplate, type BusinessTemplate } from '@yuezhuang/shared';
import { commitBusinessTemplate, loadBusinessTemplates, loadCampaign, loadCampaignSnapshots, loadSearchTasks, saveSearchTask } from './storage';
import { initialAutoModeState } from './autoMode';
import { initialAutoScanState } from './autoScan';
import { initialDemandState } from './demand';
import { authorFollowKey, type AuthorFollow } from '@yuezhuang/shared';
import { findAuthorFollow, loadAuthorFollows, loadSearchCandidates, saveAuthorFollow } from './storage';

let local: Record<string, any>;
let messageHandler: any;
const event = () => ({ addListener: vi.fn() });
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  local = {};
  vi.stubGlobal('chrome', {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: { addListener: (handler: any) => { messageHandler = handler; } } },
    sidePanel: { setPanelBehavior: vi.fn() },
    alarms: { clear: vi.fn(async () => true), create: vi.fn(), onAlarm: event() },
    tabs: { onRemoved: event(), onUpdated: event() },
    storage: { local: { get: async (key: string) => ({ [key]: local[key] }), set: async (values: object) => { Object.assign(local, values); }, remove: async (key: string) => { delete local[key]; } } }
  });
});
const action = (type: string, fields: object) => new Promise<any>(resolve => messageHandler({ type, ...fields }, {}, resolve));
const makeupReady = (template: BusinessTemplate) => ({ ...template, config: { ...template.config, makeupProfile: { cities: ['上海'], serviceAreas: ['静安'], serviceTypes: ['日常妆'], deliveryMode: 'onsite' as const, studioAddress: '', priceFrom: 200, priceTo: null, priceNotes: '', availability: '' } } });

describe('business-template persistence and task switching', () => {
  it('persists the customer range and retained values without changing fees or old snapshots', async () => {
    const ready = makeupReady(createBusinessTemplate('makeup', 'budget-template'));
    ready.config.makeupProfile.priceFrom = 359;
    const template = { ...ready, config: { ...ready.config, makeupProfile: { ...ready.config.makeupProfile, budgetFilter: { mode: 'range' as const, min: 100, max: 300 } } } };
    const first = campaignFromBusinessTemplate(template, 'budget-first');
    await commitBusinessTemplate(template, first);
    expect((await loadCampaign()).makeupProfile).toMatchObject({ priceFrom: 359, budgetFilter: { mode: 'range', min: 100, max: 300 } });
    const updated = { ...template, version: 2, config: { ...template.config, makeupProfile: { ...template.config.makeupProfile, budgetFilter: { ...template.config.makeupProfile.budgetFilter, mode: 'ignore' as const } } } };
    await commitBusinessTemplate(updated, campaignFromBusinessTemplate(updated, 'budget-second'));
    expect((await loadBusinessTemplates()).find(item => item.id === template.id)!.config.makeupProfile).toMatchObject({ priceFrom: 359, budgetFilter: { mode: 'ignore', min: 100, max: 300 } });
    expect((await loadCampaignSnapshots()).find(item => item.id === 'budget-first')!.makeupProfile!.budgetFilter!.mode).toBe('range');
  });
  it('persists home tasks alongside legacy search tasks without a database version change', async () => {
    const base = { id: 'legacy-search', campaignId: 'campaign', keyword: '上海求租', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海求租', createdAt: '2026-10-06', status: 'collected' as const };
    const home = { ...base, id: 'home-task', source: 'home' as const, keyword: '', sourceUrl: 'https://www.xiaohongshu.com/explore' };
    await saveSearchTask(base); await saveSearchTask(home);
    expect(await loadSearchTasks()).toEqual(expect.arrayContaining([base, home]));
    expect(await loadSearchTasks()).toHaveLength(2);
  });
  it('opens a compatible newer database without downgrading or deleting any stores', async () => {
    await loadBusinessTemplates();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('yuezhuang-assistant', 6);
      request.onupgradeneeded = () => { request.result.createObjectStore('future-history').put('保留', 'record'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const task = { id: 'retained-task', campaignId: 'campaign', keyword: '上海求租', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海求租', createdAt: '2026-10-05', status: 'collected' as const };
    await saveSearchTask(task); expect(await loadSearchTasks()).toEqual([task]);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('yuezhuang-assistant'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result; expect(db.version).toBe(6);
        const read = db.transaction('future-history').objectStore('future-history').get('record');
        read.onsuccess = () => { expect(read.result).toBe('保留'); db.close(); resolve(); };
      };
    });
  });
  it('refuses an incompatible newer schema without deleting existing data', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('yuezhuang-assistant', 6);
      request.onupgradeneeded = () => { request.result.createObjectStore('future-history').put('保留', 'record'); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    await expect(loadSearchTasks()).rejects.toThrow('现有记录保留');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('yuezhuang-assistant'); request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result; expect(db.version).toBe(6);
        const read = db.transaction('future-history').objectStore('future-history').get('record');
        read.onsuccess = () => { expect(read.result).toBe('保留'); db.close(); resolve(); };
      };
    });
  });
  it('upgrades a v4 candidate database with safe follow defaults and retains existing campaigns', async () => {
    const campaign = campaignFromBusinessTemplate(createBusinessTemplate('rental', 'template'), 'existing-campaign');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('yuezhuang-assistant', 4);
      request.onupgradeneeded = () => { request.result.createObjectStore('campaign'); request.result.createObjectStore('search-candidates', { keyPath: 'id' }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result; const tx = db.transaction(['campaign', 'search-candidates'], 'readwrite');
        tx.objectStore('campaign').put(campaign, 'active');
        tx.objectStore('search-candidates').put({ id: 'old', taskId: 'task', noteId: 'xhs:a', url: 'https://www.xiaohongshu.com/explore/a', title: '上海求租', snippet: '', status: 'new', reason: '', capturedAt: '2026-10-04', note: null, draft: '' });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });
    expect((await loadCampaign()).id).toBe(campaign.id);
    expect((await loadSearchCandidates())[0]).toMatchObject({ id: 'old', followStatus: 'none', authorId: null, likeStatus: 'none' });
    expect(await loadAuthorFollows()).toEqual([]);
  });
  it('persists one follow record per author and operating account across template changes', async () => {
    const authorId = '6ab7d5ab000000001b02ce03';
    const record: AuthorFollow = { id: authorFollowKey('本地账号', authorId), accountLabel: '本地账号', authorId, authorName: '测试作者', authorUrl: `https://www.xiaohongshu.com/user/profile/${authorId}`, noteId: 'xhs:a', status: 'pending', createdAt: '2026-10-05', updatedAt: '2026-10-05', reason: '准备关注', businessTemplateId: 'rental' };
    await saveAuthorFollow(record);
    await saveAuthorFollow({ ...record, status: 'followed', businessTemplateId: 'makeup' });
    expect(await loadAuthorFollows()).toHaveLength(1);
    expect((await findAuthorFollow('本地账号', authorId))!.status).toBe('followed');
    await saveAuthorFollow({ ...record, accountLabel: '另一账号', id: authorFollowKey('另一账号', authorId) });
    expect(await loadAuthorFollows()).toHaveLength(2);
    await expect(saveAuthorFollow({ ...record, id: 'wrong-key' })).rejects.toThrow('不一致');
  });
  it('upgrades the old database without losing active config or search history', async () => {
    const campaign = campaignFromBusinessTemplate(createBusinessTemplate('rental', 'old-template'), 'old-campaign');
    const { businessType: _type, businessTemplateId: _template, businessTemplateVersion: _version, judgmentInstructions: _rules, commentStyle: _style, defaultSearchKeywords: _keywords, ...legacy } = campaign;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('yuezhuang-assistant', 3);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('campaign');
        request.result.createObjectStore('search-tasks', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['campaign', 'search-tasks'], 'readwrite');
        transaction.objectStore('campaign').put(legacy, 'active');
        transaction.objectStore('search-tasks').put({ id: 'old-task', campaignId: campaign.id, keyword: '上海求租', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海求租', createdAt: '2026-10-01', status: 'collected' });
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    });
    const templates = await loadBusinessTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.find(item => item.businessType === 'rental')!.config.offering).toBe(campaign.offering);
    expect((await loadCampaign()).id).toBe('old-campaign');
    expect((await loadSearchTasks())[0].id).toBe('old-task');
    expect(await loadCampaignSnapshots()).toHaveLength(1);
  });
  it('keeps a single active snapshot and preserves older versions after deactivation', async () => {
    const rental = (await loadBusinessTemplates()).find(item => item.businessType === 'rental')!;
    const first = campaignFromBusinessTemplate(rental, 'version-one');
    await commitBusinessTemplate(rental, first);
    const secondTemplate = { ...rental, version: 2, name: '新房源' };
    const second = campaignFromBusinessTemplate(secondTemplate, 'version-two');
    await commitBusinessTemplate(secondTemplate, second);
    expect((await loadCampaign()).id).toBe(second.id);
    await commitBusinessTemplate({ ...secondTemplate, archivedAt: '2026-10-04' }, null);
    expect((await loadCampaign()).confirmedAt).toBeNull();
    expect(await loadCampaignSnapshots()).toHaveLength(2);
  });
  it('stops every old task on activation, applies versions, and rejects stale saves', async () => {
    await vi.resetModules();
    await import('./background');
    const templates = await loadBusinessTemplates();
    const rental = templates.find(item => item.businessType === 'rental')!;
    const makeup = makeupReady(templates.find(item => item.businessType === 'makeup')!);
    const initial = await action('BUSINESS_TEMPLATE_ACTIVATE', { templateId: rental.id });
    expect(initial.ok).toBe(true);
    await saveSearchTask({ id: 'old-rental-task', campaignId: initial.campaign.id, keyword: '上海求租', sourceUrl: 'https://www.xiaohongshu.com/search_result?keyword=上海求租', createdAt: '2026-10-04', status: 'collected' });
    local.autoScanState = { ...initialAutoScanState, status: 'running', runId: 'scan', taskId: 'task' };
    local.autoModeState = { ...initialAutoModeState, status: 'running', runId: 'auto', taskId: 'task' };
    local.demandState = { ...initialDemandState, status: 'running', runId: 'demand' };
    const saved = await action('BUSINESS_TEMPLATE_SAVE', { template: makeup });
    expect(saved.ok).toBe(true);
    // An inactive draft save must not stop the running business.
    expect(local.autoModeState.status).toBe('running');
    const activated = await action('BUSINESS_TEMPLATE_ACTIVATE', { templateId: makeup.id });
    expect(activated.ok, activated.reason).toBe(true);
    expect(activated.campaign).toMatchObject({ businessTemplateId: makeup.id, businessTemplateVersion: 2, businessType: 'makeup' });
    expect(local.autoScanState.status).toBe('stopped');
    expect(local.autoModeState.status).toBe('stopped');
    expect(local.demandState.status).toBe('stopped');
    expect(await loadCampaignSnapshots()).toHaveLength(2);
    local.autoScanState = { ...initialAutoScanState, status: 'running', runId: 'scan', taskId: 'old-rental-task' };
    const oldTask = await action('AUTO_MODE_START', { taskId: 'old-rental-task', publishEnabled: true, paceEnabled: false });
    expect(oldTask).toMatchObject({ ok: false });
    expect(oldTask.reason).toContain('旧业务');
    expect((await action('BUSINESS_TEMPLATE_SAVE', { template: makeup })).ok).toBe(false);
    const current = activated.templates.find((item: BusinessTemplate) => item.id === makeup.id);
    const edited = await action('BUSINESS_TEMPLATE_SAVE', { template: { ...current, commentStyle: '仅一句简短回复' } });
    expect(edited.campaign.businessTemplateVersion).toBe(3);
    expect(edited.campaign.commentStyle).toBe('仅一句简短回复');
    expect(await loadCampaignSnapshots()).toHaveLength(3);
    const duplicate = await action('BUSINESS_TEMPLATE_DUPLICATE', { templateId: makeup.id });
    expect(duplicate.templates).toHaveLength(3);
    expect(duplicate.campaign.id).toBe(edited.campaign.id);
    const archived = await action('BUSINESS_TEMPLATE_ARCHIVE', { templateId: makeup.id });
    expect(archived.campaign.confirmedAt).toBeNull();
    expect((await action('BUSINESS_TEMPLATE_ACTIVATE', { templateId: makeup.id })).ok).toBe(false);
    expect((await action('BUSINESS_TEMPLATE_RESTORE', { templateId: makeup.id })).ok).toBe(true);
  });
});
