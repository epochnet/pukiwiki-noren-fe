import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { fmtDate, pagePath, qs, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';

export function SearchPage() {
  const app = useApp();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const space = sp.get('space') ?? '';
  const mode = sp.get('mode') ?? 'and';
  const scope = sp.get('in') ?? 'all';
  const offset = Number(sp.get('offset') ?? 0);
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const spaces = useApi<any[]>(`${wapi(app.wiki)}/spaces`);
  const { data, loading, error } = useApi<any>(q ? `${wapi(app.wiki)}/search?${qs({ q, space, mode, in: scope, offset, limit: 30 })}` : null);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (!('offset' in patch)) next.delete('offset');
    setSp(next);
  };
  return (
    <main className="main">
      <div className="main-narrow wide">
        <form className="search-form" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: input.trim() }); }}>
          <label className="sr" htmlFor="sq">検索語</label>
          <input id="sq" className="input big" value={input} onChange={(e) => setInput(e.target.value)} placeholder="検索語（スペース区切りで複数）" />
          <button className="btn primary"><Icon name="search" />検索</button>
        </form>
        <div className="filters">
          <div className="seg" role="group" aria-label="検索対象">
            {[['all', 'すべて'], ['title', 'ページ名'], ['body', '本文']].map(([k, l]) => <button key={k} className={scope === k ? 'on' : ''} aria-pressed={scope === k} onClick={() => set({ in: k === 'all' ? '' : k })}>{l}</button>)}
          </div>
          <div className="seg" role="group" aria-label="複数語の扱い">
            {[['and', 'すべて含む'], ['or', 'いずれか']].map(([k, l]) => <button key={k} className={mode === k ? 'on' : ''} aria-pressed={mode === k} onClick={() => set({ mode: k === 'and' ? '' : k })}>{l}</button>)}
          </div>
          <label className="sr" htmlFor="sspace">スペース</label>
          <select id="sspace" className="tb-select" value={space} onChange={(e) => set({ space: e.target.value })}>
            <option value="">すべてのスペース</option>
            {(spaces.data ?? []).map((s) => <option key={s.space} value={s.space}>{s.space}（{s.pages}）</option>)}
          </select>
        </div>
        {q && <h1 className="search-title">「{q}」の検索結果 {data ? <span className="muted">{data.total.toLocaleString()} 件</span> : null}</h1>}
        {error && <p className="notice error">{error.message}</p>}
        {loading && <div className="skeleton" />}
        {data && (
          <ul className="search-results">
            {data.items.map((it: any) => (
              <li key={it.name}>
                <Link to={pagePath(app.wiki, it.name)} className="sr-title" dangerouslySetInnerHTML={{ __html: it.nameHtml }} />
                <div className="sr-meta"><span>{it.space}</span><span>{fmtDate(it.mtime, false)}</span></div>
                <p className="sr-snippet" dangerouslySetInnerHTML={{ __html: it.snippet }} />
              </li>
            ))}
            {!data.items.length && <li className="muted">見つかりませんでした。言葉を変えるか、<button className="linklike" onClick={() => app.openAi({ message: q })}>AI に聞いてみる</button>。</li>}
          </ul>
        )}
        {data && data.total > 30 && (
          <div className="pager">
            <button className="btn" disabled={offset === 0} onClick={() => set({ offset: String(Math.max(0, offset - 30)) })}><Icon name="left" />前へ</button>
            <span>{offset + 1}–{Math.min(offset + 30, data.total)} / {data.total}</span>
            <button className="btn" disabled={offset + 30 >= data.total} onClick={() => set({ offset: String(offset + 30) })}>次へ<Icon name="right" /></button>
          </div>
        )}
        {!q && <p className="muted">検索語を入力してください。<kbd>Ctrl</kbd>+<kbd>K</kbd> でどこからでも検索できます。</p>}
      </div>
    </main>
  );
}
