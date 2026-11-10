import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fmtRelative, local, pagePath, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function Dashboard() {
  const app = useApp();
  const nav = useNavigate();
  const { data, error } = useApi<any>(`${wapi(app.wiki)}/dashboard`);
  const recentViews = local.get<string[]>(`noren:recent:${app.wiki}`, []).slice(0, 6);
  const favs = local.get<string[]>(`noren:fav:${app.wiki}`, []).slice(0, 6);
  const [dailyPrefix, setDailyPrefix] = useState(() => local.get<string>(`noren:daily:${app.wiki}`, ''));
  const [prefixInput, setPrefixInput] = useState('');
  const w = encodeURIComponent(app.wiki);
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'お疲れさまです';
  const who = app.me && app.me !== 'anonymous' ? `、${app.me.replace(/@.*$/, '')} さん` : '';

  if (error) return <main className="main"><p className="notice error">{error.message}</p></main>;
  const syncing = data?.sync?.running === 'full' && data.sync.progress;
  return (
    <main className="main dashboard">
      <div className="page-head center">
        <h1 className="page-title">{greet}{who}</h1>
        {dailyPrefix ? (
          <button className="btn primary" onClick={() => nav(pagePath(app.wiki, `${dailyPrefix}/${today()}`, 'mode=edit'))}>
            <Icon name="cal" />今日の日報を書く（{dailyPrefix}/{today()}）
          </button>
        ) : (
          <form className="field-row inline-form" onSubmit={(e) => { e.preventDefault(); if (prefixInput.trim()) { local.set(`noren:daily:${app.wiki}`, prefixInput.trim()); setDailyPrefix(prefixInput.trim()); } }}>
            <label className="sr" htmlFor="dp">日報を書く階層</label>
            <input id="dp" className="input" placeholder="日報の階層名（例: 山田）" value={prefixInput} onChange={(e) => setPrefixInput(e.target.value)} />
            <button className="btn">日報ボタンを設定</button>
          </form>
        )}
      </div>
      <p className="muted lead">
        {data ? `${data.pages.toLocaleString()} ページ ・ ${data.spaceCount} スペース` : '読み込み中…'}
        {data?.sync?.lastIncremental ? ` ・ 最終同期 ${fmtRelative(data.sync.lastIncremental)}` : ''}
      </p>
      {syncing && (
        <p className="notice" role="status">索引を作成しています（{data.sync.progress.done.toLocaleString()} / {data.sync.progress.total.toLocaleString()} ページ）。完了するまで検索結果やツリーが一部欠けることがあります。
          <progress max={data.sync.progress.total} value={data.sync.progress.done} /></p>
      )}

      <h2 className="section-title">スペース</h2>
      <div className="cards spaces">
        {(data?.spaces ?? []).map((s: any) => (
          <Link key={s.space} className="card" to={pagePath(app.wiki, s.space)}>
            <div className="t">{s.space}</div>
            <div className="ex">{s.pages.toLocaleString()} ページ{s.week ? ` ・ 今週 ${s.week} 件更新` : ''}</div>
          </Link>
        ))}
        <Link className="card" to={`/w/${w}/pages`}><div className="t"><Icon name="grid" /> すべてのスペース</div><div className="ex">{data?.spaceCount ?? '—'} スペース</div></Link>
      </div>

      <div className="grid-2">
        <section className="panel" aria-labelledby="h-recent">
          <h2 id="h-recent"><Icon name="clock" />最近の更新<Link to={`/w/${w}/recent`}>すべて</Link></h2>
          <ul className="rows">
            {(data?.recent ?? []).map((r: any) => (
              <li key={r.name}><Link to={pagePath(app.wiki, r.name)} className="ellipsis">{r.name}</Link><span className="tm">{fmtRelative(r.mtime)}</span></li>
            ))}
            {data && !data.recent.length && <li className="muted">まだありません</li>}
          </ul>
        </section>
        <section className="panel" aria-labelledby="h-mine">
          <h2 id="h-mine"><Icon name="star" />お気に入りと最近見たページ</h2>
          <ul className="rows">
            {favs.map((p) => <li key={'f' + p}><Link to={pagePath(app.wiki, p)} className="ellipsis">{p}</Link><span className="tm">お気に入り</span></li>)}
            {recentViews.filter((p) => !favs.includes(p)).map((p) => <li key={'r' + p}><Link to={pagePath(app.wiki, p)} className="ellipsis">{p}</Link><span className="tm">最近見た</span></li>)}
            {!favs.length && !recentViews.length && <li className="muted">ページを開くと、ここに表示されます。ページ上部の星でお気に入りに追加できます。</li>}
          </ul>
        </section>
        <section className="panel" aria-labelledby="h-yet">
          <h2 id="h-yet"><Icon name="unlink" />まだ作られていないページ<Link to={`/w/${w}/orphans`}>すべて</Link></h2>
          <ul className="rows">
            {(data?.missing ?? []).map((m: any) => (
              <li key={m.name}><Link className="wikilink-missing ellipsis" to={`/w/${w}/new?page=${encodeURIComponent(m.name)}`}>{m.name}</Link><span className="tm">{m.refs} ページから参照</span></li>
            ))}
            {data && !data.missing.length && <li className="muted">ありません</li>}
          </ul>
        </section>
        <section className="panel" aria-labelledby="h-old">
          <h2 id="h-old"><Icon name="history" />1 年以上更新されていないページ</h2>
          <ul className="rows">
            {(data?.stale ?? []).map((r: any) => (
              <li key={r.name}><Link to={pagePath(app.wiki, r.name)} className="ellipsis">{r.name}</Link><span className="tm">{fmtRelative(r.mtime)}</span></li>
            ))}
            {data && !data.stale.length && <li className="muted">ありません</li>}
          </ul>
        </section>
      </div>
    </main>
  );
}
