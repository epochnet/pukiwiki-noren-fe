// Split PukiWiki source into top-level blocks and convert each to a
// ProseMirror-style JSON node. Round-trip guarantee:
//   blocks.map(b => b.src).join('') === source            (always)
//   canonical(block.node) === block.core                 (verified per block;
//                                                          blocks that fail become pkRaw)
import { InlineParseError, parseInline, serializeInline } from './inline.ts';
import type { InlineNode } from './inline.ts';
import { MD_CLOSE, MD_OPEN, stripMdAnchors } from './markdown.ts';

export interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[] | InlineNode[] | any[];
  text?: string;
  marks?: any[];
}

export interface Block {
  /** Original text including trailing blank lines. */
  src: string;
  /** Original text without trailing blank lines. */
  core: string;
  /** Trailing blank lines (only "\n"s). */
  trailing: string;
  node: PMNode;
}

const PLUGIN_LINE = /^#([A-Za-z_][A-Za-z0-9_]*)/;
const ALIGN = /^(LEFT|CENTER|RIGHT):/;

type Kind =
  | 'blank' | 'markdown' | 'plugin' | 'comment' | 'hr' | 'list' | 'heading' | 'pre'
  | 'table' | 'csv' | 'quote' | 'dl' | 'align' | 'tildePara' | 'plain';

function kindOf(line: string): Kind {
  const l = line.replace(/\n$/, '');
  if (l === '' ) return 'blank';
  if (l.startsWith('//')) return 'comment';
  if (PLUGIN_LINE.test(l)) return 'plugin';
  if (/^-{4,}/.test(l)) return 'hr';
  if (/^(-{1,3}|\+{1,3})/.test(l)) return 'list';
  if (l.startsWith('*')) return 'heading';
  if (l[0] === ' ' || l[0] === '\t') return 'pre';
  if (l.startsWith('|')) return 'table';
  if (l.startsWith(',')) return 'csv';
  if (l[0] === '>' || l[0] === '<') return 'quote';
  if (l[0] === ':') return 'dl';
  if (ALIGN.test(l)) return 'align';
  if (l[0] === '~') return 'tildePara';
  return 'plain';
}

/** Split into lines, each keeping its "\n" (the last one may lack it). */
export function splitLines(source: string): string[] {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g);
  return lines ?? [];
}

function rawNode(text: string, reason: string, noFinalNewline = false): PMNode {
  const attrs: Record<string, any> = { reason };
  if (noFinalNewline) attrs.noFinalNewline = true;
  return { type: 'pkRaw', attrs, content: text ? [{ type: 'text', text }] : [] };
}

