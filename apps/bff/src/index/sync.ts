// Keeps the index in step with PukiWiki: initial/nightly full sync and
// RecentChanges polling. PukiWiki is never written to from here.
import type { PukiWikiDriver } from '../pukiwiki/driver.ts';
import type { IndexDb } from './db.ts';
import { log } from '../util.ts';

export interface SyncStatus {
  running: 'full' | 'incremental' | null;
  progress: { done: number; total: number } | null;
  lastFull: number | null;
  lastIncremental: number | null;
  lastError: string | null;
  pages: number;
}

export class Syncer {
  private driver: PukiWikiDriver;
  private db: IndexDb;
  private timer: NodeJS.Timeout | null = null;
  status: SyncStatus;

  constructor(driver: PukiWikiDriver, db: IndexDb) {
    this.driver = driver;
    this.db = db;
    this.status = {
      running: null, progress: null,
      lastFull: Number(db.getState('lastFull')) || null,
      lastIncremental: Number(db.getState('lastIncremental')) || null,
      lastError: null, pages: db.count(),
    };
  }

  start(intervalSec: number, fullSyncHour: number): void {
    if (!this.status.lastFull) this.full().catch((e) => log.error('full sync failed', e));
    this.timer = setInterval(() => {
      const now = new Date();
      const lastFull = this.status.lastFull ? new Date(this.status.lastFull * 1000) : null;
      const dueFull = now.getHours() === fullSyncHour && (!lastFull || now.getTime() - lastFull.getTime() > 20 * 3600 * 1000);
      (dueFull ? this.full() : this.incremental()).catch((e) => log.warn('sync failed', (e as Error).message));
    }, intervalSec * 1000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** Re-read one page from PukiWiki (after a write through the BFF). */
  async refreshPage(page: string, mtime?: number): Promise<void> {
    const src = await this.driver.getSource(page);
    if (!src) { this.db.deletePage(page); return; }
    this.db.upsertPage(page, src.source, src.digest, mtime ?? Math.floor(Date.now() / 1000));
    this.status.pages = this.db.count();
  }

  async refreshAttachments(page: string): Promise<void> {
    this.db.replaceAttachments(await this.driver.attachments(page), page);
  }

  async full(): Promise<void> {
    if (this.status.running) return;
    this.status.running = 'full';
    this.status.lastError = null;
    const started = Math.floor(Date.now() / 1000);
    try {
      const [names, recent] = await Promise.all([this.driver.listPages(), this.driver.recentChanges()]);
      const times = new Map(recent.map((r) => [r.page, r.time]));
      const known = this.db.allNames();
      const live = new Set(names);
      for (const n of known) if (!live.has(n)) this.db.deletePage(n);
      this.status.progress = { done: 0, total: names.length };
      let i = 0;
      const worker = async () => {
        while (i < names.length) {
          const name = names[i++];
          try {
            const src = await this.driver.getSource(name);
            if (src) this.db.upsertPage(name, src.source, src.digest, times.get(name) ?? null);
          } catch (e) {
            log.warn(`sync ${name}: ${(e as Error).message}`);
          }
          this.status.progress!.done++;
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, this.driver.cfg.concurrency) }, worker));
      try { this.db.replaceAttachments(await this.driver.attachments()); } catch (e) { log.warn('attachments', (e as Error).message); }
      try {
        for (const d of await this.driver.recentDeleted()) if (!live.has(d.page)) this.db.deletePage(d.page, d.time);
      } catch { /* optional */ }
      const newest = recent.reduce((m, r) => Math.max(m, r.time), 0);
      this.db.setState('lastSeen', String(newest));
      this.db.setState('lastFull', String(started));
      this.status.lastFull = started;
      log.info(`[${this.driver.cfg.id}] full sync done: ${names.length} pages in ${Math.floor(Date.now() / 1000) - started}s`);
    } catch (e) {
      this.status.lastError = (e as Error).message;
      throw e;
    } finally {
      this.status.running = null;
      this.status.progress = null;
      this.status.pages = this.db.count();
    }
  }

  async incremental(): Promise<number> {
    if (this.status.running) return 0;
    this.status.running = 'incremental';
    try {
      const lastSeen = Number(this.db.getState('lastSeen')) || 0;
      const recent = await this.driver.recentChanges();
      const fresh = recent.filter((r) => r.time > lastSeen);
      // RecentChanges keeps only $maxshow entries: if everything is new, we may have missed some
      if (fresh.length && fresh.length === recent.length && lastSeen) {
        log.warn(`[${this.driver.cfg.id}] RecentChanges overflow; scheduling full sync`);
        setTimeout(() => this.full().catch(() => {}), 1000).unref();
      }
      for (const r of fresh) {
        try { await this.refreshPage(r.page, r.time); } catch (e) { log.warn(`refresh ${r.page}: ${(e as Error).message}`); }
      }
      const lastDel = Number(this.db.getState('lastDeleted')) || 0;
      let newestDel = lastDel;
      try {
        for (const d of await this.driver.recentDeleted()) {
          if (d.time > lastDel) {
            if (!(await this.driver.getSource(d.page))) this.db.deletePage(d.page, d.time);
            newestDel = Math.max(newestDel, d.time);
          }
        }
      } catch { /* RecentDeleted may not exist */ }
      this.db.setState('lastDeleted', String(newestDel));
      const newest = recent.reduce((m, r) => Math.max(m, r.time), lastSeen);
      this.db.setState('lastSeen', String(newest));
      const now = Math.floor(Date.now() / 1000);
      this.db.setState('lastIncremental', String(now));
      this.status.lastIncremental = now;
      return fresh.length;
    } finally {
      this.status.running = null;
      this.status.pages = this.db.count();
    }
  }
}
