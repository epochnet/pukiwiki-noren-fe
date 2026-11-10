// Calendar shown in place of #calendar2 inside the MenuBar. As in the classic UI,
// it belongs to the page being viewed: days link to "<page>/YYYY-MM-DD", and days
// without a page link to the new-page form so a dated child page can be created.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, pagePath, wapi } from '../api.ts';
import { useApp } from '../context.tsx';

const DATE_LEAF = /^(.*)\/(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** The page the calendar belongs to. On a date page, its parent (so the calendar keeps working while browsing entries). */
export function calendarBase(current: string | null): { base: string | null; ym: string | null; day: string | null } {
  if (!current) return { base: null, ym: null, day: null };
  const m = DATE_LEAF.exec(current);
  if (m) return { base: m[1], ym: `${m[2]}-${m[3]}`, day: `${m[2]}-${m[3]}-${m[4]}` };
  return { base: current, ym: null, day: null };
}

export function MenuCalendar() {
  const app = useApp();
  const { base, ym: pageYm, day: pageDay } = calendarBase(app.currentPage);
  const now = new Date();
  const todayYm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const today = `${todayYm}-${pad(now.getDate())}`;
  const [ym, setYm] = useState(pageYm ?? todayYm);
  const [exists, setExists] = useState<Set<string>>(new Set());

  // follow the page being viewed
  useEffect(() => { setYm(pageYm ?? todayYm); }, [base, pageYm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!base) { setExists(new Set()); return; }
    let alive = true;
    api<{ name: string }[]>(`${wapi(app.wiki)}/tree?parent=${encodeURIComponent(base)}`)
      .then((rows) => {
        if (!alive) return;
        const s = new Set<string>();
        for (const r of rows) { const m = DATE_LEAF.exec(r.name); if (m && m[1] === base) s.add(`${m[2]}-${m[3]}-${m[4]}`); }
        setExists(s);
      })
      .catch(() => { if (alive) setExists(new Set()); });
    return () => { alive = false; };
  }, [app.wiki, base, app.treeVersion]);

  const weeks = useMemo(() => {
    const [y, m] = ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1).getDay();
    const days = new Date(y, m, 0).getDate();
    const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
    while (cells.length % 7) cells.push(null);
    const rows: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [ym]);

  const shift = (d: number) => {
    const [y, m] = ym.split('-').map(Number);
    const t = new Date(y, m - 1 + d, 1);
    setYm(`${t.getFullYear()}-${pad(t.getMonth() + 1)}`);
  };
  const [y, m] = ym.split('-');
  const w = encodeURIComponent(app.wiki);

  return (
    <div className="mb-cal">
      <div className="mb-cal-head">
        <button type="button" className="linklike" onClick={() => shift(-1)} aria-label="前の月">&lt;&lt;</button>
        <strong>{y}.{m}</strong>
        <button type="button" className="linklike" onClick={() => shift(1)} aria-label="次の月">&gt;&gt;</button>
      </div>
      <div className="mb-cal-base">
        {base ? <>[<Link to={pagePath(app.wiki, base)}>{base}</Link>]</> : <span className="muted">ページを開くと日付ページを作れます</span>}
      </div>
      <table aria-label={`${y}年${Number(m)}月${base ? `（${base} の日付ページ）` : ''}`}>
        <thead><tr>{WEEK.map((d, i) => <th key={d} className={i === 0 ? 'sun' : i === 6 ? 'sat' : ''}>{d}</th>)}</tr></thead>
        <tbody>
          {weeks.map((row, ri) => (
            <tr key={ri}>
              {row.map((d, i) => {
                if (!d) return <td key={i} />;
                const date = `${ym}-${pad(d)}`;
                const cls = [i === 0 ? 'sun' : i === 6 ? 'sat' : '', date === today ? 'today' : '', date === pageDay ? 'current' : ''].join(' ').trim();
                if (!base) return <td key={i} className={cls}>{d}</td>;
                const page = `${base}/${date}`;
                return (
                  <td key={i} className={cls}>
                    {exists.has(date)
                      ? <Link className="has" to={pagePath(app.wiki, page)} title={page}>{d}</Link>
                      : <Link className="wikilink-missing" to={`/w/${w}/new?page=${encodeURIComponent(page)}`} title={`${page} を作成`}>{d}</Link>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
