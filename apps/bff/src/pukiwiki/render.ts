// Turn a PukiWiki page response into safe, re-linked body HTML for the new UI.
import { parseHTML } from 'linkedom';
import sanitizeHtml from 'sanitize-html';
import { bodyInner, divInner } from './driver.ts';
import type { PukiWikiDriver } from './driver.ts';
import { htmlUnescape } from './codec.ts';
import { parseBlocks, renderMarkdown } from '../../../../packages/syntax/src/index.ts';

export interface TocItem { id: string; text: string; level: number }
export interface Rendered { html: string; toc: TocItem[]; mtime: number | null; frozen: boolean }

export const pageHref = (wiki: string, page: string) =>
  `/w/${encodeURIComponent(wiki)}/p/${page.split('/').map(encodeURIComponent).join('/')}`;

function parseQuery(driver: PukiWikiDriver, q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of q.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[pair.slice(0, i)] = driver.codec.unq(pair.slice(i + 1));
  }
  return out;
}

export function rewriteHref(driver: PukiWikiDriver, wiki: string, href: string): { href: string; kind: 'page' | 'missing' | 'attach' | 'external' | 'classic' | 'anchor' } {
  const h = htmlUnescape(href).trim();
  if (h.startsWith('#')) return { href: h, kind: 'anchor' };
  let rest: string | null = driver.localPart(h);
  if (rest !== null) { /* absolute link into this wiki */ }
  else if (h.startsWith('./') || h.startsWith('?')) rest = h.replace(/^\.\//, '');
  else if (/^[a-z]+:/i.test(h) || h.startsWith('//')) return { href: h, kind: 'external' };
  else rest = h;
  const qi = rest.indexOf('?');
  if (qi < 0) return { href: driver.publicUrlFor('').replace(/[?&]$/, '') + rest, kind: 'classic' };
  let q = rest.slice(qi + 1);
  let frag = '';
  const hi = q.indexOf('#');
  if (hi >= 0) { frag = q.slice(hi); q = q.slice(0, hi); }
  if (!q.includes('=')) return { href: pageHref(wiki, driver.codec.unq(q)) + frag, kind: 'page' };
  const p = parseQuery(driver, q);
  if ((p.cmd ?? '') === 'read' && p.page) return { href: pageHref(wiki, p.page) + frag, kind: 'page' };
  if (p.cmd === 'edit' && p.page && p.refer !== undefined) {
    return { href: `/w/${encodeURIComponent(wiki)}/new?page=${encodeURIComponent(p.page)}`, kind: 'missing' };
  }
  if (p.plugin === 'attach' && p.openfile && p.refer) {
    return { href: `/api/w/${encodeURIComponent(wiki)}/attachments/raw?page=${encodeURIComponent(p.refer)}&file=${encodeURIComponent(p.openfile)}`, kind: 'attach' };
  }
  if (p.plugin === 'ref' && p.page && p.src) {
    return { href: `/api/w/${encodeURIComponent(wiki)}/attachments/raw?page=${encodeURIComponent(p.page)}&file=${encodeURIComponent(p.src)}`, kind: 'attach' };
  }
  if (p.plugin === 'attach' && p.pcmd === 'open' && p.file && p.refer) {
    return { href: `/api/w/${encodeURIComponent(wiki)}/attachments/raw?page=${encodeURIComponent(p.refer)}&file=${encodeURIComponent(p.file)}${p.age ? `&age=${p.age}` : ''}`, kind: 'attach' };
  }
  return { href: driver.publicUrlFor(q) + frag, kind: 'classic' };
}

function rewriteSrc(driver: PukiWikiDriver, wiki: string, src: string): string {
  const s = htmlUnescape(src).trim();
  const local = driver.localPart(s);
  if (/^(data:|https?:\/\/(?!))/.test(s) && local === null) return s;
  const rest = local ?? s.replace(/^\.\//, '');
  if (rest.startsWith('?') || rest.startsWith('index.php?')) {
    const q = rest.slice(rest.indexOf('?') + 1);
    const p = parseQuery(driver, q);
    if (p.plugin === 'attach' && p.refer && (p.openfile || p.file)) {
      return `/api/w/${encodeURIComponent(wiki)}/attachments/raw?page=${encodeURIComponent(p.refer)}&file=${encodeURIComponent(p.openfile || p.file)}`;
    }
    if (p.plugin === 'ref' && p.page && p.src) {
      return `/api/w/${encodeURIComponent(wiki)}/attachments/raw?page=${encodeURIComponent(p.page)}&file=${encodeURIComponent(p.src)}`;
    }
  }
  if (/^image\/[\w./-]+$/.test(rest)) return `/api/w/${encodeURIComponent(wiki)}/static/${rest}`;
  return s;
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
    'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
    'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'form', 'input', 'textarea', 'select', 'option', 'button', 'label', 'fieldset', 'legend',
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'style', 'data-*', 'lang', 'colspan', 'rowspan', 'align'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    form: ['method', 'data-pkwk-action', 'data-pkwk-form'],
    input: ['type', 'name', 'value', 'checked', 'size', 'maxlength', 'placeholder', 'required', 'disabled', 'readonly'],
    textarea: ['name', 'rows', 'cols', 'placeholder', 'required'],
    select: ['name', 'multiple'],
    option: ['value', 'selected'],
    button: ['type', 'name', 'value'],
    label: ['for'],
    td: ['colspan', 'rowspan', 'style', 'class'],
    th: ['colspan', 'rowspan', 'style', 'class'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'ftp'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: {
    '*': {
      color: [/^[#\w(),.\s%]+$/],
      'background-color': [/^[#\w(),.\s%]+$/],
      'font-size': [/^[\d.]+(px|em|rem|%|pt)?$|^(small|large|x-large|xx-large|smaller|larger)$/],
      'text-align': [/^(left|right|center|justify)$/],
      'vertical-align': [/^[\w-]+$/],
      width: [/^[\d.]+(px|em|rem|%)?$/],
      height: [/^[\d.]+(px|em|rem|%)?$/],
      'font-weight': [/^\w+$/],
      'text-decoration': [/^[\w\s-]+$/],
      float: [/^(left|right|none)$/],
      clear: [/^(left|right|both|none)$/],
      margin: [/^[\d.\sa-z%-]+$/],
      'margin-left': [/^[\d.]+(px|em|rem|%)?$/],
      'padding-left': [/^[\d.]+(px|em|rem|%)?$/],
    },
  },
};

export function renderBody(driver: PukiWikiDriver, wiki: string, fullHtml: string): Rendered {
  const mt = /<div id="lastmodified">[\s\S]*?data-mtime="([^"]+)"/.exec(fullHtml)?.[1];
  const mtime = mt ? Math.floor(Date.parse(mt) / 1000) : null;
  const frozen = /cmd=unfreeze&amp;page=/.test(fullHtml);
  const inner = bodyInner(fullHtml);
  const { document } = parseHTML(`<!doctype html><html><body><div id="root">${inner}</div></body></html>`);
  const root = document.getElementById('root')!;

  root.querySelectorAll('.jumpmenu, script, style, noscript, iframe, object, embed').forEach((n: any) => n.remove());

  // headings: stable ids from the fixed anchors, and a TOC
  const toc: TocItem[] = [];
  root.querySelectorAll('h2, h3, h4').forEach((h: any) => {
    const anchor = h.querySelector('a.anchor_super');
    const id = anchor?.getAttribute('id') || h.getAttribute('id') || '';
    if (anchor) anchor.remove();
    if (!id) return;
    h.setAttribute('id', id);
    const text = (h.textContent ?? '').trim();
    toc.push({ id, text, level: Number(h.tagName.slice(1)) - 1 });
    const a = document.createElement('a');
    a.setAttribute('class', 'anchor');
    a.setAttribute('href', `#${id}`);
    a.setAttribute('aria-label', 'この見出しへのリンク');
    a.textContent = '#';
    h.appendChild(a);
  });

  root.querySelectorAll('a[href]').forEach((a: any) => {
    const r = rewriteHref(driver, wiki, a.getAttribute('href'));
    a.setAttribute('href', r.href);
    a.setAttribute('data-kind', r.kind);
    if (r.kind === 'external' || r.kind === 'classic') {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    if (r.kind === 'missing') {
      const span = a.parentElement;
      a.setAttribute('class', 'wikilink-missing');
      if (span?.classList?.contains('noexists')) span.replaceWith(a);
    }
  });
  root.querySelectorAll('img[src]').forEach((img: any) => {
    img.setAttribute('src', rewriteSrc(driver, wiki, img.getAttribute('src')));
    img.setAttribute('loading', 'lazy');
  });
  root.querySelectorAll('form').forEach((f: any) => {
    f.setAttribute('data-pkwk-form', '1');
    f.setAttribute('data-pkwk-action', f.getAttribute('action') ?? './');
    f.removeAttribute('action');
  });
  root.querySelectorAll('table').forEach((t: any) => {
    const parent = t.parentElement;
    if (parent && parent.getAttribute('class') === 'ie5') parent.setAttribute('class', 'table-wrap');
    else {
      const wrap = document.createElement('div');
      wrap.setAttribute('class', 'table-wrap');
      t.replaceWith(wrap);
      wrap.appendChild(t);
    }
  });

  const html = sanitizeHtml(root.innerHTML, SANITIZE);
  return { html, toc, mtime, frozen };
}

/** Body of a preview response (PukiWiki shows the preview above the edit form). */
export function previewBody(driver: PukiWikiDriver, wiki: string, fullHtml: string): string {
  const inner = divInner(fullHtml, '<div id="preview">') ?? '';
  return renderBody(driver, wiki, `<div id="body">${inner}</div>`).html;
}

/**
 * Pages using the site's custom #markdown plugin: render PukiWiki parts through
 * PukiWiki (preview) and Markdown parts with markdown-it, in source order.
 * This also fixes two quirks of the plugin in the classic UI: `#markdown{{ }}`
 * shows nothing there, and content after `#endmarkdown()` stays hidden.
 *
 * `#calendar_viewer(...)` lines are left as placeholders (cvToken) that the API
 * fills in on every request (see calendarViewer.ts), so they stay current.
 */
export const hasMarkdown = (source: string) => /^#markdown(\(\)|\{\{)/m.test(source);
export const hasCalendarViewer = (source: string) => /^#calendar_viewer\(/m.test(source);
export const needsSegments = (source: string, markdown: boolean) => (markdown && hasMarkdown(source)) || hasCalendarViewer(source);
export const cvToken = (i: number) => `@@PKFE_CV_${i}@@`;
export const CV_TOKEN_RE = /<p>@@PKFE_CV_(\d+)@@<\/p>|@@PKFE_CV_(\d+)@@/g;

export async function renderWithMarkdown(driver: PukiWikiDriver, wiki: string, page: string, source: string, opts: { markdown: boolean }): Promise<{ html: string; toc: TocItem[]; cv: string[] }> {
  const blocks = parseBlocks(source.replace(/^#author\([^\n]*\)\n/, ''));
  type Part = { kind: 'pk' | 'md' | 'cv'; text: string };
  const parts: Part[] = [];
  const cv: string[] = [];
  for (const b of blocks) {
    const node = b.node as any;
    if (node.type === 'pkPlugin' && node.attrs?.name === 'calendar_viewer') {
      cv.push(String(node.attrs.raw));
      parts.push({ kind: 'cv', text: cvToken(cv.length - 1) });
      continue;
    }
    // without the #markdown plugin, those lines are ordinary wiki text (PukiWiki renders them)
    const md = opts.markdown && node.type === 'pkMarkdown';
    const text = md ? ((node.content ?? []) as any[]).map((t) => t.text ?? '').join('') : b.src;
    const last = parts[parts.length - 1];
    if (!md && last && last.kind === 'pk') last.text += text;
    else parts.push({ kind: md ? 'md' : 'pk', text });
  }
  const htmls = await Promise.all(parts.map(async (p, i) => {
    if (p.kind === 'cv') return `<p>${p.text}</p>`;
    if (p.kind === 'md') {
      const h = renderMarkdown(p.text, { pageHref: (pg) => './?' + driver.codec.q(pg) }).replace(/id="md-/g, `id="md${i}-`);
      return `<div class="markdown-body">${h}</div>`;
    }
    if (!p.text.trim()) return '';
    const full = await driver.preview(page, p.text, '');
    return divInner(full, '<div id="preview">') ?? '';
  }));
  const r = renderBody(driver, wiki, `<div id="body">${htmls.join('\n')}</div>`);
  return { html: r.html, toc: r.toc, cv };
}
