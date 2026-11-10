import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { pagePath, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';
import { Crumbs } from './PageRoute.tsx';

const p2 = (n: number) => String(n).padStart(2, '0');

export function CalendarPage() {
  const app = useApp();
  const nav = useNavigate();
  const prefix = (useParams()['*'] ?? '').replace(/\/+$/, '');
  const [sp, setSp] = useSearchParams();
  const now = new Date();
  const ym = sp.get('ym') ?? `${now.getFullYear()}-${p2(now.getMonth() + 1)}`;
  const [y, m] = ym.split('-').map(Number);
  const { data } = useApi<any[]>(prefix ? `${wapi(app.wiki)}/calendar?prefix=${encodeURIComponent(prefix)}&ym=${ym}` : null);
  const byDay = new Map((data ?? []).map((r) => [r.name.slice(-10), r]));
  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay();
  const days = new Date(y, m, 0).getDate();
  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < Math.ceil((startDow + days) / 7) * 7; i++) {
    const d = new Date(y, m - 1, 1 - startDow + i);
    cells.push({ date: d, inMonth: d.getMonth() === m - 1 });
  }
  const shift = (n: number) => {
    const d = new Date(y, m - 1 + n, 1);
    setSp({ ym: `${d.getFullYear()}-${p2(d.getMonth() + 1)}` });
  };
  const todayKey = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  if (!prefix) return <main className="main"><p>階層を指定してください。</p></main>;
  return (
    <main className="main">
      <div className="main-narrow wide">
        <Crumbs page={prefix} wiki={app.wiki} />
        <div className="page-head center">
          <h1 className="page-title"><Link to={pagePath(app.wiki, prefix)}>{prefix}</Link> のカレンダー</h1>
          <div className="cal-nav">
            <button className="icon-btn" aria-label="前の月" onClick={() => shift(-1)}><Icon name="left" /></button>
            <strong>{y} 年 {m} 月</strong>
            <button className="icon-btn" aria-label="次の月" onClick={() => shift(1)}><Icon name="right" /></button>
            <button className="btn sm" onClick={() => setSp({})}>今月</button>
          </div>
        </div>
        <p className="muted small">「{prefix}/YYYY-MM-DD」のページを月ごとに表示しています。空いている日の「＋ 書く」で、その日のページを作ります。</p>
        <div className="cal" role="grid" aria-label={`${y} 年 ${m} 月`}>
          {['日', '月', '火', '水', '木', '金', '土'].map((d, i) => <div key={d} className={`dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}`} role="columnheader">{d}</div>)}
          {cells.map(({ date, inMonth }) => {
            const key = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
            const entry = inMonth ? byDay.get(key) : undefined;
            const dow = date.getDay();
            return (
              <div key={key} role="gridcell" className={`${inMonth ? '' : 'out'} ${key === todayKey ? 'today' : ''}`}>
                <span className={`d ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}`}>{inMonth ? date.getDate() : `${date.getMonth() + 1}/${date.getDate()}`}</span>
                {entry && <Link className="entry" to={pagePath(app.wiki, entry.name)} title={entry.excerpt}>{entry.excerpt || '（本文なし）'}</Link>}
                {!entry && inMonth && date <= now && (
                  <button className="new linklike" onClick={() => nav(pagePath(app.wiki, `${prefix}/${key}`, 'mode=edit'))}>＋ 書く</button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
