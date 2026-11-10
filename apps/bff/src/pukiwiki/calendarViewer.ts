// #calendar_viewer, rendered by the BFF instead of PukiWiki so that the entries go
// through the same pipeline as normal pages (Markdown blocks included) and every
// link stays inside the new UI. Behaviour follows PukiWiki 1.5.4's plugin:
//   #calendar_viewer(page, yyyy-mm | n | x*y | this [, past | future | view [, date_sep]])

export interface CvArgs {
  base: string;
  /** yyyy-mm (month mode) or null (count mode) */
  month: string | null;
  offset: number;
  pitch: number;
  mode: 'past' | 'future' | 'view';
  sep: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "today" in the wiki's local time, as yyyy, mm, dd. */
export function wikiToday(tzOffsetHours: number, now = Date.now()) {
  const d = new Date(now + tzOffsetHours * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function parseCvArgs(raw: string, currentPage: string, tzOffsetHours: number): CvArgs | null {
  const m = /^#calendar_viewer\((.*)\)\s*$/.exec(raw.trim());
  if (!m) return null;
  const args = m[1].split(',').map((s) => s.trim());
  let base = (args[0] ?? '').replace(/^\[\[|\]\]$/g, '');
  if (base === '' || base === 'this') base = currentPage;
  else if (base.startsWith('./')) base = `${currentPage}/${base.slice(2)}`;
  else if (base.startsWith('../')) base = currentPage.split('/').slice(0, -1).join('/') + '/' + base.slice(3);

  const spec = args[1] ?? '';
  let month: string | null = null;
  let offset = 0;
  let pitch = 10;
  const t = wikiToday(tzOffsetHours);
  if (spec === 'this') month = `${t.y}-${pad(t.m)}`;
  else if (/^\d{4}-\d{1,2}$/.test(spec)) { const [y, mo] = spec.split('-'); month = `${y}-${pad(Number(mo))}`; }
  else if (/^\d+\*\d+$/.test(spec)) { const [a, b] = spec.split('*').map(Number); offset = a; pitch = b; }
  else if (/^\d+$/.test(spec)) pitch = Number(spec);
  if (pitch <= 0) pitch = 10;

  const modeArg = (args[2] ?? '').toLowerCase();
  const mode = modeArg === 'future' || modeArg === 'view' ? modeArg : 'past';
  const sep = args[3] !== undefined && args[3] !== '' ? args[3] : '-';
  return { base: base.replace(/\/+$/, ''), month, offset, pitch, mode, sep };
}

/** Apply a navigation override from the URL ("5" = offset, "2026-10" = month). */
export function withNav(a: CvArgs, nav: string | undefined): CvArgs {
  if (!nav) return a;
  if (a.month && /^\d{4}-\d{2}$/.test(nav)) return { ...a, month: nav };
  if (!a.month && /^\d{1,6}$/.test(nav)) return { ...a, offset: Number(nav) };
  return a;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface CvEntry { page: string; date: string }

/** Choose and order the date pages (names are full page names under `base`). */
export function selectEntries(a: CvArgs, pageNames: string[], tzOffsetHours: number): { entries: CvEntry[]; total: number } {
  const t = wikiToday(tzOffsetHours);
  const today = [String(t.y), pad(t.m), pad(t.d)].join(a.sep);
  const re = new RegExp(`^\\d{4}${escRe(a.sep)}\\d{2}${escRe(a.sep)}\\d{2}$`);
  const prefix = a.base + '/';
  let list: CvEntry[] = [];
  for (const name of pageNames) {
    if (!name.startsWith(prefix)) continue;
    const date = name.slice(prefix.length);
    if (!re.test(date)) continue;
    if (a.month && !date.startsWith(a.month.replace('-', a.sep))) continue;
    if (a.mode === 'past' && date > today) continue;
    if (a.mode === 'future' && date < today) continue;
    list.push({ page: name, date });
  }
  list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  if (a.mode === 'past') list.reverse();
  const total = list.length;
  if (!a.month) list = list.slice(a.offset, a.offset + a.pitch);
  return { entries: list, total };
}

function escRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function dateLabel(date: string, sep: string): string {
  const [y, m, d] = date.split(sep).map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${y}/${m}/${d} (${WEEK[w]})`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/**
 * Final HTML of one #calendar_viewer block. `entryHtml` is the already-rendered,
 * sanitized body of each entry page; `pageUrl` builds in-app URLs.
 */
export function renderCalendarViewer(
  a: CvArgs, index: number, sel: { entries: CvEntry[]; total: number }, entryHtml: Map<string, string>,
  urls: { page: (p: string, query?: string) => string; self: (query: string) => string },
): string {
  const out: string[] = [`<div class="cv" id="cv-${index}">`];
  // no entries: show nothing (like the classic plugin), except month navigation below
  for (const e of sel.entries) {
    out.push('<section class="cv-entry">');
    out.push(`<div class="cv-head"><a class="cv-date" data-kind="page" href="${esc(urls.page(e.page))}">${esc(dateLabel(e.date, a.sep))}</a>`
      + `<a class="cv-edit" data-kind="page" href="${esc(urls.page(e.page, 'mode=edit'))}" aria-label="${esc(dateLabel(e.date, a.sep))} を編集">編集</a></div>`);
    out.push(`<div class="cv-body">${entryHtml.get(e.page) ?? ''}</div>`);
    out.push('</section>');
  }
  // navigation (same labels as the classic plugin)
  let left = '';
  let right = '';
  if (a.month) {
    const prev = shiftMonth(a.month, -1);
    const next = shiftMonth(a.month, 1);
    left = `<a data-kind="page" href="${esc(urls.self(`cv=${index}.${prev}`))}">&lt;&lt; ${prev}</a>`;
    right = `<a data-kind="page" href="${esc(urls.self(`cv=${index}.${next}`))}">${next} &gt;&gt;</a>`;
  } else {
    if (a.offset > 0) {
      const o = Math.max(0, a.offset - a.pitch);
      left = `<a data-kind="page" href="${esc(urls.self(o === 0 ? '' : `cv=${index}.${o}`))}">&lt;&lt; 前の${a.pitch}件</a>`;
    }
    if (a.offset + a.pitch < sel.total) {
      right = `<a data-kind="page" href="${esc(urls.self(`cv=${index}.${a.offset + a.pitch}`))}">次の${a.pitch}件 &gt;&gt;</a>`;
    }
  }
  if (left || right) out.push(`<nav class="cv-nav" aria-label="日付ページの切り替え"><span>${left}</span><span>${right}</span></nav>`);
  out.push('</div>');
  return out.join('\n');
}
