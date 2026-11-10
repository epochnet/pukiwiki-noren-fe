import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppConfig, WikiConfig } from './config.ts';
import { PukiWikiDriver, stripAuthor } from './pukiwiki/driver.ts';
import { renderBody, previewBody, needsSegments, renderWithMarkdown, pageHref, CV_TOKEN_RE } from './pukiwiki/render.ts';
import { parseCvArgs, withNav, selectEntries, renderCalendarViewer } from './pukiwiki/calendarViewer.ts';
import { IndexDb, parentOf } from './index/db.ts';
import { Syncer } from './index/sync.ts';
import { AgentService, lineDelta } from './agent/agent.ts';
import { sideBySide } from './diff.ts';
import { HttpError, log, matchesAny } from './util.ts';
import { visualCoverage } from '../../../packages/syntax/src/index.ts';

export interface WikiCtx {
  cfg: WikiConfig;
  driver: PukiWikiDriver;
  db: IndexDb;
  sync: Syncer;
  agent: AgentService;
  renderCache: Map<string, { at: number; ttl: number; value: any }>;
}

type Env = { Variables: { user: string; ip: string; wiki: WikiCtx } };

export function createWikiCtx(app: AppConfig, cfg: WikiConfig): WikiCtx {
  const driver = new PukiWikiDriver(cfg);
  const db = new IndexDb(app.dataDir, cfg.id);
  const sync = new Syncer(driver, db);
  const agent = new AgentService(app, cfg, driver, db);
  return { cfg, driver, db, sync, agent, renderCache: new Map() };
}

const DYNAMIC_PLUGINS = /^#(include|ls2?|calendar|calendar_viewer|calendar2|recent|popular|online|counter|showrss|tracker_list|bugtrack_list|lookup|navi|related|yetlist)\b/m;
// the same, minus calendar_viewer (filled in per request, so it does not shorten the cache)
const DYNAMIC_PLUGINS_EXCEPT_CV = /^#(include|ls2?|calendar|calendar2|recent|popular|online|counter|showrss|tracker_list|bugtrack_list|lookup|navi|related|yetlist)(?!_viewer)\b/m;
const CV_MAX_ENTRIES = 50;

/** Rendered page body (cached by digest). `cv` lists the #calendar_viewer placeholders in `html`. */
async function renderPage(w: WikiCtx, page: string): Promise<any> {
  const row = w.db.page(page);
  const md = !!w.driver.caps?.markdownPlugin;
  const key = `${page}|${row?.digest ?? ''}|${md ? 'md' : ''}`;
  const hit = w.renderCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const html = await w.driver.getRendered(page);
  // PukiWiki shows the edit form (no "lastmodified") for pages that do not exist
  const exists = html.includes('id="lastmodified"') && !/<textarea name="msg"/.test(html);
  const rendered: any = { ...renderBody(w.driver, w.cfg.id, html), exists, cv: [] };
  const src = rendered.exists ? (await w.driver.getSource(page)) : null;
  rendered.dynamic = src ? DYNAMIC_PLUGINS.test(src.source) : false;
  if (src && needsSegments(src.source, md)) {
    try {
      Object.assign(rendered, await renderWithMarkdown(w.driver, w.cfg.id, page, src.source, { markdown: md }));
      rendered.dynamic = DYNAMIC_PLUGINS_EXCEPT_CV.test(src.source);
    } catch (e) { log.warn(`segment render ${page}: ${(e as Error).message}`); }
  }
  if (src && (!row || row.digest !== src.digest)) {
    w.db.upsertPage(page, src.source, src.digest, rendered.mtime);
  }
  if (!src && row) w.db.deletePage(page);
  const newKey = `${page}|${src?.digest ?? ''}|${md ? 'md' : ''}`;
  if (w.renderCache.size > 500) w.renderCache.delete(w.renderCache.keys().next().value as string);
  w.renderCache.set(newKey, { at: Date.now(), ttl: rendered.dynamic ? 5 * 60_000 : 24 * 3600_000, value: rendered });
  return rendered;
}

