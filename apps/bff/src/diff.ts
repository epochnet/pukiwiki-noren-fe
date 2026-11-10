import { diffLines, diffWordsWithSpace } from 'diff';

export interface DiffRow {
  type: 'eq' | 'del' | 'add' | 'mod' | 'gap';
  oldNo?: number; newNo?: number;
  oldHtml?: string; newHtml?: string;
  count?: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function splitLines(v: string): string[] {
  const ls = v.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

/** Side-by-side diff rows with intra-line highlights and collapsed context. */
export function sideBySide(a: string, b: string, context = 3): { rows: DiffRow[]; plus: number; minus: number } {
  const parts = diffLines(a, b);
  const raw: DiffRow[] = [];
  let o = 1, n = 1, plus = 0, minus = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = splitLines(p.value);
    if (p.removed && parts[i + 1]?.added) {
      const added = splitLines(parts[i + 1].value);
      const max = Math.max(lines.length, added.length);
      for (let k = 0; k < max; k++) {
        const l = lines[k], r = added[k];
        if (l !== undefined && r !== undefined) {
          const w = diffWordsWithSpace(l, r);
          raw.push({
            type: 'mod', oldNo: o++, newNo: n++,
            oldHtml: w.filter((x) => !x.added).map((x) => (x.removed ? `<s>${esc(x.value)}</s>` : esc(x.value))).join(''),
            newHtml: w.filter((x) => !x.removed).map((x) => (x.added ? `<ins>${esc(x.value)}</ins>` : esc(x.value))).join(''),
          });
        } else if (l !== undefined) raw.push({ type: 'del', oldNo: o++, oldHtml: esc(l) });
        else raw.push({ type: 'add', newNo: n++, newHtml: esc(r as string) });
      }
      minus += lines.length; plus += added.length;
      i++;
      continue;
    }
    for (const l of lines) {
      if (p.added) { raw.push({ type: 'add', newNo: n++, newHtml: esc(l) }); plus++; }
      else if (p.removed) { raw.push({ type: 'del', oldNo: o++, oldHtml: esc(l) }); minus++; }
      else raw.push({ type: 'eq', oldNo: o++, newNo: n++, oldHtml: esc(l), newHtml: esc(l) });
    }
  }
  // collapse unchanged runs far from changes
  const keep = raw.map((r) => r.type !== 'eq');
  const near = raw.map((_, i) => {
    for (let d = -context; d <= context; d++) if (keep[i + d]) return true;
    return false;
  });
  const rows: DiffRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (near[i]) { rows.push(raw[i]); continue; }
    let j = i;
    while (j < raw.length && !near[j]) j++;
    rows.push({ type: 'gap', count: j - i });
    i = j - 1;
  }
  return { rows, plus, minus };
}
