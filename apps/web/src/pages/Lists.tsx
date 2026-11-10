import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { fmtDate, fmtRelative, pagePath, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';

export function RecentPage() {
  const app = useApp();
  const [space, setSpace] = useState('');
  const spaces = useApi<any[]>(`${wapi(app.wiki)}/spaces`);
  const { data } = useApi<any[]>(`${wapi(app.wiki)}/recent?limit=200${space ? `&space=${encodeURIComponent(space)}` : ''}`);
  return (
    <main className="main">
      <div className="main-narrow wide">
        <div className="page-head"><h1 className="page-title">最近の更新</h1>
          <label className="sr" htmlFor="rs">スペース</label>
          <select id="rs" className="tb-select" value={space} onChange={(e) => setSpace(e.target.value)}>
            <option value="">すべてのスペース</option>
            {(spaces.data ?? []).map((s) => <option key={s.space} value={s.space}>{s.space}</option>)}
          </select>
        </div>
        <ul className="rows panel">
          {(data ?? []).map((r) => (
            <li key={r.name}><Link to={pagePath(app.wiki, r.name)} className="ellipsis">{r.name}</Link><span className="sp">{r.space}</span><span className="tm" title={fmtDate(r.mtime)}>{fmtRelative(r.mtime)}</span></li>
          ))}
          {data && !data.length && <li className="muted">ありません</li>}
        </ul>
      </div>
    </main>
  );
}

export function AllPages() {
  const app = useApp();
  const [filter, setFilter] = useState('');
  const spaces = useApi<any[]>(`${wapi(app.wiki)}/spaces`);
  const [space, setSpace] = useState<string>('');
  const pages = useApi<any[]>(space ? `${wapi(app.wiki)}/pages?space=${encodeURIComponent(space)}` : null);
  const shown = useMemo(() => (pages.data ?? []).filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 2000), [pages.data, filter]);
  return (
    <main className="main">
      <div className="main-narrow wide">
        <h1 className="page-title">すべてのスペース・ページ</h1>
        <div className="cards spaces">
          {(spaces.data ?? []).map((s) => (
            <button key={s.space} className={`card as-button ${space === s.space ? 'selected' : ''}`} onClick={() => setSpace(s.space)} aria-pressed={space === s.space}>
              <div className="t">{s.space}</div><div className="ex">{s.pages.toLocaleString()} ページ ・ {fmtRelative(s.mtime)}</div>
            </button>
          ))}
        </div>
        {space && (
          <section className="panel">
            <h2><Icon name="folder" />{space} のページ（{pages.data?.length ?? '…'}）
              <Link to={pagePath(app.wiki, space)}>スペースを開く</Link></h2>
            <div className="panel-filter">
              <label className="sr" htmlFor="pf">絞り込み</label>
              <input id="pf" className="input" placeholder="ページ名で絞り込み" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <ul className="rows">
              {shown.map((p) => <li key={p.name}><Link to={pagePath(app.wiki, p.name)} className="ellipsis">{p.name}</Link><span className="tm">{fmtDate(p.mtime, false)}</span></li>)}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

export function FilesPage() {
  const app = useApp();
  const { data } = useApi<any[]>(`${wapi(app.wiki)}/attachments`);
  const [filter, setFilter] = useState('');
  const shown = (data ?? []).filter((a) => !filter || (a.file + a.page).toLowerCase().includes(filter.toLowerCase()));
  return (
    <main className="main">
      <div className="main-narrow wide">
        <div className="page-head"><h1 className="page-title">すべての添付</h1>
          <label className="sr" htmlFor="ff">絞り込み</label>
          <input id="ff" className="input" placeholder="ファイル名・ページ名で絞り込み" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>ファイル</th><th>ページ</th><th>サイズ</th><th>日時</th></tr></thead>
            <tbody>
              {shown.slice(0, 500).map((a) => (
                <tr key={a.page + '/' + a.file}>
                  <td><a href={`${wapi(app.wiki)}/attachments/raw?page=${encodeURIComponent(a.page)}&file=${encodeURIComponent(a.file)}`} target="_blank" rel="noopener noreferrer">{a.file}</a></td>
                  <td><Link to={pagePath(app.wiki, a.page, 'tab=attachments')}>{a.page}</Link></td>
                  <td>{a.size}</td><td>{fmtDate(a.time)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

export function OrphansPage() {
  const app = useApp();
  const { data } = useApi<any>(`${wapi(app.wiki)}/orphans`);
  const w = encodeURIComponent(app.wiki);
  return (
    <main className="main">
      <div className="main-narrow wide">
        <h1 className="page-title">未作成ページ・孤立したページ</h1>
        <div className="grid-2">
          <section className="panel">
            <h2><Icon name="unlink" />まだ作られていないページ（リンクだけある）</h2>
            <ul className="rows">
              {(data?.missing ?? []).map((m: any) => (
                <li key={m.name}><Link className="wikilink-missing ellipsis" to={`/w/${w}/new?page=${encodeURIComponent(m.name)}`}>{m.name}</Link>
                  <span className="tm" title={m.sources}>{m.refs} ページから参照</span></li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <h2><Icon name="file" />どこからもリンクされていない最上位ページ</h2>
            <ul className="rows">
              {(data?.unlinked ?? []).map((m: any) => <li key={m.name}><Link to={pagePath(app.wiki, m.name)} className="ellipsis">{m.name}</Link><span className="tm">{fmtDate(m.mtime, false)}</span></li>)}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

export function DeletedPage() {
  const app = useApp();
  const { data } = useApi<any[]>(`${wapi(app.wiki)}/deleted`);
  return (
    <main className="main">
      <div className="main-narrow wide">
        <h1 className="page-title">削除済みページ</h1>
        <p className="muted">削除されたページの内容は、ページを開いて「履歴」から確認・復元できます（PukiWiki のバックアップが残っている場合）。</p>
        <ul className="rows panel">
          {(data ?? []).map((d) => <li key={d.name}><Link to={pagePath(app.wiki, d.name, 'tab=history')} className="ellipsis">{d.name}</Link><span className="tm">{fmtDate(d.time)}</span></li>)}
          {data && !data.length && <li className="muted">ありません</li>}
        </ul>
      </div>
    </main>
  );
}
