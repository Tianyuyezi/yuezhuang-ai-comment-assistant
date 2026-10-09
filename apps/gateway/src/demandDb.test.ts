import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemandDatabase, type DemandRecord } from './demandDb.js';
import { createApp } from './server.js';

const noteId = 'xhs:6ab7d5ab000000001b02ce03';
const record: DemandRecord = {
  noteId, title: '找上海化妆师', body: '想找上海上门化妆师，十月三号需要。',
  url: 'https://www.xiaohongshu.com/explore/6ab7d5ab000000001b02ce03',
  publishedRaw: '2026-09-26 12:30', publishedAt: '2026-09-26T04:30:00.000Z', publishedPrecision: 'minute',
  source: 'home', keyword: null, campaignId: 'makeup', campaignName: '化妆服务', decision: 'match', evidence: ['想找上海上门化妆师'],
  reason: '明确找服务', tags: ['上海', '约妆'], promptVersion: 'find-demand-v1', contentCompleteness: 'text', resolutionEvidence: null
};

describe('find-demand SQLite persistence', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it('deduplicates sources and retains human status and tags after rescanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuezhuang-demand-')); dirs.push(dir);
    const path = join(dir, 'records.sqlite');
    const first = await DemandDatabase.open(path);
    await first.upsert(record);
    await first.updateManual(noteId, 'makeup', { status: 'commented', customTags: ['高优先级'], note: '我人工联系过', opened: true });
    await first.upsert({ ...record, source: 'search', keyword: '上海约妆', tags: ['上海', '生日妆'] });
    expect(first.list('makeup')).toHaveLength(1);
    expect(first.get(noteId, 'makeup')).toMatchObject({ manualStatus: 'commented', customTags: ['高优先级'], note: '我人工联系过' });
    expect(first.get(noteId, 'makeup')?.lastOpenedAt).toBeTruthy();
    expect(first.get(noteId, 'makeup')?.sources).toHaveLength(2);
    first.close();
    const reopened = await DemandDatabase.open(path);
    expect(reopened.get(noteId, 'makeup')?.manualStatus).toBe('commented');
    expect(reopened.get(noteId, 'makeup')?.lastOpenedAt).toBeTruthy();
    expect(reopened.get(noteId, 'makeup')?.publishedPrecision).toBe('minute');
    expect(reopened.list()).toHaveLength(1);
    await reopened.upsert({ ...record, campaignId: 'makeup-v2', campaignName: '化妆服务新版' });
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.list('makeup')).toHaveLength(1);
    reopened.close();
  });

  it('keeps an existing full-text match and publication date when a later card has less detail', async () => {
    const store = await DemandDatabase.open(null);
    try {
      await store.upsert(record);
      const card = await store.upsert({ ...record, body: record.title, publishedRaw: null, publishedAt: null, publishedPrecision: 'unknown', decision: 'review', evidence: ['找上海化妆师'], reason: '卡片信息不足', tags: ['仅卡片信息'], contentCompleteness: 'card' });
      expect(card).toMatchObject({ body: record.body, publishedRaw: record.publishedRaw, publishedAt: record.publishedAt, decision: 'match', contentCompleteness: 'text' });
    } finally { store.close(); }
  });

  it('isolates the read-only discovery API from drafting and publishing', async () => {
    const app = await createApp({ APP_MODE: 'mock', DEMAND_DB_PATH: ':memory:' });
    try {
      const bad = await app.inject({ method: 'POST', url: '/v1/demand/records', headers: { host: '127.0.0.1:3417' }, payload: { ...record, url: 'https://example.com/other' } });
      expect(bad.statusCode).toBe(400);
      const saved = await app.inject({ method: 'POST', url: '/v1/demand/records', headers: { host: '127.0.0.1:3417' }, payload: record });
      expect(saved.statusCode, saved.body).toBe(200);
      const rows = await app.inject({ method: 'GET', url: '/v1/demand/records?campaignId=makeup', headers: { host: '127.0.0.1:3417' } });
      expect(rows.json()).toHaveLength(1);
      const manual = await app.inject({ method: 'PATCH', url: `/v1/demand/records/${noteId}`, headers: { host: '127.0.0.1:3417' }, payload: { campaignId: 'makeup', status: 'pending' } });
      expect(manual.json().manualStatus).toBe('pending');
      expect(manual.json()).not.toHaveProperty('draft');
    } finally { await app.close(); }
  });
  it('migrates a version-2 database and preserves history plus new template attribution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuezhuang-demand-v2-')); dirs.push(dir);
    const path = join(dir, 'records.sqlite');
    const original = await DemandDatabase.open(path);
    await original.upsert(record);
    await original.updateManual(noteId, 'makeup', { status: 'pending', customTags: ['已联系'], note: '历史备注', opened: true });
    original.close();
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const v2 = new SQL.Database(new Uint8Array(await readFile(path)));
    v2.run('ALTER TABLE demand_matches DROP COLUMN business_template_id; ALTER TABLE demand_matches DROP COLUMN business_template_version; PRAGMA user_version=2;');
    await writeFile(path, v2.export()); v2.close();
    const upgraded = await DemandDatabase.open(path);
    try {
      expect(upgraded.get(noteId, 'makeup')).toMatchObject({ campaignName: record.campaignName, manualStatus: 'pending', note: '历史备注', customTags: ['已联系'] });
      expect(upgraded.get(noteId, 'makeup')!.businessTemplateId).toBeUndefined();
      await upgraded.upsert({ ...record, campaignId: 'makeup-snapshot', businessTemplateId: 'artist-template', businessTemplateVersion: 4 });
      expect(upgraded.get(noteId, 'makeup-snapshot')).toMatchObject({ businessTemplateId: 'artist-template', businessTemplateVersion: 4, manualStatus: 'pending' });
      expect(upgraded.list()).toHaveLength(2);
    } finally { upgraded.close(); }
    const reopened = await DemandDatabase.open(path);
    expect(reopened.get(noteId, 'makeup-snapshot')!.businessTemplateVersion).toBe(4);
    reopened.close();
  });
});