/** Replace #calendar_viewer placeholders with the current list of date pages. */
async function fillCalendarViewers(w: WikiCtx, page: string, rendered: any, navParam: string | undefined, nested = false): Promise<string> {
  const raws: string[] = rendered.cv ?? [];
  if (!raws.length) return rendered.html;
  if (nested) return rendered.html.replace(CV_TOKEN_RE, ''); // no calendar_viewer inside an entry
  const nav = new Map<number, string>();
  const m = /^(\d+)\.(.+)$/.exec(navParam ?? '');
  if (m) nav.set(Number(m[1]), m[2]);
  const wiki = w.cfg.id;
  const blocks = await Promise.all(raws.map(async (raw, i) => {
    const parsed = parseCvArgs(raw, page, w.cfg.tzOffsetHours);
    if (!parsed) return '';
    const a = withNav({ ...parsed, pitch: Math.min(parsed.pitch, CV_MAX_ENTRIES) }, nav.get(i));
    const names = (w.db.db.prepare('SELECT name FROM pages WHERE parent = ?').all(a.base) as any[]).map((r) => String(r.name));
    const sel = selectEntries(a, names, w.cfg.tzOffsetHours);
    sel.entries = sel.entries.slice(0, CV_MAX_ENTRIES);
    const bodies = new Map<string, string>();
    await Promise.all(sel.entries.map(async (e) => {
      try {
        const r = await renderPage(w, e.page);
        if (r.exists) bodies.set(e.page, await fillCalendarViewers(w, e.page, r, undefined, true));
      } catch (err) {
        log.warn(`calendar_viewer entry ${e.page}: ${(err as Error).message}`);
        bodies.set(e.page, '<p class="notice error">このページを読み込めませんでした</p>');
      }
    }));
    return renderCalendarViewer(a, i, sel, bodies, {
      page: (p, q) => pageHref(wiki, p) + (q ? `?${q}` : ''),
      self: (q) => pageHref(wiki, page) + (q ? `?${q}` : '') + `#cv-${i}`,
    });
  }));
  return rendered.html.replace(CV_TOKEN_RE, (_: string, a?: string, b?: string) => blocks[Number(a ?? b)] ?? '');
}

