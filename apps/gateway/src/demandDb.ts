import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs, { type Database } from 'sql.js';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

export type DemandRecord = {
  noteId: string; title: string; body: string; url: string; publishedRaw: string | null;
  publishedAt: string | null; publishedPrecision: 'minute' | 'day' | 'relative' | 'unknown';
  source: 'home' | 'search'; keyword: string | null; campaignId: string; campaignName: string;
  decision: 'match' | 'review' | 'no_match'; evidence: string[]; reason: string;
  tags: string[]; promptVersion: string; contentCompleteness: 'text' | 'partial' | 'card';
  resolutionEvidence: string | null;
  businessTemplateId?: string; businessTemplateVersion?: number;
};

export type DemandRow = DemandRecord & {
  firstSeenAt: string; lastSeenAt: string; sources: Array<{ source: 'home' | 'search'; keyword: string | null }>;
  manualStatus: 'unhandled' | 'pending' | 'commented' | 'unsuitable'; customTags: string[];
  lastOpenedAt: string | null; note: string;
};

export class DemandDatabase {
  private constructor(private db: Database, private path: string | null) {}

  static async open(path: string | null): Promise<DemandDatabase> {
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    let bytes: Uint8Array | undefined;
    if (path) { try { bytes = new Uint8Array(await readFile(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const db = new SQL.Database(bytes);
    const store = new DemandDatabase(db, path);
    store.migrate();
    if (path && !bytes) await store.flush();
    return store;
  }

  private migrate() {
    this.db.run('PRAGMA foreign_keys = ON');
    const version = Number(this.scalar('PRAGMA user_version') ?? 0);
    if (version > 3) throw new Error('demand_database_newer_version');
    if (version === 0) {
      this.db.run(`CREATE TABLE posts (
        note_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL,
        published_raw TEXT, published_at TEXT, published_precision TEXT NOT NULL,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, content_completeness TEXT NOT NULL,
        resolution_evidence TEXT
      );
      CREATE TABLE post_sources (
        note_id TEXT NOT NULL REFERENCES posts(note_id), source TEXT NOT NULL, keyword TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        PRIMARY KEY(note_id, source, keyword)
      );
      CREATE TABLE demand_matches (
        note_id TEXT NOT NULL REFERENCES posts(note_id), campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL,
        decision TEXT NOT NULL, evidence_json TEXT NOT NULL, reason TEXT NOT NULL,
        tags_json TEXT NOT NULL, prompt_version TEXT NOT NULL, analyzed_at TEXT NOT NULL,
        business_template_id TEXT, business_template_version INTEGER,
        PRIMARY KEY(note_id, campaign_id)
      );
      CREATE TABLE manual_activity (
        note_id TEXT PRIMARY KEY REFERENCES posts(note_id), status TEXT NOT NULL DEFAULT 'unhandled',
        custom_tags_json TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', last_opened_at TEXT
      );
      PRAGMA user_version = 3;`);
    }
    if (version === 1) this.db.run("ALTER TABLE demand_matches ADD COLUMN campaign_name TEXT NOT NULL DEFAULT '旧业务画像'; PRAGMA user_version = 2;");
    if (version === 1 || version === 2) this.db.run('ALTER TABLE demand_matches ADD COLUMN business_template_id TEXT; ALTER TABLE demand_matches ADD COLUMN business_template_version INTEGER; PRAGMA user_version = 3;');
  }

  private scalar(sql: string, params: unknown[] = []): unknown {
    const statement = this.db.prepare(sql);
    try { statement.bind(params as any[]); return statement.step() ? statement.get()[0] : null; }
    finally { statement.free(); }
  }

  private rows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const statement = this.db.prepare(sql);
    const rows: Record<string, unknown>[] = [];
    try { statement.bind(params as any[]); while (statement.step()) rows.push(statement.getAsObject()); return rows; }
    finally { statement.free(); }
  }

  private async flush() {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, Buffer.from(this.db.export()), { mode: 0o600 });
    await rename(temp, this.path);
  }

  async upsert(record: DemandRecord): Promise<DemandRow> {
    const now = new Date().toISOString();
    const previous = this.get(record.noteId, record.campaignId);
    const match = record.contentCompleteness === 'card' && previous && previous.contentCompleteness !== 'card' ? previous : record;
    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run(`INSERT INTO posts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(note_id) DO UPDATE SET title=excluded.title,
        body=CASE WHEN excluded.content_completeness='card' AND posts.content_completeness<>'card' THEN posts.body ELSE excluded.body END,
        url=excluded.url,
        published_raw=COALESCE(excluded.published_raw, posts.published_raw),
        published_at=COALESCE(excluded.published_at, posts.published_at),
        published_precision=CASE WHEN excluded.published_at IS NOT NULL THEN excluded.published_precision ELSE posts.published_precision END,
        last_seen_at=excluded.last_seen_at,
        content_completeness=CASE WHEN excluded.content_completeness='card' AND posts.content_completeness<>'card' THEN posts.content_completeness ELSE excluded.content_completeness END,
        resolution_evidence=COALESCE(excluded.resolution_evidence, posts.resolution_evidence)`,
      [record.noteId, record.title, record.body, record.url, record.publishedRaw, record.publishedAt, record.publishedPrecision, now, now, record.contentCompleteness, record.resolutionEvidence]);
      this.db.run(`INSERT INTO post_sources VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(note_id,source,keyword) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
      [record.noteId, record.source, record.keyword ?? '', now, now]);
      this.db.run(`INSERT INTO demand_matches(note_id,campaign_id,campaign_name,decision,evidence_json,reason,tags_json,prompt_version,analyzed_at,business_template_id,business_template_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(note_id,campaign_id) DO UPDATE SET decision=excluded.decision, evidence_json=excluded.evidence_json,
        reason=excluded.reason, tags_json=excluded.tags_json, prompt_version=excluded.prompt_version, analyzed_at=excluded.analyzed_at,
        campaign_name=excluded.campaign_name, business_template_id=COALESCE(excluded.business_template_id,demand_matches.business_template_id), business_template_version=COALESCE(excluded.business_template_version,demand_matches.business_template_version)`,
      [record.noteId, record.campaignId, record.campaignName, match.decision, JSON.stringify(match.evidence), match.reason, JSON.stringify(match.tags), match.promptVersion, now, record.businessTemplateId ?? null, record.businessTemplateVersion ?? null]);
      this.db.run('INSERT OR IGNORE INTO manual_activity(note_id) VALUES (?)', [record.noteId]);
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    await this.flush();
    return this.get(record.noteId, record.campaignId)!;
  }

  get(noteId: string, campaignId: string): DemandRow | null {
    const row = this.rows(`SELECT p.*, m.campaign_id, m.campaign_name, m.decision, m.evidence_json, m.reason, m.tags_json,
      m.prompt_version, m.business_template_id, m.business_template_version, a.status, a.custom_tags_json, a.note AS manual_note, a.last_opened_at
      FROM posts p JOIN demand_matches m ON p.note_id=m.note_id
      JOIN manual_activity a ON p.note_id=a.note_id WHERE p.note_id=? AND m.campaign_id=?`, [noteId, campaignId])[0];
    if (!row) return null;
    const sources = this.rows('SELECT source, keyword FROM post_sources WHERE note_id=? ORDER BY last_seen_at DESC', [noteId]);
    return {
      noteId: String(row.note_id), title: String(row.title), body: String(row.body), url: String(row.url),
      publishedRaw: row.published_raw as string | null, publishedAt: row.published_at as string | null,
      publishedPrecision: row.published_precision as DemandRow['publishedPrecision'],
      firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at),
      source: sources[0]?.source as 'home' | 'search', keyword: (sources[0]?.keyword || null) as string | null,
      sources: sources.map(source => ({ source: source.source as 'home' | 'search', keyword: (source.keyword || null) as string | null })),
      campaignId: String(row.campaign_id), campaignName: String(row.campaign_name), decision: row.decision as DemandRow['decision'],
      businessTemplateId: row.business_template_id ? String(row.business_template_id) : undefined,
      businessTemplateVersion: row.business_template_version ? Number(row.business_template_version) : undefined,
      evidence: JSON.parse(String(row.evidence_json)), reason: String(row.reason), tags: JSON.parse(String(row.tags_json)),
      promptVersion: String(row.prompt_version), contentCompleteness: row.content_completeness as DemandRow['contentCompleteness'],
      resolutionEvidence: row.resolution_evidence as string | null, manualStatus: row.status as DemandRow['manualStatus'],
      customTags: JSON.parse(String(row.custom_tags_json)), lastOpenedAt: row.last_opened_at as string | null,
      note: String(row.manual_note)
    };
  }

  list(campaignId?: string): DemandRow[] {
    const rows = campaignId
      ? this.rows('SELECT note_id, campaign_id FROM demand_matches WHERE campaign_id=? ORDER BY analyzed_at DESC', [campaignId])
      : this.rows('SELECT note_id, campaign_id FROM demand_matches ORDER BY analyzed_at DESC');
    return rows.map(row => this.get(String(row.note_id), String(row.campaign_id))!).filter(Boolean);
  }

  async updateManual(noteId: string, campaignId: string, patch: { status?: DemandRow['manualStatus']; customTags?: string[]; note?: string; opened?: boolean }): Promise<DemandRow | null> {
    const current = this.get(noteId, campaignId);
    if (!current) return null;
    this.db.run(`UPDATE manual_activity SET status=?, custom_tags_json=?, note=?, last_opened_at=? WHERE note_id=?`, [
      patch.status ?? current.manualStatus, JSON.stringify(patch.customTags ?? current.customTags),
      patch.note ?? current.note, patch.opened ? new Date().toISOString() : current.lastOpenedAt, noteId
    ]);
    await this.flush();
    return this.get(noteId, campaignId);
  }

  close() { this.db.close(); }
}

export function defaultDemandDbPath() { return resolve(process.env.YUEZHUANG_DATA_DIR ?? resolve(process.cwd(), 'data'), 'demands.sqlite'); }
