// HTTP driver for PukiWiki 1.5.x. Talks to the ?cmd= / ?plugin= web interface
// in the wiki's own charset and returns plain UTF-8 data.
import { createHash } from 'node:crypto';
import { Codec, htmlUnescape } from './codec.ts';
import type { WikiConfig } from '../config.ts';
import { HttpError, Semaphore, log } from '../util.ts';

export interface EditState { source: string; digest: string; original: string; frozen: boolean; exists: boolean }
export interface RecentEntry { page: string; time: number }
export interface BackupEntry { age: number; time: number; label: string }
export interface AttachmentEntry { page: string; file: string; time: number | null; sizeLabel: string }
export type WriteResult =
  | { ok: true; kind: 'created' | 'updated' | 'deleted' }
  | { ok: false; kind: 'conflict' | 'frozen' | 'error'; message: string };

export interface Capabilities {
  version: string | null;
  siteTitle: string | null;
  encoding: string;
  readonly: boolean;
  search2: boolean;
  /** #markdown plugin installed (see WikiConfig.markdownPlugin) */
  markdownPlugin: boolean;
  attachMaxBytes: number | null;
  checkedAt: number;
}

const UA = 'pukiwiki-noren-fe/0.1 (+internal)';

function between(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1] : null;
}

/** Inner HTML of <div id="body"> (balanced on <div>). */
export function bodyInner(html: string): string {
  return divInner(html, '<div id="body">') ?? html;
}

/** Inner HTML of the div that starts with `marker`, balanced on <div>; null if absent. */
export function divInner(html: string, marker: string): string | null {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  let depth = 1;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(i, m.index);
  }
  return html.slice(i);
}

export class PukiWikiDriver {
  readonly cfg: WikiConfig;
  codec: Codec;
  private sem: Semaphore;
  private base: string;
  caps: Capabilities | null = null;

  constructor(cfg: WikiConfig) {
    this.cfg = cfg;
    this.base = cfg.url;
    this.codec = new Codec(cfg.encoding === 'auto' ? 'euc-jp' : cfg.encoding);
    this.sem = new Semaphore(cfg.concurrency);
  }

  get baseUrl(): string { return this.base; }
  /** The wiki's URL as users' browsers reach it (PUKIWIKI_PUBLIC_URL; same as baseUrl unless set). */
  get publicBaseUrl(): string { return this.cfg.publicUrl; }

  /** The part after the wiki's URL, if `url` points into this wiki (by either URL); otherwise null. */
  localPart(url: string): string | null {
    for (const b of [this.base, this.cfg.publicUrl]) if (url.startsWith(b)) return url.slice(b.length);
    return null;
  }

