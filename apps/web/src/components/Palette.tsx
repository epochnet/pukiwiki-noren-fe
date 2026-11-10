import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, fmtDate, pagePath, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from './Icon.tsx';

interface Item { key: string; kind: 'page' | 'body' | 'action'; title: string; titleHtml?: string; sub?: string; subHtml?: string; end?: string; run: () => void; icon: string }

export function Palette() {
  const app = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'title' | 'body' | 'space'>('all');
  const [names, setNames] = useState<any[]>([]);
  const [body, setBody] = useState<{ total: number; items: any[] }>({ total: 0, items: [] });
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const space = app.currentPage ? app.currentPage.split('/')[0] : null;
  const close = () => app.setPaletteOpen(false);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const term = q.trim();
    if (!term) { setNames([]); setBody({ total: 0, items: [] }); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (scope !== 'body') {
        api<any[]>(`${wapi(app.wiki)}/suggest?q=${encodeURIComponent(term)}&limit=6`, { signal: ctrl.signal }).then(setNames).catch(() => {});
      } else setNames([]);
      if (scope !== 'title') {
        const sp = scope === 'space' && space ? `&space=${encodeURIComponent(space)}` : '';
        api<any>(`${wapi(app.wiki)}/search?q=${encodeURIComponent(term)}&in=body&limit=5${sp}`, { signal: ctrl.signal }).then(setBody).catch(() => {});
      } else setBody({ total: 0, items: [] });
    }, 120);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, scope, app.wiki, space]);

  const go = (path: string) => { close(); nav(path); };
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const term = q.trim();
    const nameSet = new Set(names.map((n) => n.name));
    for (const n of names) out.push({ key: 'n' + n.name, kind: 'page', icon: 'file', title: n.name, sub: n.space, end: fmtDate(n.mtime, false), run: () => go(pagePath(app.wiki, n.name)) });
    for (const b of body.items) {
      if (nameSet.has(b.name)) continue;
      out.push({ key: 'b' + b.name, kind: 'body', icon: 'text', title: b.name, subHtml: b.snippet, end: fmtDate(b.mtime, false), run: () => go(pagePath(app.wiki, b.name)) });
    }
    if (term) {
      out.push({ key: 'all', kind: 'action', icon: 'search', title: `「${term}」の検索結果をすべて表示（${body.total} 件）`, run: () => go(`/w/${encodeURIComponent(app.wiki)}/search?q=${encodeURIComponent(term)}`) });
      out.push({ key: 'ai', kind: 'action', icon: 'spark', title: `AI に聞く：「${term}」`, end: 'Tab', run: () => { close(); app.openAi({ message: term, page: app.currentPage ?? undefined }); } });
      if (!/[\[\]#&<>"]/.test(term)) out.push({ key: 'new', kind: 'action', icon: 'plus', title: `新しいページ「${term}」を作成`, run: () => go(`/w/${encodeURIComponent(app.wiki)}/new?page=${encodeURIComponent(term)}`) });
    }
    return out;
  }, [names, body, q, app]);

  useEffect(() => { setSel(0); }, [items.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === 'Tab' && q.trim()) { e.preventDefault(); items.find((i) => i.key === 'ai')?.run(); }
  };

  const group = (kind: Item['kind'], label: string) => {
    const list = items.map((it, i) => ({ it, i })).filter(({ it }) => it.kind === kind);
    if (!list.length) return null;
    return (
      <div className="p-group" role="group" aria-label={label}>
        <h4>{label}</h4>
        {list.map(({ it, i }) => (
          <button key={it.key} id={`pi-${i}`} role="option" aria-selected={i === sel} className={`p-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={it.run}>
            <Icon name={it.icon} className={it.key === 'ai' ? 'ai-color' : ''} />
            <span className="p-main">
              <span className="t">{it.title}</span>
              {it.sub && <span className="sub">{it.sub}</span>}
              {it.subHtml && <span className="sub" dangerouslySetInnerHTML={{ __html: it.subHtml }} />}
            </span>
            {it.end && <span className="end">{it.end}</span>}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="検索とコマンド">
        <div className="palette-input">
          <Icon name="search" size={20} />
          <label className="sr" htmlFor="palette-q">検索語</label>
          <input id="palette-q" ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            autoComplete="off" placeholder="ページ名・本文を検索、または操作を選ぶ" role="combobox" aria-expanded={items.length > 0}
            aria-controls="palette-list" aria-activedescendant={items.length ? `pi-${sel}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div className="chips">
          {([['all', 'すべて'], ['title', 'ページ名'], ['body', '本文'], ...(space ? [['space', `このスペース（${space}）`]] : [])] as [typeof scope, string][]).map(([k, l]) => (
            <button key={k} className={`chip ${scope === k ? 'on' : ''}`} aria-pressed={scope === k} onClick={() => setScope(k)}>{l}</button>
          ))}
        </div>
        <div id="palette-list" role="listbox" aria-label="候補" className="palette-list">
          {!q.trim() && <p className="palette-hint">ページ名の一部や本文の言葉を入力してください。<kbd>Tab</kbd> で AI に聞けます。</p>}
          {group('page', 'ページ')}
          {group('body', '本文')}
          {group('action', '操作')}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 移動</span><span><kbd>Enter</kbd> 開く</span><span><kbd>Tab</kbd> AI に聞く</span><span><kbd>Esc</kbd> 閉じる</span></div>
      </div>
    </div>
  );
}
