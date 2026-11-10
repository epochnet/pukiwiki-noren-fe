// PukiWiki inline syntax <-> ProseMirror-style inline JSON.
// Only a conservative subset is structured (bold / italic / strike / underline,
// [[links]], line breaks). Everything else that is special (inline plugins,
// entities, footnotes) becomes an opaque `pkInline` atom that keeps its raw text.
// Callers MUST verify serializeInline(parseInline(s)) === s and fall back to a raw
// block when it does not hold; parseInline throws on input it cannot represent.

export type MarkType = 'bold' | 'italic' | 'strike' | 'underline';
export interface Mark { type: MarkType }
export interface TextNode { type: 'text'; text: string; marks?: Mark[] }
export interface BreakNode { type: 'hardBreak'; attrs: { tilde: boolean } }
export interface LinkNode { type: 'pkLink'; attrs: { raw: string; label: string; target: string } }
export interface InlineAtom { type: 'pkInline'; attrs: { raw: string } }
export type InlineNode = TextNode | BreakNode | LinkNode | InlineAtom;

export class InlineParseError extends Error {}

const MARK_TOKENS: Record<MarkType, string> = {
  bold: "''",
  italic: "'''",
  strike: '%%',
  underline: '%%%',
};
const MARK_ORDER: MarkType[] = ['bold', 'italic', 'strike', 'underline'];

function findBalanced(s: string, start: number, open: string, close: string): number {
  // s[start] === open; returns index of matching close, or -1
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') return -1;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Length of an inline plugin / entity starting at s[i] === '&', or 0. */
export function matchAmp(s: string, i: number): number {
  const m = /^&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i));
  if (!m) return 0;
  let j = i + m[0].length;
  if (s[j] === '(') {
    const k = findBalanced(s, j, '(', ')');
    if (k < 0) return 0;
    j = k + 1;
  }
  if (s[j] === '{') {
    const k = findBalanced(s, j, '{', '}');
    if (k < 0) return 0;
    j = k + 1;
  }
  if (s[j] !== ';') return 0;
  return j + 1 - i;
}

export function parseLinkInner(inner: string): { label: string; target: string } {
  const gt = inner.indexOf('>');
  if (gt >= 0) return { label: inner.slice(0, gt), target: inner.slice(gt + 1) };
  const url = /^(.+?):((?:https?|ftp|mailto|news):.*)$/.exec(inner);
  if (url) return { label: url[1], target: url[2] };
  return { label: inner, target: inner };
}

export function parseInline(s: string): InlineNode[] {
  const out: InlineNode[] = [];
  const active = new Set<MarkType>();
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const marks = MARK_ORDER.filter((m) => active.has(m)).map((type) => ({ type }));
    const node: TextNode = { type: 'text', text: buf };
    if (marks.length) node.marks = marks;
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && sameMarks(prev.marks, node.marks)) prev.text += buf;
    else out.push(node);
    buf = '';
  };
  const toggle = (m: MarkType) => {
    flush();
    if (active.has(m)) active.delete(m);
    else active.add(m);
  };

  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i, i + 3);
    if (rest === "'''") { toggle('italic'); i += 3; continue; }
    if (rest.startsWith("''")) { toggle('bold'); i += 2; continue; }
    if (rest === '%%%') { toggle('underline'); i += 3; continue; }
    if (rest.startsWith('%%')) { toggle('strike'); i += 2; continue; }
    if (rest.startsWith('[[')) {
      const j = s.indexOf(']]', i + 2);
      const nl = s.indexOf('\n', i);
      if (j > i + 2 && (nl < 0 || j < nl)) {
        flush();
        const raw = s.slice(i, j + 2);
        out.push({ type: 'pkLink', attrs: { raw, ...parseLinkInner(raw.slice(2, -2)) } });
        i = j + 2;
        continue;
      }
    }
    if (rest.startsWith('((')) {
      let depth = 0;
      let j = i;
      for (; j < s.length - 1; j++) {
        if (s[j] === '\n') { j = -1; break; }
        if (s[j] === '(' && s[j + 1] === '(') { depth++; j++; continue; }
        if (s[j] === ')' && s[j + 1] === ')') { depth--; j++; if (depth === 0) break; continue; }
      }
      if (j > 0 && depth === 0 && j < s.length) {
        flush();
        out.push({ type: 'pkInline', attrs: { raw: s.slice(i, j + 1) } });
        i = j + 1;
        continue;
      }
    }
    const c = s[i];
    if (c === '&') {
      const n = matchAmp(s, i);
      if (n > 0) {
        flush();
        out.push({ type: 'pkInline', attrs: { raw: s.slice(i, i + n) } });
        i += n;
        continue;
      }
    }
    if (c === '~' && (i + 1 === s.length || s[i + 1] === '\n')) {
      flush();
      out.push({ type: 'hardBreak', attrs: { tilde: true } });
      i += s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ type: 'hardBreak', attrs: { tilde: false } });
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  if (active.size) throw new InlineParseError('unclosed inline mark');
  return out;
}

function sameMarks(a?: Mark[], b?: Mark[]): boolean {
  const x = (a ?? []).map((m) => m.type).sort().join(',');
  const y = (b ?? []).map((m) => m.type).sort().join(',');
  return x === y;
}

export function serializeInline(nodes: readonly InlineNode[] | undefined): string {
  let out = '';
  const stack: MarkType[] = [];
  const setMarks = (want: Set<MarkType>) => {
    // close from the top until every open mark is wanted
    let keep = 0;
    while (keep < stack.length && want.has(stack[keep])) keep++;
    while (stack.length > keep) out += MARK_TOKENS[stack.pop() as MarkType];
    for (const m of MARK_ORDER) {
      if (want.has(m) && !stack.includes(m)) {
        stack.push(m);
        out += MARK_TOKENS[m];
      }
    }
  };
  for (const n of nodes ?? []) {
    if (n.type === 'text') {
      setMarks(new Set((n.marks ?? []).map((m) => m.type).filter((t) => t in MARK_TOKENS) as MarkType[]));
      out += n.text;
    } else if (n.type === 'hardBreak') {
      out += n.attrs?.tilde ? '~\n' : '\n';
    } else {
      setMarks(new Set());
      if (n.type === 'pkLink') out += n.attrs.raw || linkRaw(n.attrs.label, n.attrs.target);
      else if (n.type === 'pkInline') out += n.attrs.raw;
    }
  }
  setMarks(new Set());
  return out;
}

export function linkRaw(label: string, target: string): string {
  if (!label || label === target) return `[[${target}]]`;
  if (/^(https?|ftp|mailto):/.test(target)) return `[[${label}:${target}]]`;
  return `[[${label}>${target}]]`;
}

/** Plain text of inline nodes (for search index / excerpts). */
export function inlineText(nodes: readonly InlineNode[]): string {
  let t = '';
  for (const n of nodes) {
    if (n.type === 'text') t += n.text;
    else if (n.type === 'hardBreak') t += '\n';
    else if (n.type === 'pkLink') t += n.attrs.label;
    else if (n.type === 'pkInline') {
      const body = /\{(.*)\};$/.exec(n.attrs.raw);
      if (body) t += body[1];
      else if (n.attrs.raw.startsWith('((')) t += n.attrs.raw.slice(2, -2);
    }
  }
  return t;
}
