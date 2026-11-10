import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, pagePath, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';

const INVALID = /[\[\]#&<>"]|^\s|\s$|\/\/|^\/|\/$/;

export function NewPage() {
  const app = useApp();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const initial = sp.get('page') ?? '';
  const [parent, setParent] = useState(sp.get('parent') ?? (initial.includes('/') ? initial.slice(0, initial.lastIndexOf('/')) : ''));
  const [name, setName] = useState(initial.includes('/') ? initial.slice(initial.lastIndexOf('/') + 1) : initial);
  const [template, setTemplate] = useState(sp.get('template') ?? '');
  const [exists, setExists] = useState<boolean | null>(null);
  const [tplSugg, setTplSugg] = useState<any[]>([]);
  const full = [parent.trim().replace(/\/+$/, ''), name.trim()].filter(Boolean).join('/');

  useEffect(() => {
    if (!full || INVALID.test(full)) { setExists(null); return; }
    const t = setTimeout(() => api<any>(`${wapi(app.wiki)}/page/source?p=${encodeURIComponent(full)}`).then((r) => setExists(r.exists)).catch(() => setExists(null)), 250);
    return () => clearTimeout(t);
  }, [full, app.wiki]);
  useEffect(() => {
    api<any[]>(`${wapi(app.wiki)}/suggest?q=${encodeURIComponent('テンプレート')}&limit=10`).then(setTplSugg).catch(() => {});
  }, [app.wiki]);

  const invalid = full && INVALID.test(full);
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    if (!full || invalid) return;
    if (exists) { nav(pagePath(app.wiki, full)); return; }
    nav(pagePath(app.wiki, full, `mode=edit${template ? `&template=${encodeURIComponent(template)}` : ''}`));
  };
  return (
    <main className="main">
      <div className="main-narrow narrow-form">
        <h1 className="page-title">新しいページ</h1>
        <form className="form" onSubmit={go}>
          <label>親ページ（階層）
            <input className="input" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="例: 保守/手順書（空欄なら最上位）" list="parent-sugg" />
          </label>
          <ParentSuggest q={parent} />
          <label>ページ名
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required placeholder="例: メールサーバー設定" />
          </label>
          <p className="muted small">作成されるページ: <strong>{full || '—'}</strong>
            {exists && <span className="badge warn">既に存在します（開きます）</span>}
            {invalid && <span className="badge warn">使えない文字が含まれています（[ ] # &amp; &lt; &gt; " や先頭・末尾の空白・/）</span>}
          </p>
          <label>テンプレート（任意）
            <input className="input" value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="内容を複製するページ名" list="tpl-sugg" />
          </label>
          <datalist id="tpl-sugg">{tplSugg.map((s) => <option key={s.name} value={s.name} />)}</datalist>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => nav(-1)}>キャンセル</button>
            <button className="btn primary" disabled={!full || !!invalid}><Icon name={exists ? 'right' : 'edit'} />{exists ? 'ページを開く' : '作成して編集'}</button>
          </div>
        </form>
      </div>
    </main>
  );
}

function ParentSuggest({ q }: { q: string }) {
  const app = useApp();
  const [s, setS] = useState<any[]>([]);
  useEffect(() => {
    if (!q) { setS([]); return; }
    const t = setTimeout(() => api<any[]>(`${wapi(app.wiki)}/suggest?q=${encodeURIComponent(q)}&limit=8`).then(setS).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [q, app.wiki]);
  return <datalist id="parent-sugg">{s.map((x) => <option key={x.name} value={x.name} />)}</datalist>;
}