function stripNl(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

// ---------------------------------------------------------------------------
// canonical serialization of one node (without trailing blank lines)

export function canonical(node: PMNode): string {
  const a = node.attrs ?? {};
  const inl = (n: PMNode) => serializeInline(n.content as InlineNode[]);
  const textOf = (n: PMNode) => ((n.content ?? []) as any[]).map((c) => c.text ?? '').join('');
  const nl = a.noFinalNewline ? '' : '\n';
  switch (node.type) {
    case 'pkHeading':
      return '*'.repeat(a.level ?? 1) + (a.space ?? ' ') + inl(node) + (a.anchor ? ` [#${a.anchor}]` : '') + nl;
    case 'paragraph':
      return (a.lead ?? '') + inl(node) + nl;
    case 'pkList':
      return (a.kind === '+' ? '+' : '-').repeat(a.level ?? 1) + (a.space ?? ' ') + inl(node) + nl;
    case 'pkPre': {
      const text = textOf(node);
      const prefixes: string = a.prefixes ?? '';
      return text.split('\n').map((l, i) => (prefixes[i] ?? ' ') + l).join('\n') + nl;
    }
    case 'table': {
      return ((node.content ?? []) as PMNode[]).map((row) => {
        const cells = ((row.content ?? []) as PMNode[]).map((c) => (c.attrs?.prefix ?? '') + inl(c));
        return '|' + cells.join('|') + '|' + (row.attrs?.fmt ?? '');
      }).join('\n') + nl;
    }
    case 'pkHr':
    case 'pkPlugin':
    case 'pkComment':
    case 'pkMeta':
      return (a.raw ?? '') + nl;
    case 'pkMarkdown': {
      const t = textOf(node);
      const body = t === a.origStripped ? a.origBody : t;
      const parts = [a.open];
      if (body !== '' || a.hasBody) parts.push(body);
      if (a.close !== null && a.close !== undefined) parts.push(a.close);
      return parts.join('\n') + nl;
    }
    case 'pkRaw': {
      const t = textOf(node);
      return t === '' ? '' : t + (a.noFinalNewline ? '' : '\n');
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// structured parsers (return null when the text is not representable)

function tryInline(s: string): InlineNode[] | null {
  try { return parseInline(s); } catch (e) { if (e instanceof InlineParseError) return null; throw e; }
}

function parseHeading(text: string): PMNode | null {
  const m = /^(\*{1,3})( ?)(.*?)(?: \[#([A-Za-z][A-Za-z0-9_-]*)\])?$/.exec(text);
  if (!m) return null;
  const content = tryInline(m[3]);
  if (!content) return null;
  return { type: 'pkHeading', attrs: { level: m[1].length, space: m[2], anchor: m[4] ?? null }, content };
}

function parseList(text: string): PMNode | null {
  const m = /^(-{1,3}|\+{1,3})( ?)(.*)$/.exec(text);
  if (!m) return null;
  const content = tryInline(m[3]);
  if (!content) return null;
  return { type: 'pkList', attrs: { kind: m[1][0], level: m[1].length, space: m[2] }, content };
}

function parsePara(text: string): PMNode | null {
  let lead = '';
  let body = text;
  if (body.startsWith('~')) { lead = '~'; body = body.slice(1); }
  // lines inside a paragraph must not look like other blocks after a soft break
  const content = tryInline(body);
  if (!content) return null;
  return { type: 'paragraph', attrs: { lead }, content };
}

function parsePre(text: string): PMNode | null {
  const lines = text.split('\n');
  const prefixes = lines.map((l) => l[0]).join('');
  const body = lines.map((l) => l.slice(1)).join('\n');
  return { type: 'pkPre', attrs: { prefixes }, content: body ? [{ type: 'text', text: body }] : [] };
}

const CELL_PREFIX = /^(?:(?:LEFT|CENTER|RIGHT|BGCOLOR\([^)]*\)|COLOR\([^)]*\)|SIZE\([0-9]+\)):)*~?/;

function parseTable(text: string): PMNode | null {
  const rows: PMNode[] = [];
  for (const line of text.split('\n')) {
    const m = /^\|(.*)\|([hHfF]?)$/.exec(line);
    if (!m) return null;
    const cells: PMNode[] = [];
    for (const cell of m[1].split('|')) {
      if (cell === '>' || cell === '~') return null; // spans: keep raw
      const prefix = CELL_PREFIX.exec(cell)?.[0] ?? '';
      const content = tryInline(cell.slice(prefix.length));
      if (!content) return null;
      cells.push({ type: 'tableCell', attrs: { prefix }, content });
    }
    rows.push({ type: 'tableRow', attrs: { fmt: m[2] }, content: cells });
  }
  // every row must have the same number of cells for the visual table editor
  const n = rows[0]?.content?.length ?? 0;
  if (!n || rows.some((r) => r.content?.length !== n)) return null;
  return { type: 'table', content: rows };
}

// ---------------------------------------------------------------------------

interface Chunk { kind: Kind; lines: string[] }

function chunk(source: string): Chunk[] {
  const lines = splitLines(source);
  const out: Chunk[] = [];
  let i = 0;
  const isPlain = (l: string) => kindOf(l) === 'plain';
  while (i < lines.length) {
    const line = lines[i];
    const k = kindOf(line);
    if (k === 'blank') { out.push({ kind: 'blank', lines: [line] }); i++; continue; }
    if (k === 'plugin' && MD_OPEN.test(stripNl(line))) {
      let j = i + 1;
      while (j < lines.length && !MD_CLOSE.test(stripNl(lines[j]))) j++;
      const end = j < lines.length ? j + 1 : lines.length;
      out.push({ kind: 'markdown', lines: lines.slice(i, end) });
      i = end;
      continue;
    }
    if (k === 'plugin') {
      const m = /(\{{2,})\s*$/.exec(stripNl(line));
      if (m) {
        const close = '}'.repeat(m[1].length);
        let j = i + 1;
        while (j < lines.length && stripNl(lines[j]) !== close) j++;
        if (j < lines.length) {
          out.push({ kind: 'plugin', lines: lines.slice(i, j + 1) });
          i = j + 1;
          continue;
        }
      }
      out.push({ kind: 'plugin', lines: [line] });
      i++;
      continue;
    }
    if (k === 'comment' || k === 'hr' || k === 'heading') { out.push({ kind: k, lines: [line] }); i++; continue; }
    if (k === 'list') {
      // a list item absorbs following plain lines (PukiWiki joins them)
      let j = i + 1;
      while (j < lines.length && isPlain(lines[j])) j++;
      out.push({ kind: 'list', lines: lines.slice(i, j) });
      i = j;
      continue;
    }
    if (k === 'pre' || k === 'table' || k === 'csv') {
      let j = i + 1;
      while (j < lines.length && kindOf(lines[j]) === k) j++;
      out.push({ kind: k, lines: lines.slice(i, j) });
      i = j;
      continue;
    }
    if (k === 'quote' || k === 'dl' || k === 'align') {
      let j = i + 1;
      while (j < lines.length && (kindOf(lines[j]) === k || isPlain(lines[j]))) j++;
      out.push({ kind: k, lines: lines.slice(i, j) });
      i = j;
      continue;
    }
    // paragraph: plain lines (a tilde line starts a paragraph)
    let j = i + 1;
    while (j < lines.length && isPlain(lines[j])) j++;
    out.push({ kind: 'plain', lines: lines.slice(i, j) });
    i = j;
  }
  return out;
}

function markdownNode(style: 'region' | 'braces', open: string, close: string | null, bodyLines: string[]): PMNode {
  const origBody = bodyLines.join('\n');
  const origStripped = stripMdAnchors(origBody);
  return {
    type: 'pkMarkdown',
    attrs: { style, open, close, origBody, origStripped, hasBody: bodyLines.length > 0 },
    content: origStripped ? [{ type: 'text', text: origStripped }] : [],
  };
}

function structured(kind: Kind, core: string): PMNode {
  const text = stripNl(core);
  const noFinalNewline = !core.endsWith('\n');
  let node: PMNode | null = null;
  let reason = '';
  switch (kind) {
    case 'markdown': {
      const ls = text.split('\n');
      const close = ls.length > 1 && MD_CLOSE.test(ls[ls.length - 1]) ? ls[ls.length - 1] : null;
      const bodyLines = ls.slice(1, close !== null ? -1 : undefined);
      node = markdownNode('region', ls[0], close, bodyLines);
      reason = 'Markdown ブロック';
      break;
    }
    case 'plugin': {
      const name = PLUGIN_LINE.exec(text)?.[1] ?? '';
      const ls = text.split('\n');
      if (name === 'markdown' && ls.length >= 2 && /\{\{+\s*$/.test(ls[0])) {
        node = markdownNode('braces', ls[0], ls[ls.length - 1], ls.slice(1, -1));
        reason = 'Markdown ブロック';
        break;
      }
      node = { type: name === 'author' ? 'pkMeta' : 'pkPlugin', attrs: { raw: text, name } };
      break;
    }
    case 'comment': node = { type: 'pkComment', attrs: { raw: text } }; break;
    case 'hr': node = { type: 'pkHr', attrs: { raw: text } }; break;
    case 'heading': node = parseHeading(text); reason = '見出しの書き方'; break;
    case 'list':
      node = text.includes('\n') ? null : parseList(text);
      reason = 'リストの続きの行';
      break;
    case 'pre': node = parsePre(text); break;
    case 'table': node = parseTable(text); reason = '表のセル結合・書式行'; break;
    case 'csv': reason = 'CSV 形式の表'; break;
    case 'quote': reason = '引用'; break;
    case 'dl': reason = '定義リスト'; break;
    case 'align': reason = '文字揃え'; break;
    case 'plain':
    case 'tildePara':
      node = parsePara(text); reason = 'インラインの書き方'; break;
    default: break;
  }
  if (node) {
    if (noFinalNewline) node.attrs = { ...(node.attrs ?? {}), noFinalNewline: true };
    if (canonical(node) === core) return node;
    if (!reason) reason = '往復できない書き方';
  }
  return rawNode(text, reason || '未対応の書き方', noFinalNewline);
}


export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let leading = '';
  for (const c of chunk(source)) {
    if (c.kind === 'blank') {
      if (blocks.length) {
        const b = blocks[blocks.length - 1];
        b.trailing += c.lines[0];
        b.src += c.lines[0];
      } else {
        leading += c.lines[0];
      }
      continue;
    }
    const core = c.lines.join('');
    blocks.push({ src: core, core, trailing: '', node: structured(c.kind, core) });
  }
  if (leading) {
    // leading blank lines: keep them as an (invisible) raw block at the top
    const node = rawNode('', '先頭の空行');
    blocks.unshift({ src: leading, core: '', trailing: leading, node });
  }
  return blocks;
}
