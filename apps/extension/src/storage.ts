import { businessProfileSchema, businessTemplateFromCampaign, businessTemplateSchema, campaignSchema, createBusinessTemplate, interactionSchema, rentalOfferingDescription, searchCandidateSchema, searchTaskSchema, templateSchema, type BusinessProfile, type BusinessTemplate, type Campaign, type Interaction, type RentalProfile, type SearchCandidate, type SearchTask, type Template } from '@yuezhuang/shared';

import { authorFollowKey, authorFollowSchema, type AuthorFollow } from '@yuezhuang/shared';

const DB_NAME = 'yuezhuang-assistant';
const DB_VERSION = 5;
const TEMPLATE_STORE = 'templates';
const INTERACTION_STORE = 'interactions';
const PROFILE_STORE = 'profile';
const CAMPAIGN_STORE = 'campaign';
const BUSINESS_TEMPLATE_STORE = 'business-templates';
const TASK_STORE = 'search-tasks';
const CANDIDATE_STORE = 'search-candidates';
const FOLLOW_STORE = 'author-follows';
const KEY = 'all';

function requestDatabase(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    let settled = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TEMPLATE_STORE)) database.createObjectStore(TEMPLATE_STORE);
      if (!database.objectStoreNames.contains(INTERACTION_STORE)) database.createObjectStore(INTERACTION_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(PROFILE_STORE)) database.createObjectStore(PROFILE_STORE);
      if (!database.objectStoreNames.contains(CAMPAIGN_STORE)) database.createObjectStore(CAMPAIGN_STORE);
      if (!database.objectStoreNames.contains(TASK_STORE)) database.createObjectStore(TASK_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(CANDIDATE_STORE)) database.createObjectStore(CANDIDATE_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(BUSINESS_TEMPLATE_STORE)) database.createObjectStore(BUSINESS_TEMPLATE_STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(FOLLOW_STORE)) database.createObjectStore(FOLLOW_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (settled) { database.close(); return; }
      settled = true;
      const required = [TEMPLATE_STORE, INTERACTION_STORE, PROFILE_STORE, CAMPAIGN_STORE, TASK_STORE, CANDIDATE_STORE, BUSINESS_TEMPLATE_STORE, FOLLOW_STORE];
      if (required.some(store => !database.objectStoreNames.contains(store))) {
        database.close(); reject(new Error('数据库结构与扩展不兼容，请重载最新扩展；现有记录保留。')); return;
      }
      resolve(database);
    };
    request.onerror = () => { settled = true; reject(request.error); };
    request.onblocked = () => { settled = true; reject(new Error('请关闭旧版侧边栏后重新打开，以完成数据库升级；记录不会被删除。')); };
  });
}
async function openDatabase(): Promise<IDBDatabase> {
  try { return await requestDatabase(DB_VERSION); }
  catch (error) {
    // A compatible newer database must never be downgraded or deleted.
    if (error instanceof DOMException && error.name === 'VersionError') return requestDatabase();
    throw error;
  }
}

async function getAll(store: string): Promise<unknown[]> {
  const database = await openDatabase();
  try { return await new Promise<unknown[]>((resolve, reject) => {
    const request = database.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
}

async function put(store: string, value: unknown, key?: string): Promise<void> {
  const database = await openDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, 'readwrite');
    if (key) transaction.objectStore(store).put(value, key); else transaction.objectStore(store).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }); } finally { database.close(); }
}

async function initializeBusinessTemplates(): Promise<void> {
  const database = await openDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([BUSINESS_TEMPLATE_STORE, CAMPAIGN_STORE], 'readwrite');
    const templates = transaction.objectStore(BUSINESS_TEMPLATE_STORE);
    const count = templates.count();
    count.onsuccess = () => {
      if (count.result) return;
      const active = transaction.objectStore(CAMPAIGN_STORE).get('active');
      active.onsuccess = () => {
        try {
          const initial: BusinessTemplate[] = [];
          if (active.result) {
            let campaign = campaignSchema.parse(active.result);
            // Reopen confirmation when adding the user-supplied price/bathroom facts.
            if (!campaign.rentalProfile && /15\s*号线\s*丰翔路/.test(campaign.offering) && /7\s*号线\s*上大路/.test(campaign.offering)) {
              const rentalProfile: RentalProfile = { city: '上海', metroStations: [{ line: 15, station: '丰翔路' }, { line: 7, station: '上大路' }], monthlyRent: 1900, roomType: 'shared_master', privateBathroom: false };
              campaign = { ...campaign, rentalProfile, offering: rentalOfferingDescription(rentalProfile), confirmedAt: null };
            }
            const template = businessTemplateFromCampaign(campaign);
            initial.push(template);
            campaign = { ...campaign, businessType: template.businessType, businessTemplateId: template.id, businessTemplateVersion: template.version,
              judgmentInstructions: template.judgmentInstructions, commentStyle: template.commentStyle, defaultSearchKeywords: template.defaultSearchKeywords };
            transaction.objectStore(CAMPAIGN_STORE).put(campaign, 'active');
            transaction.objectStore(CAMPAIGN_STORE).put(campaign, campaign.id);
          }
          for (const type of ['rental', 'makeup'] as const) if (!initial.some(item => item.businessType === type)) initial.push(createBusinessTemplate(type, `business-${type}-default`));
          for (const template of initial) templates.put(template);
        } catch (error) { transaction.abort(); reject(error); }
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('业务模板迁移失败。'));
  }); } finally { database.close(); }
}

