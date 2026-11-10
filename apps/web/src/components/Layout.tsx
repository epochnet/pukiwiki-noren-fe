import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { api, useApi, wapi } from '../api.ts';
import { AppProvider, useApp } from '../context.tsx';
import { Icon } from './Icon.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Palette } from './Palette.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { Resizer } from './Resizer.tsx';

export function Layout() {
  const { wiki = '' } = useParams();
  const me = useApi<{ user: string }>('/api/me');
  const caps = useApi<any>(`${wapi(wiki)}/capabilities`);
  const wikis = useApi<any[]>('/api/wikis');
  if (me.error || wikis.error) {
    return <main className="main"><h1>接続できません</h1><p>{(me.error ?? wikis.error)?.message}</p></main>;
  }
  if (wikis.data && !wikis.data.some((w) => w.id === wiki)) {
    return <main className="main"><h1>Wiki「{wiki}」は登録されていません</h1><p><Link to="/">トップへ</Link></p></main>;
  }
  return (
    <AppProvider wiki={wiki} me={me.data?.user ?? ''} caps={caps.data}>
      <Shell wikis={wikis.data ?? []} />
    </AppProvider>
  );
}

function Shell({ wikis }: { wikis: any[] }) {
  const app = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const wikiLabel = wikis.find((w) => w.id === app.wiki)?.label ?? app.wiki;

  useEffect(() => { setNavOpen(false); }, [loc.pathname]);
  // editing: hide the page tree so the editor can use the full width
  useEffect(() => {
    const editing = new URLSearchParams(loc.search).get('mode') === 'edit';
    document.body.classList.toggle('editing', editing);
    return () => document.body.classList.remove('editing');
  }, [loc.search]);
  useEffect(() => { document.body.classList.toggle('nav-open', navOpen); }, [navOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); app.setPaletteOpen(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [app]);
  useEffect(() => { document.title = wikiLabel; }, [wikiLabel]);

  const toggleTheme = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('noren-theme', root.dataset.theme); } catch { /* ignore */ }
  };

  const newHref = `/w/${encodeURIComponent(app.wiki)}/new${app.currentPage ? `?parent=${encodeURIComponent(app.currentPage.includes('/') ? app.currentPage.slice(0, app.currentPage.lastIndexOf('/')) : app.currentPage)}` : ''}`;
  return (
    <>
      <a className="skip-link" href="#main">本文へ移動</a>
      <header className="topbar">
        <button className="icon-btn menu-toggle" aria-label="メニューを開く" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}><Icon name="menu" /></button>
        <Link className="brand" to={`/w/${encodeURIComponent(app.wiki)}`}><span className="brand-mark" aria-hidden="true">W</span><span className="hide-sm">{wikiLabel}</span></Link>
        {wikis.length > 1 && (
          <select className="tb-select hide-sm" aria-label="Wiki を切り替える" value={app.wiki} onChange={(e) => nav(`/w/${encodeURIComponent(e.target.value)}`)}>
            {wikis.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        )}
        <button className="searchbox" onClick={() => app.setPaletteOpen(true)}><Icon name="search" /><span>ページや本文を検索…</span><kbd>Ctrl K</kbd></button>
        <div className="top-actions">
          <Link className="btn primary" to={newHref}><Icon name="plus" /><span className="hide-sm">作成</span></Link>
          <button className={`btn ${app.aiOpen ? 'ai-solid' : 'ai'}`} onClick={() => (app.aiOpen ? app.closeAi() : app.openAi({ page: app.currentPage ?? undefined }))} aria-pressed={app.aiOpen}><Icon name="spark" />AI</button>
          <button className="icon-btn" onClick={toggleTheme} aria-label="テーマを切り替える"><Icon name="moon" /></button>
          <UserMenu />
        </div>
      </header>
      <div className="layout">
        <Sidebar />
        <Resizer name="sidebar" target=".sidebar" edge="right" className="rz-sidebar" />
        <div id="main" className="layout-main" tabIndex={-1}>
          <Outlet />
        </div>
        {app.aiOpen && <Resizer name="ai" target=".ai-panel" edge="left" className="rz-ai" />}
        {app.aiOpen && <AgentPanel />}
      </div>
      {app.paletteOpen && <Palette />}
      <div className="toasts" role="status" aria-live="polite">
        {app.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </>
  );
}

function UserMenu() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const initial = (app.me && app.me !== 'anonymous' ? app.me : '?').slice(0, 1).toUpperCase();
  return (
    <div className="menu-wrap">
      <button className="avatar" aria-label={`アカウント: ${app.me || '匿名'}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{initial}</button>
      {open && (
        <div className="menu" role="menu" onClick={() => setOpen(false)}>
          <div className="menu-head">{app.me && app.me !== 'anonymous' ? app.me : '匿名で利用中'}</div>
          <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/recent`}>最近の更新</Link>
          <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/pages`}>すべてのページ</Link>
          <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/files`}>すべての添付</Link>
          <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/orphans`}>未作成ページ</Link>
          <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/deleted`}>削除済みページ</Link>
          <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/admin`}>管理・同期状態</Link>
        </div>
      )}
    </div>
  );
}

/** Generic modal dialog. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head"><h2>{title}</h2><button className="icon-btn" aria-label="閉じる" onClick={onClose}><Icon name="x" /></button></div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

export async function relayForm(wiki: string, form: HTMLFormElement, page: string, submitter?: HTMLElement | null) {
  const fd = new FormData(form, submitter as any);
  const fields: Record<string, string> = {};
  fd.forEach((v, k) => { if (typeof v === 'string') fields[k] = v; });
  return api(`${wapi(wiki)}/forms`, { body: { action: form.dataset.pkwkAction ?? './', page, fields } });
}