export function api(app: AppConfig, wikis: Map<string, WikiCtx>): Hono<Env> {
  const r = new Hono<Env>();

  // ---- identity, CSRF guard, error mapping
  r.use('*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || (c.env as any)?.incoming?.socket?.remoteAddress || '';
    let user = 'anonymous';
    if (app.authMode === 'tailscale' || app.authMode === 'header') {
      user = c.req.header(app.authHeader) || '';
      if (!user) return c.json({ error: { code: 'unauthorized', message: 'ログイン情報がありません（Tailscale 経由でアクセスしてください）' } }, 401);
    }
    c.set('user', user);
    c.set('ip', ip);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-requested-with') !== 'noren') {
      return c.json({ error: { code: 'forbidden', message: 'CSRF チェックに失敗しました' } }, 403);
    }
    await next();
  });
  r.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status as any);
    if ((e as any)?.name === 'ZodError') return c.json({ error: { code: 'bad_request', message: '入力が正しくありません' } }, 400);
    log.error(e);
    return c.json({ error: { code: 'internal', message: (e as Error).message } }, 500);
  });

  r.get('/me', (c) => c.json({ user: c.get('user'), authMode: app.authMode }));
  r.get('/wikis', (c) => c.json([...wikis.values()].map((w) => ({
    id: w.cfg.id, label: w.cfg.label, url: w.cfg.url, pages: w.db.count(), caps: w.driver.caps,
  }))));

  // ---- resolve :wiki
  r.use('/w/:wiki/*', async (c, next) => {
    const w = wikis.get(c.req.param('wiki'));
    if (!w) return c.json({ error: { code: 'wiki_not_found', message: 'Wiki が見つかりません' } }, 404);
    c.set('wiki', w);
    await next();
  });

  const P = (c: Context<Env>) => {
    const p = c.req.query('p') ?? '';
    if (!p) throw new HttpError(400, 'bad_request', 'ページ名がありません');
    return p;
  };
  const audit = (c: Context<Env>, action: string, page: string | undefined, ok: boolean, detail?: unknown) =>
    c.get('wiki').db.audit({ user: c.get('user'), ip: c.get('ip'), action, page, ok, detail });
  const body = async (c: Context<Env>) => (await c.req.json().catch(() => ({}))) as any;

  r.get('/w/:wiki/capabilities', async (c) => {
    const w = c.get('wiki');
    return c.json({ ...(w.driver.caps ?? await w.driver.probe()), agent: w.agent.status, adminPasswordConfigured: !!w.cfg.adminPassword });
  });

  // ---- page
  r.get('/w/:wiki/page', async (c) => {
    const w = c.get('wiki');
    const page = P(c);
    const rendered = await renderPage(w, page);
    const html = rendered.exists ? await fillCalendarViewers(w, page, rendered, c.req.query('cv')) : '';
    const fresh = w.db.page(page);
    return c.json({
      name: page,
      exists: rendered.exists,
      html,
      toc: rendered.toc,
      mtime: rendered.mtime ?? fresh?.mtime ?? null,
      frozen: rendered.frozen,
      title: fresh?.title ?? page.slice(page.lastIndexOf('/') + 1),
      size: fresh?.size ?? 0,
      attachments: w.db.attachmentsOf(page),
      children: w.db.children(page).length,
      classicUrl: w.driver.urlFor(w.driver.codec.q(page)),
    });
  });

  r.get('/w/:wiki/page/source', async (c) => {
    const w = c.get('wiki');
    const ed = await w.driver.getEdit(P(c));
    const cov = visualCoverage(ed.source);
    return c.json({ ...ed, coverage: cov });
  });

  r.get('/w/:wiki/page/raw', async (c) => {
    const w = c.get('wiki');
    const s = await w.driver.getSource(P(c));
    if (!s) throw new HttpError(404, 'page_not_found', 'ページがありません');
    return c.json(s);
  });

  r.post('/w/:wiki/page/preview', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const source = String(b.source ?? '');
    const md = !!w.driver.caps?.markdownPlugin;
    if (needsSegments(source, md)) {
      const r = await renderWithMarkdown(w.driver, w.cfg.id, String(b.p), source, { markdown: md });
      return c.json({ html: await fillCalendarViewers(w, String(b.p), r, undefined) });
    }
    const html = await w.driver.preview(String(b.p), source, String(b.digest ?? ''));
    return c.json({ html: previewBody(w.driver, w.cfg.id, html) });
  });

  r.post('/w/:wiki/render-fragment', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const html = await w.driver.preview(String(b.p || 'FrontPage'), String(b.source ?? ''), '');
    return c.json({ html: previewBody(w.driver, w.cfg.id, html) });
  });

  r.put('/w/:wiki/page', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const page = String(b.p ?? '').trim();
    const source = String(b.source ?? '');
    if (!page || /^\s|\s$|[\[\]#&<>"]|\/\/|^\/|\/$/.test(page) || page.length > 200) {
      throw new HttpError(400, 'invalid_page_name', 'ページ名に使えない文字が含まれています（[ ] # & < > " 先頭・末尾の空白や / など）');
    }
    const bad = w.driver.codec.unencodable(source + page);
    if (bad.length) throw new HttpError(422, 'unencodable_chars', `Wiki の文字コードで保存できない文字があります: ${[...new Set(bad.map((x) => x.char))].join(' ')}`, { chars: bad.slice(0, 50) });
    let digest = String(b.digest ?? '');
    if (!digest) {
      // creating: PukiWiki expects the digest of the (empty) current page
      const ed = await w.driver.getEdit(page);
      if (ed.exists) throw new HttpError(409, 'page_exists', `「${page}」は既に存在します`, { latest_source: ed.source, latest_digest: ed.digest });
      digest = ed.digest;
    }
    const res = await w.driver.write(page, source, digest, { notimestamp: !!b.notimestamp, original: b.original });
    audit(c, source === '' ? 'page.delete' : 'page.write', page, res.ok, res.ok ? { kind: res.kind } : { kind: res.kind });
    if (!res.ok) {
      if (res.kind === 'conflict') {
        const latest = await w.driver.getEdit(page);
        throw new HttpError(409, 'conflict', res.message, { latest_source: latest.source, latest_digest: latest.digest });
      }
      throw new HttpError(res.kind === 'frozen' ? 423 : 502, res.kind, res.message);
    }
    await w.sync.refreshPage(page).catch(() => {});
    for (const k of w.renderCache.keys()) if (k.startsWith(page + '|')) w.renderCache.delete(k);
    const after = w.db.page(page);
    return c.json({ ok: true, kind: res.kind, digest: after?.digest ?? null });
  });

  r.post('/w/:wiki/page/rename', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const from = String(b.p), to = String(b.to ?? '').trim();
    if (!to) throw new HttpError(400, 'bad_request', '新しいページ名を入力してください');
    const res = await w.driver.rename(from, to, String(b.pass ?? w.cfg.adminPassword ?? ''), !!b.related);
    audit(c, 'page.rename', from, res.ok, { to });
    if (!res.ok) throw new HttpError(400, 'rename_failed', res.message);
    w.sync.incremental().catch(() => {});
    await w.sync.refreshPage(to).catch(() => {});
    await w.sync.refreshPage(from).catch(() => {});
    return c.json({ ok: true, to });
  });

  r.post('/w/:wiki/page/freeze', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const page = String(b.p);
    const ok = await w.driver.freeze(page, String(b.pass ?? ''), !!b.freeze);
    audit(c, b.freeze ? 'page.freeze' : 'page.unfreeze', page, ok);
    if (!ok) throw new HttpError(403, 'bad_password', '管理者パスワードが違います');
    for (const k of w.renderCache.keys()) if (k.startsWith(page + '|')) w.renderCache.delete(k);
    return c.json({ ok: true });
  });

  r.get('/w/:wiki/page/related', (c) => {
    const w = c.get('wiki');
    const page = P(c);
    return c.json({ backlinks: w.db.backlinks(page), twoHop: w.db.twoHop(page), siblings: w.db.siblings(page), parent: parentOf(page) });
  });

  r.get('/w/:wiki/page/history', async (c) => {
    const w = c.get('wiki');
    const page = P(c);
    const [list, row] = await Promise.all([w.driver.backups(page), Promise.resolve(w.db.page(page))]);
    return c.json({ current: row ? { mtime: row.mtime } : null, backups: list.reverse() });
  });

  const versionSource = async (w: WikiCtx, page: string, v: string): Promise<string> => {
    if (v === 'current' || v === '') return stripAuthor((await w.driver.getSource(page))?.source ?? '');
    return stripAuthor(await w.driver.backupSource(page, Number(v)));
  };

  r.get('/w/:wiki/page/history/source', async (c) => {
    const w = c.get('wiki');
    return c.json({ source: await versionSource(w, P(c), c.req.query('age') ?? 'current') });
  });

  r.get('/w/:wiki/page/diff', async (c) => {
    const w = c.get('wiki');
    const page = P(c);
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? 'current';
    const [a, b] = await Promise.all([from ? versionSource(w, page, from) : Promise.resolve(''), versionSource(w, page, to)]);
    return c.json(sideBySide(a, b));
  });

  // ---- attachments
  r.get('/w/:wiki/attachments', async (c) => {
    const w = c.get('wiki');
    const page = c.req.query('p');
    if (page) {
      const list = await w.driver.attachments(page);
      w.db.replaceAttachments(list, page);
      return c.json(list);
    }
    return c.json(w.db.allAttachments());
  });

  r.get('/w/:wiki/attachments/raw', async (c) => {
    const w = c.get('wiki');
    const page = c.req.query('page') ?? '', file = c.req.query('file') ?? '';
    const res = await w.driver.openAttachment(page, file, Number(c.req.query('age')) || undefined);
    if (res.status !== 200) throw new HttpError(404, 'attachment_not_found', '添付ファイルが見つかりません');
    const type = res.headers.get('content-type') ?? 'application/octet-stream';
    const ascii = file.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)/i.test(type) && c.req.query('download') !== '1';
    const headers: Record<string, string> = {
      'Content-Type': /text\/html|svg|xml|javascript/i.test(type) ? 'application/octet-stream' : type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
    };
    const len = res.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    return new Response(res.body, { status: 200, headers });
  });

  r.post('/w/:wiki/attachments', async (c) => {
    const w = c.get('wiki');
    const form = await c.req.parseBody();
    const page = String(form.p ?? '');
    const file = form.file as File | undefined;
    if (!page || !file || typeof file === 'string') throw new HttpError(400, 'bad_request', 'ファイルがありません');
    const name = String(form.name || file.name);
    const bad = w.driver.codec.unencodable(name);
    if (bad.length) throw new HttpError(422, 'unencodable_chars', `ファイル名に使えない文字があります: ${bad.map((x) => x.char).join(' ')}`);
    const res = await w.driver.upload(page, name, Buffer.from(await file.arrayBuffer()), file.type, String(form.pass ?? '') || undefined);
    audit(c, 'attach.upload', page, res.ok, { file: name, size: file.size });
    if (!res.ok) throw new HttpError(400, 'upload_failed', res.message);
    await w.sync.refreshAttachments(page).catch(() => {});
    return c.json({ ok: true, file: name });
  });

  r.post('/w/:wiki/attachments/action', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    if (!['delete', 'freeze', 'unfreeze', 'rename'].includes(b.pcmd)) throw new HttpError(400, 'bad_request', '操作が不正です');
    const res = await w.driver.attachAction(String(b.page), String(b.file), b.pcmd, String(b.pass ?? ''), { newname: b.newname, age: b.age });
    audit(c, `attach.${b.pcmd}`, String(b.page), res.ok, { file: b.file, newname: b.newname });
    if (!res.ok) throw new HttpError(400, 'attach_failed', res.message || '操作できませんでした（パスワードを確認してください）');
    await w.sync.refreshAttachments(String(b.page)).catch(() => {});
    return c.json({ ok: true, message: res.message });
  });

  r.get('/w/:wiki/static/image/*', async (c) => {
    const w = c.get('wiki');
    const path = c.req.path.slice(c.req.path.indexOf('/static/') + '/static/'.length);
    if (!/^image\/[\w./-]+\.(png|gif|jpe?g|svg|ico)$/.test(path) || path.includes('..')) throw new HttpError(404, 'not_found', 'not found');
    const res = await fetch(new URL(path, w.cfg.url), { signal: AbortSignal.timeout(10000) });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  });

  // ---- lists / search
  r.get('/w/:wiki/tree', (c) => {
    const w = c.get('wiki');
    const parent = c.req.query('parent') || null;
    const rows = w.db.children(parent).filter((x: any) => parent || !matchesAny(x.name, w.cfg.hiddenPages));
    return c.json(rows);
  });
  r.get('/w/:wiki/spaces', (c) => c.json(c.get('wiki').db.spaces(c.get('wiki').cfg.hiddenPages)));
  r.get('/w/:wiki/search', (c) => {
    const w = c.get('wiki');
    const q = c.req.query('q') ?? '';
    return c.json(w.db.search(q, {
      space: c.req.query('space') || undefined,
      mode: c.req.query('mode') === 'or' ? 'or' : 'and',
      in: (c.req.query('in') as any) || 'all',
      limit: Math.min(Number(c.req.query('limit')) || 30, 100),
      offset: Number(c.req.query('offset')) || 0,
    }));
  });
  r.get('/w/:wiki/suggest', (c) => c.json(c.get('wiki').db.suggest(c.req.query('q') ?? '', Number(c.req.query('limit')) || 8)));
  r.get('/w/:wiki/recent', (c) => {
    const w = c.get('wiki');
    return c.json(w.db.recent(Math.min(Number(c.req.query('limit')) || 50, 300), c.req.query('space') || undefined, w.cfg.hiddenPages));
  });
  r.get('/w/:wiki/orphans', (c) => c.json(c.get('wiki').db.orphans()));
  r.get('/w/:wiki/deleted', (c) => c.json(c.get('wiki').db.deletedPages()));
  r.get('/w/:wiki/pages', (c) => c.json(c.get('wiki').db.allPages(c.req.query('space') || undefined)));
  r.get('/w/:wiki/calendar', (c) => {
    const ym = c.req.query('ym') ?? new Date().toISOString().slice(0, 7);
    return c.json(c.get('wiki').db.calendar(c.req.query('prefix') ?? '', ym));
  });
  r.get('/w/:wiki/dashboard', (c) => {
    const w = c.get('wiki');
    const yearAgo = Math.floor(Date.now() / 1000) - 365 * 86400;
    const orph = w.db.orphans(8);
    return c.json({
      pages: w.db.count(),
      spaces: w.db.spaces(w.cfg.hiddenPages).slice(0, 12),
      spaceCount: w.db.spaces(w.cfg.hiddenPages).length,
      recent: w.db.recent(10, undefined, w.cfg.hiddenPages),
      missing: orph.missing,
      stale: w.db.stale(null, yearAgo, 6),
      sync: w.sync.status,
    });
  });
  r.get('/w/:wiki/audit', (c) => c.json(c.get('wiki').db.auditLog(Number(c.req.query('limit')) || 200)));

  // ---- sync
  r.get('/w/:wiki/sync/status', (c) => c.json(c.get('wiki').sync.status));
  r.post('/w/:wiki/sync/full', (c) => {
    c.get('wiki').sync.full().catch((e) => log.error(e));
    return c.json({ ok: true });
  });
  r.post('/w/:wiki/sync/incremental', async (c) => c.json({ updated: await c.get('wiki').sync.incremental() }));

  // ---- plugin form relay
  r.post('/w/:wiki/forms', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const action = String(b.action ?? './');
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.fields ?? {})) fields[k] = String(v);
    const plugin = fields.plugin ?? fields.cmd ?? '';
    const allowed = ['comment', 'pcomment', 'article', 'vote', 'memo', 'insert', 'tracker', 'bugtrack', 'calendar_edit', 'lookup', 'paint', 'search', 'edit', 'newpage', 'template', 'add'];
    if (!allowed.includes(plugin)) throw new HttpError(400, 'plugin_not_allowed', `このフォーム（${plugin || '不明'}）は中継できません`);
    if (plugin === 'edit' && fields.write) throw new HttpError(400, 'plugin_not_allowed', '編集はエディタから行ってください');
    const res = await w.driver.relayForm(action, fields);
    const target = fields.refer || String(b.page ?? '');
    audit(c, `form.${plugin}`, target, res.status < 400, { plugin });
    if (/衝突|collided/.test(res.text)) throw new HttpError(409, 'conflict', '他の人が先に更新しました。ページを再読み込みしてください');
    let redirect: string | null = null;
    if (res.location) redirect = w.driver.pageFromHref(res.location.replace(/^https?:\/\/[^/]+/, '')) ?? null;
    if (plugin === 'lookup' && res.location) return c.json({ external: res.location });
    if (target) await w.sync.refreshPage(target).catch(() => {});
    for (const k of w.renderCache.keys()) if (k.startsWith(target + '|')) w.renderCache.delete(k);
    return c.json({ ok: res.status < 400, page: redirect ?? target });
  });

  // ---- agent
  r.get('/w/:wiki/agent/status', (c) => c.json(c.get('wiki').agent.status));
  r.post('/w/:wiki/agent/runs', async (c) => {
    const w = c.get('wiki');
    if (!w.agent.enabled) throw new HttpError(503, 'agent_disabled', w.agent.status.reason ?? 'AI 機能は無効です');
    const b = await body(c);
    const user = c.get('user');
    audit(c, 'agent.run', b.context?.page, true, { message: String(b.message ?? '').slice(0, 200) });
    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      try {
        await w.agent.run({ message: String(b.message ?? ''), history: b.history, context: b.context }, user,
          (e) => { stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => {}); }, ctrl.signal);
      } catch (e) {
        log.warn('agent run failed', (e as Error).message);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
      }
    });
  });
  r.post('/w/:wiki/agent/rewrite', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const text = await w.agent.rewrite(String(b.instruction ?? ''), String(b.text ?? ''), b.page);
    audit(c, 'agent.rewrite', b.page, true, { instruction: String(b.instruction ?? '').slice(0, 200) });
    return c.json({ text });
  });
  r.get('/w/:wiki/agent/proposals', (c) => {
    const w = c.get('wiki');
    const status = c.req.query('status') ?? 'open';
    return c.json(w.db.db.prepare('SELECT id, page, summary, kind, status, created_by, created_at FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status));
  });
  r.get('/w/:wiki/agent/proposals/:id', async (c) => {
    const w = c.get('wiki');
    const p = w.db.db.prepare('SELECT * FROM proposals WHERE id = ?').get(c.req.param('id')) as any;
    if (!p) throw new HttpError(404, 'not_found', '提案が見つかりません');
    const current = p.kind === 'create' ? { source: '', digest: '' } : await w.driver.getEdit(p.page);
    const stale = p.kind !== 'create' && current.digest !== p.base_digest;
    return c.json({ ...p, stale, diff: sideBySide(current.source, p.source), delta: lineDelta(current.source, p.source) });
  });
  r.post('/w/:wiki/agent/proposals/:id/apply', async (c) => {
    const w = c.get('wiki');
    const b = await body(c);
    const p = w.db.db.prepare('SELECT * FROM proposals WHERE id = ?').get(c.req.param('id')) as any;
    if (!p || p.status !== 'open') throw new HttpError(404, 'not_found', '提案が見つからないか、既に処理されています');
    const source = typeof b.source === 'string' ? b.source : p.source;
    const res = await w.driver.write(p.page, source, p.base_digest);
    audit(c, 'agent.apply', p.page, res.ok, { id: p.id });
    if (!res.ok) {
      if (res.kind === 'conflict') {
        const latest = await w.driver.getEdit(p.page);
        throw new HttpError(409, 'conflict', '提案を作った後にページが更新されています', { latest_source: latest.source, latest_digest: latest.digest, proposal_source: source });
      }
      throw new HttpError(res.kind === 'frozen' ? 423 : 502, res.kind, res.message);
    }
    w.db.db.prepare('UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run('applied', c.get('user'), Math.floor(Date.now() / 1000), p.id);
    await w.sync.refreshPage(p.page).catch(() => {});
    return c.json({ ok: true, page: p.page });
  });
  r.post('/w/:wiki/agent/proposals/:id/reject', async (c) => {
    const w = c.get('wiki');
    w.db.db.prepare('UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ?').run('rejected', c.get('user'), Math.floor(Date.now() / 1000), c.req.param('id'), 'open');
    audit(c, 'agent.reject', undefined, true, { id: c.req.param('id') });
    return c.json({ ok: true });
  });

  return r;
}
