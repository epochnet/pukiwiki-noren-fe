// Search/tree/link index. A disposable copy: PukiWiki stays the source of truth.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { authorTime, extractLinks, plainText } from '../../../../packages/syntax/src/index.ts';

export interface PageRow {
  name: string; parent: string | null; space: string; depth: number; mtime: number | null;
  digest: string; size: number; is_date: number; title: string; excerpt: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function parentOf(name: string): string | null {
  const i = name.lastIndexOf('/');
  return i > 0 ? name.slice(0, i) : null;
}
export function spaceOf(name: string): string {
  const i = name.indexOf('/');
  return i > 0 ? name.slice(0, i) : name;
}

export class IndexDb {
  readonly db: DatabaseSync;

  constructor(dataDir: string, wikiId: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, `index-${wikiId.replace(/[^\w-]/g, '_')}.sqlite`));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS pages (
        name TEXT PRIMARY KEY, parent TEXT, space TEXT, depth INTEGER, mtime INTEGER,
        digest TEXT, size INTEGER, is_date INTEGER, title TEXT, excerpt TEXT, synced_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pages_parent ON pages(parent);
      CREATE INDEX IF NOT EXISTS pages_space ON pages(space);
      CREATE INDEX IF NOT EXISTS pages_mtime ON pages(mtime);
      CREATE TABLE IF NOT EXISTS links (src TEXT, dst TEXT, PRIMARY KEY (src, dst));
      CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
      CREATE TABLE IF NOT EXISTS attachments (page TEXT, file TEXT, time INTEGER, size TEXT, PRIMARY KEY (page, file));
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, title, body, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS fts_map (name TEXT PRIMARY KEY, rid INTEGER);
      CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS deleted (name TEXT PRIMARY KEY, time INTEGER);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, page TEXT, base_digest TEXT, source TEXT, summary TEXT, kind TEXT,
        status TEXT, created_by TEXT, created_at INTEGER, decided_by TEXT, decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER, user TEXT, ip TEXT, action TEXT,
        page TEXT, detail TEXT, ok INTEGER
      );
    `);
  }

  // ------------------------------------------------------------------ state
  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as any;
    return r ? r.value : null;
  }
  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ------------------------------------------------------------------ write
  upsertPage(name: string, source: string, digest: string, mtime: number | null): void {
    const body = plainText(source);
    const title = name.slice(name.lastIndexOf('/') + 1);
    const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    const t = mtime ?? authorTime(source);
    const prev = this.db.prepare('SELECT mtime FROM pages WHERE name = ?').get(name) as any;
    const parent = parentOf(name);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO pages(name, parent, space, depth, mtime, digest, size, is_date, title, excerpt, synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET parent=excluded.parent, space=excluded.space, depth=excluded.depth,
          mtime=excluded.mtime, digest=excluded.digest, size=excluded.size, is_date=excluded.is_date,
          title=excluded.title, excerpt=excluded.excerpt, synced_at=excluded.synced_at`).run(
        name, parent, spaceOf(name), name.split('/').length, t ?? prev?.mtime ?? null, digest, source.length,
        /\/\d{4}-\d\d-\d\d$/.test(name) ? 1 : 0, title, excerpt, Math.floor(Date.now() / 1000));
      this.db.prepare('DELETE FROM links WHERE src = ?').run(name);
      const ins = this.db.prepare('INSERT OR IGNORE INTO links(src, dst) VALUES(?, ?)');
      for (const dst of extractLinks(name, source)) ins.run(name, dst);
      const m = this.db.prepare('SELECT rid FROM fts_map WHERE name = ?').get(name) as any;
      if (m) this.db.prepare('DELETE FROM fts WHERE rowid = ?').run(m.rid);
      const r = this.db.prepare('INSERT INTO fts(name, title, body) VALUES(?, ?, ?)').run(name, title, body);
      this.db.prepare('INSERT INTO fts_map(name, rid) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET rid = excluded.rid').run(name, Number(r.lastInsertRowid));
      this.db.prepare('DELETE FROM deleted WHERE name = ?').run(name);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deletePage(name: string, time = Math.floor(Date.now() / 1000)): void {
    const m = this.db.prepare('SELECT rid FROM fts_map WHERE name = ?').get(name) as any;
    if (m) this.db.prepare('DELETE FROM fts WHERE rowid = ?').run(m.rid);
    this.db.prepare('DELETE FROM fts_map WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM pages WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM links WHERE src = ?').run(name);
    this.db.prepare('INSERT INTO deleted(name, time) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET time = excluded.time').run(name, time);
  }

  setMtime(name: string, mtime: number): void {
    this.db.prepare('UPDATE pages SET mtime = ? WHERE name = ? AND (mtime IS NULL OR mtime < ?)').run(mtime, name, mtime);
  }

  replaceAttachments(rows: { page: string; file: string; time: number | null; sizeLabel: string }[], page?: string): void {
    this.db.exec('BEGIN');
    if (page) this.db.prepare('DELETE FROM attachments WHERE page = ?').run(page);
    else this.db.exec('DELETE FROM attachments');
    const ins = this.db.prepare('INSERT OR REPLACE INTO attachments(page, file, time, size) VALUES(?,?,?,?)');
    for (const r of rows) ins.run(r.page, r.file, r.time, r.sizeLabel);
    this.db.exec('COMMIT');
  }

  // ------------------------------------------------------------------- read
  allNames(): Set<string> {
    return new Set((this.db.prepare('SELECT name FROM pages').all() as any[]).map((r) => r.name));
  }
  digests(): Map<string, string> {
    return new Map((this.db.prepare('SELECT name, digest FROM pages').all() as any[]).map((r) => [r.name, r.digest]));
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as any).n;
  }
  page(name: string): PageRow | null {
    return (this.db.prepare('SELECT * FROM pages WHERE name = ?').get(name) as any) ?? null;
  }
  exists(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM pages WHERE name = ?').get(name);
  }

  /** Immediate children of `parent` (null = top level), including virtual folders. */
  children(parent: string | null): any[] {
    const prefix = parent ? parent + '/' : '';
    const rows = (parent
      ? this.db.prepare("SELECT name, title, mtime FROM pages WHERE name LIKE ? ESCAPE '\\'").all(likeEscape(prefix) + '%')
      : this.db.prepare('SELECT name, title, mtime FROM pages').all()) as any[];
    const map = new Map<string, any>();
    for (const r of rows) {
      const rest = r.name.slice(prefix.length);
      const seg = rest.split('/')[0];
      const name = prefix + seg;
      let e = map.get(name);
      if (!e) {
        e = { name, label: seg, title: seg, mtime: null, is_date: /^\d{4}-\d\d-\d\d$/.test(seg) ? 1 : 0, children: 0, virtual: 1 };
        map.set(name, e);
      }
      if (rest === seg) { e.virtual = 0; e.mtime = r.mtime; e.title = r.title; }
      else e.children++;
    }
    return [...map.values()].sort((a, b) => (b.is_date - a.is_date) || (a.is_date ? (a.name < b.name ? 1 : -1) : a.name.localeCompare(b.name, 'ja')));
  }

  spaces(hidden: RegExp[] = []): any[] {
    const rows = this.db.prepare(`SELECT space, COUNT(*) AS pages, MAX(mtime) AS mtime,
        SUM(CASE WHEN mtime > ? THEN 1 ELSE 0 END) AS week
      FROM pages GROUP BY space ORDER BY pages DESC`).all(Math.floor(Date.now() / 1000) - 7 * 86400) as any[];
    return rows.filter((r) => !hidden.some((h) => h.test(r.space)));
  }

  recent(limit = 30, space?: string, hidden: RegExp[] = []): any[] {
    const rows = space
      ? this.db.prepare('SELECT name, title, space, mtime FROM pages WHERE space = ? AND mtime IS NOT NULL ORDER BY mtime DESC LIMIT ?').all(space, limit + 20)
      : this.db.prepare('SELECT name, title, space, mtime FROM pages WHERE mtime IS NOT NULL ORDER BY mtime DESC LIMIT ?').all(limit + 20);
    return (rows as any[]).filter((r) => !hidden.some((h) => h.test(r.name))).slice(0, limit);
  }

  suggest(q: string, limit = 10): any[] {
    const like = '%' + likeEscape(q) + '%';
    const leafExact = '%/' + likeEscape(q);
    const leafPrefix = '%/' + likeEscape(q) + '%';
    return this.db.prepare(`SELECT name, title, space, mtime FROM pages WHERE name LIKE ? ESCAPE '\\'
      ORDER BY (name = ?) DESC, (name LIKE ? ESCAPE '\\') DESC, (name LIKE ? ESCAPE '\\') DESC,
        (name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') DESC, length(name) ASC, mtime DESC LIMIT ?`).all(
      like, q, leafExact, likeEscape(q) + '%', leafPrefix, likeEscape(q) + '%', limit) as any[];
  }

  search(q: string, opts: { space?: string; mode?: 'and' | 'or'; in?: 'all' | 'title' | 'body'; limit?: number; offset?: number } = {}): { total: number; items: any[] } {
    const terms = q.split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
    if (!terms.length) return { total: 0, items: [] };
    const cols = opts.in === 'title' ? ['name', 'title'] : opts.in === 'body' ? ['body'] : ['name', 'title', 'body'];
    const conds: string[] = [];
    const args: any[] = [];
    for (const t of terms) {
      conds.push('(' + cols.map((c) => `f.${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      for (let i = 0; i < cols.length; i++) args.push('%' + likeEscape(t) + '%');
    }
    let where = conds.join(opts.mode === 'or' ? ' OR ' : ' AND ');
    // use the trigram index when every term is long enough (fast path)
    const ftsable = terms.every((t) => [...t].length >= 3) && opts.mode !== 'or';
    let from = 'fts f';
    if (ftsable) {
      const colFilter = opts.in === 'title' ? '{name title} : ' : opts.in === 'body' ? 'body : ' : '';
      const match = terms.map((t) => colFilter + '"' + t.replace(/"/g, '""') + '"').join(' AND ');
      from = 'fts f';
      where = `fts MATCH ?`;
      args.length = 0;
      args.push(match);
    }
    let sql = `FROM ${from} JOIN fts_map m ON m.rid = f.rowid JOIN pages p ON p.name = m.name WHERE (${where})`;
    if (opts.space) { sql += ' AND p.space = ?'; args.push(opts.space); }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as any).n;
    const first = terms[0];
    const rows = this.db.prepare(`SELECT p.name, p.title, p.space, p.mtime, f.body AS body
      ${sql} ORDER BY (p.name = ?) DESC, (p.name LIKE ? ESCAPE '\\') DESC,
      (instr(p.name, ?) > 0) DESC, p.mtime DESC LIMIT ? OFFSET ?`).all(
      ...args, q, '%' + likeEscape(first) + '%', first, opts.limit ?? 30, opts.offset ?? 0) as any[];
    const items = rows.map((r) => ({
      name: r.name, title: r.title, space: r.space, mtime: r.mtime,
      nameHtml: highlight(r.name, terms),
      snippet: snippet(r.body ?? '', terms),
    }));
    return { total, items };
  }

  backlinks(page: string): any[] {
    return this.db.prepare(`SELECT p.name, p.title, p.space, p.excerpt, p.mtime FROM links l JOIN pages p ON p.name = l.src
      WHERE l.dst = ? ORDER BY p.mtime DESC LIMIT 100`).all(page) as any[];
  }

  /** Pages that share outgoing links with `page` (2-hop), excluding hubs. */
  twoHop(page: string, limit = 12): any[] {
    return this.db.prepare(`
      WITH mine AS (SELECT dst FROM links WHERE src = ?),
      hubs AS (SELECT dst FROM links GROUP BY dst HAVING COUNT(*) > 200)
      SELECT p.name, p.title, p.space, p.excerpt, p.mtime, COUNT(*) AS shared,
        (SELECT group_concat(dst, '\n') FROM (SELECT l2.dst FROM links l2 WHERE l2.src = p.name AND l2.dst IN (SELECT dst FROM mine) LIMIT 2)) AS via
      FROM links l JOIN pages p ON p.name = l.src
      WHERE l.dst IN (SELECT dst FROM mine) AND l.dst NOT IN (SELECT dst FROM hubs) AND l.src <> ?
        AND l.src NOT IN (SELECT dst FROM mine)
      GROUP BY p.name ORDER BY shared DESC, p.mtime DESC LIMIT ?`).all(page, page, limit) as any[];
  }

  siblings(page: string): { prev: any | null; next: any | null } {
    const parent = parentOf(page);
    if (parent === null) return { prev: null, next: null };
    const prev = this.db.prepare('SELECT name, title FROM pages WHERE parent = ? AND name < ? ORDER BY name DESC LIMIT 1').get(parent, page) ?? null;
    const next = this.db.prepare('SELECT name, title FROM pages WHERE parent = ? AND name > ? ORDER BY name ASC LIMIT 1').get(parent, page) ?? null;
    return { prev, next };
  }

  orphans(limit = 100): { missing: any[]; unlinked: any[] } {
    const missing = this.db.prepare(`SELECT l.dst AS name, COUNT(*) AS refs, group_concat(l.src, '\n') AS sources FROM links l
      LEFT JOIN pages p ON p.name = l.dst WHERE p.name IS NULL GROUP BY l.dst ORDER BY refs DESC LIMIT ?`).all(limit) as any[];
    const unlinked = this.db.prepare(`SELECT p.name, p.mtime FROM pages p WHERE p.depth = 1 AND NOT EXISTS (SELECT 1 FROM links l WHERE l.dst = p.name)
      AND NOT EXISTS (SELECT 1 FROM pages c WHERE c.parent = p.name) ORDER BY p.mtime DESC LIMIT ?`).all(limit) as any[];
    return { missing, unlinked };
  }

  stale(space: string | null, beforeSec: number, limit = 10): any[] {
    return (space
      ? this.db.prepare('SELECT name, title, space, mtime FROM pages WHERE space = ? AND mtime < ? ORDER BY mtime ASC LIMIT ?').all(space, beforeSec, limit)
      : this.db.prepare('SELECT name, title, space, mtime FROM pages WHERE mtime < ? AND is_date = 0 ORDER BY mtime ASC LIMIT ?').all(beforeSec, limit)) as any[];
  }

  calendar(prefix: string, ym: string): any[] {
    return this.db.prepare(`SELECT name, excerpt, mtime FROM pages WHERE parent = ? AND name LIKE ? ESCAPE '\\' ORDER BY name`).all(
      prefix, likeEscape(`${prefix}/${ym}-`) + '%') as any[];
  }

  attachmentsOf(page: string): any[] {
    return this.db.prepare('SELECT file, time, size FROM attachments WHERE page = ? ORDER BY file').all(page) as any[];
  }
  allAttachments(limit = 500): any[] {
    return this.db.prepare('SELECT page, file, time, size FROM attachments ORDER BY time DESC LIMIT ?').all(limit) as any[];
  }
  deletedPages(limit = 200): any[] {
    return this.db.prepare('SELECT name, time FROM deleted ORDER BY time DESC LIMIT ?').all(limit) as any[];
  }
  allPages(space?: string): any[] {
    return (space
      ? this.db.prepare('SELECT name, title, mtime FROM pages WHERE space = ? ORDER BY name').all(space)
      : this.db.prepare('SELECT name, title, mtime FROM pages ORDER BY name').all()) as any[];
  }

  // -------------------------------------------------------------- audit
  audit(e: { user: string; ip: string; action: string; page?: string; detail?: unknown; ok: boolean }): void {
    this.db.prepare('INSERT INTO audit(time, user, ip, action, page, detail, ok) VALUES(?,?,?,?,?,?,?)').run(
      Math.floor(Date.now() / 1000), e.user, e.ip, e.action, e.page ?? null, e.detail === undefined ? null : JSON.stringify(e.detail), e.ok ? 1 : 0);
  }
  auditLog(limit = 200): any[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as any[];
  }
}

export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function highlight(text: string, terms: string[]): string {
  let out = esc(text);
  for (const t of terms) {
    const e = esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(e, 'gi'), (m) => `<mark>${m}</mark>`);
  }
  return out;
}

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const start = Math.max(0, pos - 40);
  const s = body.slice(start, start + 140).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + highlight(s, terms) + (start + 140 < body.length ? '…' : '');
}
