// Extraction helpers for the search index: plain text, links, title.
import { parseBlocks } from './blocks.ts';
import type { PMNode } from './blocks.ts';
import { inlineText, parseLinkInner } from './inline.ts';
import type { InlineNode } from './inline.ts';

function nodeText(node: PMNode): string {
  switch (node.type) {
    case 'pkHeading':
    case 'paragraph':
    case 'pkList':
      return inlineText((node.content ?? []) as InlineNode[]);
    case 'table':
      return ((node.content ?? []) as PMNode[])
        .map((r) => ((r.content ?? []) as PMNode[]).map((c) => inlineText((c.content ?? []) as InlineNode[])).join(' '))
        .join('\n');
    case 'pkPre':
      return ((node.content ?? []) as any[]).map((t) => t.text ?? '').join('');
    case 'pkMarkdown':
      return ((node.content ?? []) as any[]).map((t) => t.text ?? '').join('')
        .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '').replace(/[*_`~]{1,3}/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    case 'pkRaw':
      return stripMarkup(((node.content ?? []) as any[]).map((t) => t.text ?? '').join(''));
    case 'pkPlugin': {
      // keep multi-line plugin bodies (#markdown{{ ... }} etc.) searchable
      const raw: string = node.attrs?.raw ?? '';
      const body = /\{\{\n([\s\S]*)\n\}\}$/.exec(raw);
      return body ? body[1] : '';
    }
    default:
      return '';
  }
}

export function stripMarkup(s: string): string {
  return s
    .replace(/^[-+*:|>,<~ \t]+/gm, '')
    .replace(/\[\[([^\]>]*?)(?:>[^\]]*)?\]\]/g, '$1')
    .replace(/&[A-Za-z_]\w*(\([^)]*\))?\{([^}]*)\};/g, '$2')
    .replace(/&[A-Za-z_#]\w*(\([^)]*\))?;/g, '')
    .replace(/''+|%%+/g, '')
    .replace(/\|/g, ' ');
}

export function plainText(source: string): string {
  return parseBlocks(source)
    .map((b) => (b.node.type === 'pkMeta' ? '' : nodeText(b.node)))
    .filter(Boolean)
    .join('\n');
}

export function firstHeading(source: string): string | null {
  for (const b of parseBlocks(source)) {
    if (b.node.type === 'pkHeading') return inlineText((b.node.content ?? []) as InlineNode[]).trim() || null;
  }
  return null;
}

/** Resolve a link target written on `page` to an absolute page name (no anchor). */
export function resolvePageLink(page: string, target: string): string | null {
  let t = target.trim();
  if (!t || /^(https?|ftp|mailto|news):/i.test(t)) return null;
  const hash = t.indexOf('#');
  if (hash === 0) return null;
  if (hash > 0) t = t.slice(0, hash);
  if (/^[A-Za-z0-9_]+:/.test(t) && !t.includes('/')) return null; // InterWiki
  if (t.startsWith('./') || t.startsWith('../') || t === '.' || t === '..') {
    const parts = page.split('/');
    for (const seg of t.split('/')) {
      if (seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      if (seg) parts.push(seg);
    }
    t = parts.join('/');
  } else if (t.startsWith('/')) {
    t = t.slice(1);
  }
  return t || null;
}

const WIKINAME = /\b(?:[A-Z][a-z]+){2,}(?!\w)/g;

/** Page links in a source (bracket links; WikiNames optionally). */
export function extractLinks(page: string, source: string, opts: { wikiName?: boolean } = {}): string[] {
  const set = new Set<string>();
  for (const m of source.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const { target } = parseLinkInner(m[1]);
    const r = resolvePageLink(page, target);
    if (r && r !== page) set.add(r);
  }
  // plugin arguments that point at pages: #include(Page), #ls2(Page/), &ref(Page/file)
  for (const m of source.matchAll(/^#(?:include|includex|ls2?|calendar_viewer|calendar2?)\(([^,)\n]+)/gm)) {
    const r = resolvePageLink(page, m[1].replace(/\/$/, ''));
    if (r && r !== page) set.add(r);
  }
  if (opts.wikiName) {
    const noBrackets = source.replace(/\[\[[^\]]*\]\]/g, '').replace(/^ .*$/gm, '');
    for (const m of noBrackets.matchAll(WIKINAME)) if (m[0] !== page) set.add(m[0]);
  }
  return [...set];
}

/** `#author("2026-10-13T04:56:12+00:00",...)` → epoch seconds */
export function authorTime(source: string): number | null {
  const m = /^#author\("(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[^"]*)"/m.exec(source);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