export async function loadBusinessTemplates(): Promise<BusinessTemplate[]> {
  await initializeBusinessTemplates();
  return businessTemplateSchema.array().parse(await getAll(BUSINESS_TEMPLATE_STORE)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadCampaign(): Promise<Campaign> {
  await initializeBusinessTemplates();
  const database = await openDatabase();
  try { return await new Promise<Campaign>((resolve, reject) => {
    const request = database.transaction(CAMPAIGN_STORE, 'readonly').objectStore(CAMPAIGN_STORE).get('active');
    request.onsuccess = () => {
      try { resolve(request.result ? campaignSchema.parse(request.result) : { id: 'active', name: '', offering: '', targetIntent: '', cities: [], demandKeywords: [], exclusionKeywords: [], accountLabel: '本地账号', confirmedAt: null }); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
}

export async function loadCampaignSnapshots(): Promise<Campaign[]> {
  await initializeBusinessTemplates();
  const values = (await getAll(CAMPAIGN_STORE)).filter(Boolean).map(value => campaignSchema.parse(value));
  return [...new Map(values.map(value => [value.id, value])).values()];
}

// Undefined keeps the active campaign, null deactivates it, a Campaign atomically applies a new snapshot.
export async function commitBusinessTemplate(template: BusinessTemplate, campaign?: Campaign | null): Promise<void> {
  const parsed = businessTemplateSchema.parse(template);
  const active = campaign ? campaignSchema.parse(campaign) : campaign;
  const database = await openDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([BUSINESS_TEMPLATE_STORE, CAMPAIGN_STORE], 'readwrite');
    transaction.objectStore(BUSINESS_TEMPLATE_STORE).put(parsed);
    if (active !== undefined) {
      const store = transaction.objectStore(CAMPAIGN_STORE);
      if (active === null) store.delete('active');
      else { store.put(active, 'active'); store.put(active, active.id); }
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }); } finally { database.close(); }
}

export async function saveCampaign(campaign: Campaign) {
  const parsed = campaignSchema.parse(campaign);
  await put(CAMPAIGN_STORE, parsed, parsed.id);
  await put(CAMPAIGN_STORE, parsed, 'active');
}
export async function loadSearchTasks() { return searchTaskSchema.array().parse(await getAll(TASK_STORE)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export async function saveSearchTask(task: SearchTask) { await put(TASK_STORE, searchTaskSchema.parse(task)); }
export async function loadSearchCandidates() { return searchCandidateSchema.array().parse(await getAll(CANDIDATE_STORE)).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)); }
export async function saveSearchCandidate(candidate: SearchCandidate) { await put(CANDIDATE_STORE, searchCandidateSchema.parse(candidate)); }
// Ordering is metadata only: do not overwrite a newer decision/interaction lock
// with the snapshot used to calculate page positions.
export async function saveSearchCandidateOrder(id: string, listOrder: number) {
  if (!Number.isSafeInteger(listOrder) || listOrder < 0) throw new Error('候选顺序无效。');
  const database = await openDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CANDIDATE_STORE, 'readwrite');
    const store = transaction.objectStore(CANDIDATE_STORE); const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) return;
      try { store.put(searchCandidateSchema.parse({ ...request.result, listOrder })); }
      catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('候选顺序保存中断。'));
  }); } finally { database.close(); }
}

export async function loadAuthorFollows(): Promise<AuthorFollow[]> {
  return authorFollowSchema.array().parse(await getAll(FOLLOW_STORE)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function saveAuthorFollow(record: AuthorFollow): Promise<void> {
  const parsed = authorFollowSchema.parse(record);
  if (parsed.id !== authorFollowKey(parsed.accountLabel, parsed.authorId)) throw new Error('关注记录的账号与作者不一致。');
  await put(FOLLOW_STORE, parsed);
}
export async function findAuthorFollow(accountLabel: string, authorId: string): Promise<AuthorFollow | null> {
  const database = await openDatabase();
  try { return await new Promise((resolve, reject) => {
    const request = database.transaction(FOLLOW_STORE, 'readonly').objectStore(FOLLOW_STORE).get(authorFollowKey(accountLabel, authorId));
    request.onsuccess = () => { try { resolve(request.result ? authorFollowSchema.parse(request.result) : null); } catch (error) { reject(error); } };
    request.onerror = () => reject(request.error);
  }); } finally { database.close(); }
}

export async function loadTemplates(seed: Template[]): Promise<Template[]> {
  const database = await openDatabase();
  const stored = await new Promise<unknown>((resolve, reject) => {
    const request = database.transaction(TEMPLATE_STORE, 'readonly').objectStore(TEMPLATE_STORE).get(KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  if (!stored) { await saveTemplates(seed); return seed; }
  return templateSchema.array().parse(stored);
}

export async function saveTemplates(templates: Template[]): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(TEMPLATE_STORE, 'readwrite');
    transaction.objectStore(TEMPLATE_STORE).put(templates, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadInteractions(): Promise<Interaction[]> {
  const database = await openDatabase();
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const request = database.transaction(INTERACTION_STORE, 'readonly').objectStore(INTERACTION_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return interactionSchema.array().parse(values).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveInteraction(interaction: Interaction): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(INTERACTION_STORE, 'readwrite');
    transaction.objectStore(INTERACTION_STORE).put(interaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadBusinessProfile(): Promise<BusinessProfile> {
  const fallback: BusinessProfile = { id: 'default', brandName: '悦妆师', serviceCities: ['上海'], serviceTypes: ['daily', 'certificate'], version: 1, confirmedAt: null };
  const database = await openDatabase();
  const stored = await new Promise<unknown>((resolve, reject) => {
    const request = database.transaction(PROFILE_STORE, 'readonly').objectStore(PROFILE_STORE).get('default');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return stored ? businessProfileSchema.parse(stored) : fallback;
}

export async function saveBusinessProfile(profile: BusinessProfile): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROFILE_STORE, 'readwrite');
    transaction.objectStore(PROFILE_STORE).put(profile, 'default');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