  // ---------------------------------------------------------------- transport
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': UA, ...extra };
    if (this.cfg.basicUser) {
      h.Authorization = 'Basic ' + Buffer.from(`${this.cfg.basicUser}:${this.cfg.basicPassword ?? ''}`).toString('base64');
    }
    return h;
  }

  urlFor(query: string): string {
    return this.base + (this.base.includes('?') ? '&' : '?') + query;
  }

  /** Link to the classic UI for users (uses the public URL). */
  publicUrlFor(query: string): string {
    const b = this.cfg.publicUrl;
    return b + (b.includes('?') ? '&' : '?') + query;
  }

  private async raw(method: 'GET' | 'POST', query: string, body?: Buffer | string, contentType?: string): Promise<Response> {
    return this.sem.run(async () => {
      const url = query ? this.urlFor(query) : this.base;
      try {
        const res = await fetch(url, {
          method,
          body: body as any,
          redirect: 'manual',
          headers: this.headers(contentType ? { 'Content-Type': contentType } : {}),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        if (res.status === 401) throw new HttpError(502, 'upstream_auth', 'PukiWiki に認証が必要です（Basic 認証の設定を確認してください）');
        if (res.status >= 500) throw new HttpError(502, 'upstream_error', `PukiWiki が HTTP ${res.status} を返しました`);
        return res;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(503, 'upstream_unavailable', `PukiWiki に接続できません: ${(e as Error).message}`);
      }
    });
  }

  private async getText(query: string): Promise<string> {
    const res = await this.raw('GET', query);
    return this.codec.decode(Buffer.from(await res.arrayBuffer()));
  }

  private async postForm(fields: Record<string, string | undefined>, query = ''): Promise<{ status: number; location: string | null; text: string }> {
    const body = this.codec.form({ encode_hint: 'ぷ', ...fields });
    const res = await this.raw('POST', query, body, 'application/x-www-form-urlencoded');
    const text = this.codec.decode(Buffer.from(await res.arrayBuffer()));
    return { status: res.status, location: res.headers.get('location'), text };
  }

  // ------------------------------------------------------------- capabilities
  async probe(): Promise<Capabilities> {
    const res = await this.raw('GET', '');
    const ct = res.headers.get('content-type') ?? '';
    const charset = /charset=([\w-]+)/i.exec(ct)?.[1]?.toLowerCase();
    if (this.cfg.encoding === 'auto' && charset) this.codec = new Codec(charset === 'utf-8' ? 'utf-8' : 'euc-jp');
    const html = this.codec.decode(Buffer.from(await res.arrayBuffer()));
    const version = between(html, /PukiWiki ([0-9][0-9.]+[0-9a-z_-]*)/);
    const siteTitle = between(html, /<title>[^<]*? - ([^<]+)<\/title>/);
    let search2 = false;
    try {
      const r = await this.raw('GET', 'cmd=search2&action=query&q=a&start=0&encode_hint=' + encodeURIComponent('ぷ'));
      const t = await r.text();
      search2 = t.trim().startsWith('{');
    } catch { /* ignore */ }
    const edit = await this.getText('cmd=edit&page=' + this.codec.q('FrontPage'));
    let markdownPlugin = this.cfg.markdownPlugin === 'on';
    if (this.cfg.markdownPlugin === 'auto') {
      // An edit preview (nothing is saved): without the plugin, PukiWiki prints the unknown
      // block plugin line as text; with it, the line becomes plugin output. A page that does
      // not exist is used, since FrontPage is frozen in a fresh install.
      try {
        const pv = divInner(await this.preview('PukiwikiNorenFE/MarkdownProbe', '#markdown()\n#endmarkdown()\n', ''), '<div id="preview">') ?? '';
        markdownPlugin = pv !== '' && !pv.includes('#markdown()');
      } catch { /* treat as not installed */ }
    }
    this.caps = {
      version,
      siteTitle,
      encoding: this.codec.encoding,
      readonly: !edit.includes('name="msg"') && /PKWK_READONLY|prohibit/i.test(edit),
      search2,
      markdownPlugin,
      attachMaxBytes: null,
      checkedAt: Date.now(),
    };
    log.info(`[${this.cfg.id}] PukiWiki ${version ?? '?'} ${this.codec.encoding} search2=${search2} markdown=${markdownPlugin}`);
    return this.caps;
  }

  // -------------------------------------------------------------------- pages
  /** Page name from an href produced by PukiWiki, or null for non-read links. */
  pageFromHref(href: string): string | null {
    const h = htmlUnescape(href);
    const qi = h.indexOf('?');
    if (qi < 0) return null;
    let q = h.slice(qi + 1);
    const hash = q.indexOf('#');
    if (hash >= 0) q = q.slice(0, hash);
    if (!q) return null;
    if (!q.includes('=')) return this.codec.unq(q);
    const params = new URLSearchParams();
    const map: Record<string, string> = {};
    for (const pair of q.split('&')) {
      const [k, v = ''] = pair.split('=');
      map[k] = v;
    }
    void params;
    if ((map.cmd ?? 'read') === 'read' && !map.plugin && map.page !== undefined) return this.codec.unq(map.page);
    return null;
  }

  async listPages(): Promise<string[]> {
    const html = bodyInner(await this.getText('cmd=list'));
    const set = new Set<string>();
    for (const m of html.matchAll(/<a href="([^"]+)"/g)) {
      const p = this.pageFromHref(m[1]);
      if (p) set.add(p);
    }
    return [...set];
  }

  /** Full stored source (including the #author line) + digest. */
  async getSource(page: string): Promise<{ source: string; digest: string } | null> {
    const html = await this.getText('cmd=source&page=' + this.codec.q(page));
    const m = /<pre id="source">([\s\S]*?)<\/pre>/.exec(html);
    if (!m) return null;
    const source = htmlUnescape(m[1]);
    if (source === '' && !(await this.exists(page))) return null;
    const digest = createHash('md5').update(this.codec.encode(source)).digest('hex');
    return { source, digest };
  }

  async exists(page: string): Promise<boolean> {
    const html = await this.getText('cmd=edit&page=' + this.codec.q(page));
    return /<textarea name="original"[^>]*>[\s\S]+?<\/textarea>/.test(html) || html.includes('id="lastmodified"');
  }

  /** Editable text (without #author) as PukiWiki's own edit form presents it. */
  async getEdit(page: string): Promise<EditState> {
    const html = await this.getText('cmd=edit&page=' + this.codec.q(page));
    const digest = between(html, /name="digest" value="([0-9a-f]{32})"/) ?? '';
    const msg = between(html, /<textarea name="msg"[^>]*>([\s\S]*?)<\/textarea>/);
    const original = between(html, /<textarea name="original"[^>]*>([\s\S]*?)<\/textarea>/);
    if (msg === null) {
      // frozen pages show the unfreeze form instead of the editor
      const frozen = /name="cmd"\s+value="unfreeze"|cmd=unfreeze|plugin=unfreeze/.test(html) || /凍結|frozen/i.test(between(html, /<title>([^<]*)<\/title>/) ?? '');
      if (frozen) {
        const src = await this.getSource(page);
        return { source: stripAuthor(src?.source ?? ''), digest: src?.digest ?? '', original: '', frozen: true, exists: !!src };
      }
      throw new HttpError(502, 'upstream_error', '編集フォームを取得できませんでした');
    }
    const source = htmlUnescape(msg);
    return { source, digest, original: htmlUnescape(original ?? ''), frozen: false, exists: digest !== '' && (source !== '' || (original ?? '') !== '') };
  }

  async getRendered(page: string): Promise<string> {
    return this.getText(this.codec.q(page));
  }

  async preview(page: string, source: string, digest: string): Promise<string> {
    const r = await this.postForm({ cmd: 'edit', page, digest, msg: source, preview: '1', original: source });
    return r.text;
  }

  async write(page: string, source: string, digest: string, opts: { notimestamp?: boolean; original?: string } = {}): Promise<WriteResult> {
    const r = await this.postForm({
      cmd: 'edit',
      page,
      digest,
      msg: source,
      original: opts.original ?? source,
      notimestamp: opts.notimestamp ? 'true' : undefined,
      write: '1',
    });
    if (r.status >= 300 && r.status < 400) return { ok: true, kind: digest ? 'updated' : 'created' };
    if (/<textarea name="msg"/.test(r.text)) {
      if (/衝突|collided|conflict/i.test(between(r.text, /<title>([^<]*)<\/title>/) ?? '')) {
        return { ok: false, kind: 'conflict', message: '他の人が先に更新しました' };
      }
      return { ok: false, kind: 'error', message: '保存できませんでした（PukiWiki が編集画面を返しました）' };
    }
    if (source === '') return { ok: true, kind: 'deleted' };
    if (/freeze|凍結|PKWK_READONLY|prohibit/i.test(r.text)) return { ok: false, kind: 'frozen', message: 'ページが凍結されているか、書き込みが禁止されています' };
    return { ok: false, kind: 'error', message: '保存できませんでした' };
  }

  // ------------------------------------------------------------- recent / log
  private parseChangeList(source: string): RecentEntry[] {
    const out: RecentEntry[] = [];
    const off = this.cfg.tzOffsetHours;
    for (const line of source.split('\n')) {
      const m = /^-(\d{4})-(\d\d)-(\d\d) \([^)]*\) (\d\d):(\d\d):(\d\d) .*?\[\[(.+?)\]\]\s*$/.exec(line);
      if (!m) continue;
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - off, +m[5], +m[6]) / 1000;
      out.push({ page: m[7], time: t });
    }
    return out;
  }

  async recentChanges(): Promise<RecentEntry[]> {
    const s = await this.getSource('RecentChanges');
    return s ? this.parseChangeList(s.source) : [];
  }

  async recentDeleted(): Promise<RecentEntry[]> {
    const s = await this.getSource('RecentDeleted');
    return s ? this.parseChangeList(s.source) : [];
  }

  // ------------------------------------------------------------------ backups
  async backups(page: string): Promise<BackupEntry[]> {
    const html = bodyInner(await this.getText('cmd=backup&page=' + this.codec.q(page)));
    const out: BackupEntry[] = [];
    const off = this.cfg.tzOffsetHours;
    for (const m of html.matchAll(/age=(\d+)">\1 \(?(\d{4})-(\d\d)-(\d\d) \([^)]*\) (\d\d):(\d\d):(\d\d)/g)) {
      const t = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5] - off, +m[6], +m[7]) / 1000;
      out.push({ age: +m[1], time: t, label: `${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}` });
    }
    const seen = new Set<number>();
    return out.filter((b) => (seen.has(b.age) ? false : (seen.add(b.age), true)));
  }

  async backupSource(page: string, age: number): Promise<string> {
    const html = bodyInner(await this.getText(`cmd=backup&page=${this.codec.q(page)}&age=${age}&action=source`));
    const m = /<pre>([\s\S]*?)<\/pre>/.exec(html);
    if (!m) throw new HttpError(404, 'backup_not_found', 'その版は見つかりません');
    return htmlUnescape(m[1]);
  }

  // -------------------------------------------------------------- attachments
  async attachments(page?: string): Promise<AttachmentEntry[]> {
    const q = 'plugin=attach&pcmd=list' + (page ? '&refer=' + this.codec.q(page) : '');
    const html = bodyInner(await this.getText(q));
    const out: AttachmentEntry[] = [];
    const re = /pcmd=open&amp;file=([^&"]+)&amp;refer=([^"&]+)" title="([^"]*)"/g;
    for (const m of html.matchAll(re)) {
      const tm = /(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\s*(.*)$/.exec(m[3]);
      const time = tm ? Date.UTC(+tm[1], +tm[2] - 1, +tm[3], +tm[4] - this.cfg.tzOffsetHours, +tm[5], +tm[6]) / 1000 : null;
      out.push({ file: this.codec.unq(m[1]), page: this.codec.unq(m[2]), time, sizeLabel: tm?.[7] ?? '' });
    }
    return out;
  }

  async openAttachment(page: string, file: string, age?: number): Promise<Response> {
    const q = `plugin=attach&pcmd=open&refer=${this.codec.q(page)}&file=${this.codec.q(file)}` + (age ? `&age=${age}` : '');
    return this.raw('GET', q);
  }

  /** Pass-through GET for images/ref plugin output (whitelisted by caller). */
  async passthrough(query: string): Promise<Response> {
    return this.raw('GET', query);
  }

  async upload(page: string, filename: string, data: Buffer, mime: string, pass?: string): Promise<{ ok: boolean; message: string }> {
    const boundary = '----noren' + Math.random().toString(16).slice(2);
    const parts: Buffer[] = [];
    const field = (name: string, value: Buffer, fname?: Buffer, ctype?: string) => {
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
      const pieces: Buffer[] = [Buffer.from(head)];
      if (fname) pieces.push(Buffer.from('; filename="'), fname, Buffer.from('"'));
      head = '\r\n' + (ctype ? `Content-Type: ${ctype}\r\n` : '') + '\r\n';
      pieces.push(Buffer.from(head), value, Buffer.from('\r\n'));
      parts.push(...pieces);
    };
    field('encode_hint', this.codec.encode('ぷ'));
    field('plugin', Buffer.from('attach'));
    field('pcmd', Buffer.from('post'));
    field('refer', this.codec.encode(page));
    const password = pass || this.cfg.adminPassword;
    if (password) field('pass', this.codec.encode(password));
    field('attach_file', data, this.codec.encode(filename.replace(/["\r\n]/g, '_')), mime || 'application/octet-stream');
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const res = await this.raw('POST', '', Buffer.concat(parts), `multipart/form-data; boundary=${boundary}`);
    const text = this.codec.decode(Buffer.from(await res.arrayBuffer()));
    const title = between(text, /<title>([^<]*)<\/title>/) ?? '';
    if (/アップロードしました|uploaded/i.test(title)) return { ok: true, message: 'アップロードしました' };
    const msg = between(bodyInner(text), /<p>([^<]+)<\/p>/) ?? title;
    return { ok: false, message: htmlUnescape(msg.replace(/ - [^-]*$/, '')) || 'アップロードできませんでした' };
  }

  async attachAction(page: string, file: string, pcmd: 'delete' | 'freeze' | 'unfreeze' | 'rename', pass: string, opts: { age?: number; newname?: string } = {}): Promise<{ ok: boolean; message: string }> {
    const r = await this.postForm({
      plugin: 'attach', pcmd, refer: page, file, pass,
      age: opts.age ? String(opts.age) : '0',
      newname: opts.newname,
    });
    const title = between(r.text, /<title>([^<]*)<\/title>/) ?? '';
    const ok = /しました|deleted|frozen|renamed/i.test(title) && !/パスワード|password/i.test(title);
    return { ok, message: htmlUnescape(title.replace(/ - [^-]*$/, '')) };
  }

  // ------------------------------------------------------- freeze / rename
  async isFrozen(page: string): Promise<boolean> {
    return (await this.getEdit(page)).frozen;
  }

  async freeze(page: string, pass: string, freeze: boolean): Promise<boolean> {
    await this.postForm({ cmd: freeze ? 'freeze' : 'unfreeze', page, pass });
    return (await this.isFrozen(page)) === freeze;
  }

  async rename(from: string, to: string, pass: string, related: boolean): Promise<{ ok: boolean; message: string }> {
    const r = await this.postForm({ plugin: 'rename', method: 'page', refer: from, page: to, related: related ? '1' : undefined, pass, exist: '0' });
    if (await this.exists(to)) return { ok: true, message: '名前を変更しました' };
    const err = between(bodyInner(r.text), /<p><strong class="word">([^<]+)<\/strong><\/p>/) ??
      between(bodyInner(r.text), /<p>([^<]{2,80})<\/p>/) ?? '名前を変更できませんでした（パスワードを確認してください）';
    return { ok: false, message: htmlUnescape(err) };
  }

  // ------------------------------------------------------------ form relay
  async relayForm(action: string, fields: Record<string, string>): Promise<{ status: number; location: string | null; text: string }> {
    // action is the original form action, e.g. "./?Page" or "./"
    const q = action.includes('?') ? action.slice(action.indexOf('?') + 1) : '';
    return this.postForm(fields, q);
  }
}

export function stripAuthor(source: string): string {
  return source.replace(/^#author\([^\n]*\)\n/, '');
}
