import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError, fmtDate, fmtRelative, leaf, local, pagePath, pushRecentView, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal, relayForm } from '../components/Layout.tsx';
import { EditorPage } from './EditorPage.tsx';
import { Resizer } from '../components/Resizer.tsx';
import { HistoryTab } from './HistoryTab.tsx';
import { AttachmentsTab } from './AttachmentsTab.tsx';

export function PageRoute() {
  const params = useParams();
  const page = (params['*'] ?? '').replace(/\/+$/, '');
  const [sp] = useSearchParams();
  const app = useApp();
  useEffect(() => { app.setCurrentPage(page || null); return () => app.setCurrentPage(null); }, [page]); // eslint-disable-line
  if (!page) return <main className="main"><p>ページ名がありません</p></main>;
  if (sp.get('mode') === 'edit') return <EditorPage key={page} page={page} />;
  return <PageView key={page} page={page} tab={sp.get('tab') ?? 'body'} />;
}

export function Crumbs({ page, wiki }: { page: string; wiki: string }) {
  const parts = page.split('/');
  return (
    <nav className="crumbs" aria-label="パンくず">
      {parts.map((p, i) => {
        const full = parts.slice(0, i + 1).join('/');
        return (
          <span key={full} className="crumb">
            {i > 0 && <span aria-hidden="true">/</span>}
            {i < parts.length - 1 ? <Link to={pagePath(wiki, full)}>{p}</Link> : <span>{p}</span>}
          </span>
        );
      })}
    </nav>
  );
}

function PageView({ page, tab }: { page: string; tab: string }) {
  const app = useApp();
  const nav = useNavigate();
  const [search] = useSearchParams();
  const cv = search.get('cv'); // #calendar_viewer paging (e.g. "0.5")
  const { data, error, loading, reload } = useApi<any>(`${wapi(app.wiki)}/page?p=${encodeURIComponent(page)}${cv ? `&cv=${encodeURIComponent(cv)}` : ''}`);
  const related = useApi<any>(data?.exists ? `${wapi(app.wiki)}/page/related?p=${encodeURIComponent(page)}` : null);
  const [dialog, setDialog] = useState<null | 'rename' | 'freeze' | 'delete' | 'more'>(null);
  const [fav, setFav] = useState(() => local.get<string[]>(`noren:fav:${app.wiki}`, []).includes(page));
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeToc, setActiveToc] = useState<string | null>(null);

  useEffect(() => { if (data?.exists) pushRecentView(app.wiki, page); }, [data?.exists, app.wiki, page]);
  useEffect(() => { if (data?.exists) document.title = `${leaf(page)} - ${document.title.split(' - ').pop()}`; }, [data, page]);

  // intercept internal links and relay PukiWiki plugin forms
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('/w/')) { e.preventDefault(); nav(href); }
    };
    const onSubmit = async (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      if (!form.dataset.pkwkForm) return;
      e.preventDefault();
      const btns = form.querySelectorAll('button, input[type=submit]');
      btns.forEach((b) => b.setAttribute('disabled', ''));
      try {
        const r = await relayForm(app.wiki, form, page, e.submitter);
        if (r.external) { window.open(r.external, '_blank', 'noopener'); return; }
        app.toast('送信しました');
        if (r.page && r.page !== page) nav(pagePath(app.wiki, r.page)); else reload();
      } catch (err) {
        app.toast((err as Error).message, 'error');
      } finally {
        btns.forEach((b) => b.removeAttribute('disabled'));
      }
    };
    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    return () => { el.removeEventListener('click', onClick); el.removeEventListener('submit', onSubmit); };
  }, [data, app, page, nav, reload]);

  // syntax highlighting for code inside Markdown blocks (loaded only when needed)
  useEffect(() => {
    const codes = contentRef.current?.querySelectorAll<HTMLElement>('.markdown-body pre code');
    if (!codes?.length) return;
    let alive = true;
    import('highlight.js/lib/common').then(({ default: hljs }) => {
      if (alive) codes.forEach((c) => { if (!c.dataset.highlighted) hljs.highlightElement(c); });
    }).catch(() => {});
    return () => { alive = false; };
  }, [data, tab]);

  // scroll to #anchor after render, and track the active heading for the TOC
  useEffect(() => {
    if (!data?.exists || tab !== 'body') return;
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
    const heads = contentRef.current?.querySelectorAll('h2[id], h3[id], h4[id]');
    if (!heads?.length) return;
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActiveToc(vis.target.id);
    }, { rootMargin: '-60px 0px -70% 0px' });
    heads.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [data, tab]);

  const toggleFav = () => {
    const k = `noren:fav:${app.wiki}`;
    const list = local.get<string[]>(k, []);
    const next = list.includes(page) ? list.filter((p) => p !== page) : [page, ...list].slice(0, 30);
    local.set(k, next);
    setFav(next.includes(page));
  };

  if (error) return <main className="main"><Crumbs page={page} wiki={app.wiki} /><h1>読み込めませんでした</h1><p className="notice error">{error.message}</p><button className="btn" onClick={reload}>再読み込み</button></main>;
  if (loading && !data) return <main className="main" aria-busy="true"><Crumbs page={page} wiki={app.wiki} /><div className="skeleton title" /><div className="skeleton" /><div className="skeleton" /></main>;
  if (!data) return null;

  if (!data.exists) {
    return (
      <main className="main">
        <div className="main-narrow">
          <Crumbs page={page} wiki={app.wiki} />
          <h1 className="page-title">{leaf(page)}</h1>
          <p className="notice">このページはまだありません。</p>
          <Link className="btn primary" to={pagePath(app.wiki, page, 'mode=edit')}><Icon name="plus" />このページを作成</Link>
          {data.children > 0 && <ChildList page={page} />}
        </div>
      </main>
    );
  }

  const tabHref = (t: string) => pagePath(app.wiki, page, t === 'body' ? '' : `tab=${t}`);
  const rel = related.data;
  return (
    <>
      <main className="main">
        <div className="main-narrow">
          <Resizer name="content" target=".main .main-narrow" edge="left" factor={2} className="rz-content rz-content-left" />
          <Resizer name="content" target=".main .main-narrow" edge="right" factor={2} className="rz-content" />
          <Crumbs page={page} wiki={app.wiki} />
          <div className="page-head">
            <h1 className="page-title">{leaf(page)}{data.frozen && <span className="badge" title="凍結中"><Icon name="lock" />凍結</span>}</h1>
            <Link className="btn primary" to={pagePath(app.wiki, page, 'mode=edit')}><Icon name={data.frozen ? 'lock' : 'edit'} />{data.frozen ? '凍結中（表示）' : '編集'}</Link>
            <button className="btn ai" onClick={() => app.openAi({ page })}><Icon name="spark" />AI に聞く</button>
            <button className={`icon-btn ${fav ? 'fav-on' : ''}`} aria-pressed={fav} aria-label={fav ? 'お気に入りから外す' : 'お気に入りに追加'} onClick={toggleFav}><Icon name="star" /></button>
            <div className="menu-wrap">
              <button className="icon-btn" aria-label="その他の操作" aria-expanded={dialog === 'more'} onClick={() => setDialog(dialog === 'more' ? null : 'more')}><Icon name="more" /></button>
              {dialog === 'more' && (
                <div className="menu right" role="menu" onClick={() => setDialog(null)}>
                  <Link role="menuitem" to={tabHref('history')}><Icon name="history" />履歴・差分</Link>
                  <Link role="menuitem" to={tabHref('attachments')}><Icon name="clip" />添付ファイル</Link>
                  <Link role="menuitem" to={tabHref('source')}><Icon name="code" />元テキスト</Link>
                  <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/new?parent=${encodeURIComponent(page)}`}><Icon name="plus" />子ページを作成</Link>
                  <Link role="menuitem" to={`/w/${encodeURIComponent(app.wiki)}/new?template=${encodeURIComponent(page)}&parent=${encodeURIComponent(page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : '')}`}><Icon name="copy" />このページを複製</Link>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); setDialog('rename'); }}><Icon name="edit" />名前を変更</button>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); setDialog('freeze'); }}><Icon name={data.frozen ? 'unlock' : 'lock'} />{data.frozen ? '凍結を解除' : '凍結'}</button>
                  <button role="menuitem" onClick={(e) => { e.stopPropagation(); setDialog('delete'); }}><Icon name="trash" />削除</button>
                  <button role="menuitem" onClick={() => { navigator.clipboard?.writeText(location.origin + pagePath(app.wiki, page)); app.toast('リンクをコピーしました'); }}><Icon name="link" />リンクをコピー</button>
                  <a role="menuitem" href={data.classicUrl} target="_blank" rel="noopener noreferrer"><Icon name="ext" />旧 UI で開く</a>
                </div>
              )}
            </div>
          </div>
          <div className="page-meta">
            <span title={fmtDate(data.mtime)}><Icon name="clock" />最終更新 {fmtRelative(data.mtime)}</span>
            <span><Link to={tabHref('history')}><Icon name="history" />履歴</Link></span>
            <span><Link to={tabHref('attachments')}><Icon name="clip" />添付 {data.attachments.length}</Link></span>
            <span className="muted ellipsis" title={page}>{page}</span>
          </div>
          <nav className="tabs" aria-label="ページの表示切り替え">
            {[['body', '本文'], ['history', '履歴'], ['attachments', `添付（${data.attachments.length}）`], ['source', '元テキスト']].map(([t, l]) => (
              <Link key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} to={tabHref(t)}>{l}</Link>
            ))}
          </nav>

          {tab === 'body' && (
            <>
              <article className="content" ref={contentRef} dangerouslySetInnerHTML={{ __html: data.html }} />
              {data.children > 0 && <ChildList page={page} />}
              <section className="related" aria-label="関連ページ">
                {rel?.backlinks?.length > 0 && (
                  <>
                    <h2>このページへのリンク（{rel.backlinks.length}）</h2>
                    <div className="cards">{rel.backlinks.slice(0, 12).map((b: any) => <PageCard key={b.name} p={b} />)}</div>
                  </>
                )}
                {rel?.twoHop?.length > 0 && (
                  <>
                    <h2>リンクでつながるページ</h2>
                    <div className="cards">{rel.twoHop.map((b: any) => <PageCard key={b.name} p={b} via={b.via} />)}</div>
                  </>
                )}
                {rel && (rel.siblings.prev || rel.siblings.next) && (
                  <div className="sibling-nav">
                    {rel.siblings.prev ? <Link className="btn" to={pagePath(app.wiki, rel.siblings.prev.name)}><Icon name="left" />{leaf(rel.siblings.prev.name)}</Link> : <span />}
                    {rel.siblings.next ? <Link className="btn" to={pagePath(app.wiki, rel.siblings.next.name)}>{leaf(rel.siblings.next.name)}<Icon name="right" /></Link> : <span />}
                  </div>
                )}
              </section>
            </>
          )}
          {tab === 'history' && <HistoryTab page={page} onRestored={reload} />}
          {tab === 'attachments' && <AttachmentsTab page={page} onChange={reload} />}
          {tab === 'source' && <SourceTab page={page} />}
        </div>
      </main>
      {tab === 'body' && <Resizer name="rail" target=".rail" edge="left" className="rz-rail" />}
      {tab === 'body' && (
        <aside className="rail" aria-label="目次とページ情報">
          {data.toc.length > 0 && (
            <section>
              <h3>目次</h3>
              <ul className="toc">
                {data.toc.map((t: any) => (
                  <li key={t.id}><a className={`l${t.level} ${activeToc === t.id ? 'on' : ''}`} href={`#${t.id}`}>{t.text.replace(/#$/, '')}</a></li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3>添付（{data.attachments.length}）</h3>
            {data.attachments.slice(0, 5).map((a: any) => (
              <a key={a.file} className="file" href={`${wapi(app.wiki)}/attachments/raw?page=${encodeURIComponent(page)}&file=${encodeURIComponent(a.file)}`} target="_blank" rel="noopener noreferrer">
                <Icon name="file" /><span className="ellipsis">{a.file}</span><small>{a.size}</small>
              </a>
            ))}
            {data.attachments.length === 0 && <p className="muted">なし</p>}
            <Link className="small-link" to={tabHref('attachments')}>添付を管理</Link>
          </section>
          <section>
            <h3>ページ情報</h3>
            <dl className="kv">
              <dt>凍結</dt><dd>{data.frozen ? 'あり' : 'なし'}</dd>
              <dt>更新</dt><dd>{fmtDate(data.mtime)}</dd>
              <dt>文字数</dt><dd>{data.size.toLocaleString()}</dd>
              <dt>子ページ</dt><dd>{data.children}</dd>
            </dl>
          </section>
        </aside>
      )}
      {dialog === 'rename' && <RenameDialog page={page} onClose={() => setDialog(null)} />}
      {dialog === 'freeze' && <FreezeDialog page={page} frozen={data.frozen} onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'delete' && <DeleteDialog page={page} onClose={() => setDialog(null)} />}
    </>
  );
}

function PageCard({ p, via }: { p: any; via?: string }) {
  const app = useApp();
  return (
    <Link className="card" to={pagePath(app.wiki, p.name)}>
      <div className="sp">{p.space}{p.mtime ? ` ・ ${fmtRelative(p.mtime)}` : ''}</div>
      <div className="t">{p.name.includes('/') ? p.name.slice(p.name.indexOf('/') + 1) : p.name}</div>
      <div className="ex">{via ? `共通のリンク先: ${via.split('\n').join('、')}` : p.excerpt}</div>
    </Link>
  );
}

function ChildList({ page }: { page: string }) {
  const app = useApp();
  const { data } = useApi<any[]>(`${wapi(app.wiki)}/tree?parent=${encodeURIComponent(page)}`);
  if (!data?.length) return null;
  return (
    <section className="related" aria-label="子ページ">
      <h2>子ページ（{data.length}）</h2>
      <ul className="child-list">
        {data.slice(0, 200).map((c) => (
          <li key={c.name}><Link to={pagePath(app.wiki, c.name)}><Icon name={c.children ? 'folder' : 'file'} />{c.label}</Link>{c.children ? <span className="count">{c.children}</span> : null}</li>
        ))}
      </ul>
    </section>
  );
}

function SourceTab({ page }: { page: string }) {
  const app = useApp();
  const { data, error } = useApi<any>(`${wapi(app.wiki)}/page/raw?p=${encodeURIComponent(page)}`);
  if (error) return <p className="notice error">{error.message}</p>;
  if (!data) return <div className="skeleton" />;
  return (
    <div>
      <div className="row-actions">
        <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(data.source); app.toast('コピーしました'); }}><Icon name="copy" />コピー</button>
        <a className="btn sm" download={`${leaf(page)}.txt`} href={URL.createObjectURL(new Blob([data.source], { type: 'text/plain' }))}><Icon name="download" />ダウンロード</a>
      </div>
      <pre className="source-view">{data.source}</pre>
    </div>
  );
}

function RenameDialog({ page, onClose }: { page: string; onClose: () => void }) {
  const app = useApp();
  const nav = useNavigate();
  const [to, setTo] = useState(page);
  const [pass, setPass] = useState('');
  const [related, setRelated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api(`${wapi(app.wiki)}/page/rename`, { body: { p: page, to: to.trim(), pass, related } });
      app.toast('名前を変更しました');
      app.bumpTree();
      onClose();
      nav(pagePath(app.wiki, to.trim()));
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="名前を変更" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>新しいページ名<input className="input" value={to} onChange={(e) => setTo(e.target.value)} required autoFocus /></label>
        <label className="inline-check"><input type="checkbox" checked={related} onChange={(e) => setRelated(e.target.checked)} /> 配下のページも一緒に変更する</label>
        <label>管理者パスワード<input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" /></label>
        <p className="muted small">PukiWiki の名前変更には管理者パスワードが必要です。</p>
        {err && <p className="notice error">{err}</p>}
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy || !to.trim() || to.trim() === page}>変更する</button></div>
      </form>
    </Modal>
  );
}

function FreezeDialog({ page, frozen, onClose, onDone }: { page: string; frozen: boolean; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api(`${wapi(app.wiki)}/page/freeze`, { body: { p: page, pass, freeze: !frozen } });
      app.toast(frozen ? '凍結を解除しました' : '凍結しました');
      onClose(); onDone();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={frozen ? '凍結を解除' : 'ページを凍結'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p>{frozen ? '凍結を解除すると、誰でも編集できるようになります。' : '凍結すると、管理者パスワードを知っている人しか編集できなくなります。'}</p>
        <label>管理者パスワード<input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} required autoFocus autoComplete="current-password" /></label>
        {err && <p className="notice error">{err}</p>}
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy || !pass}>{frozen ? '解除する' : '凍結する'}</button></div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ page, onClose }: { page: string; onClose: () => void }) {
  const app = useApp();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const src = await api<any>(`${wapi(app.wiki)}/page/source?p=${encodeURIComponent(page)}`);
      await api(`${wapi(app.wiki)}/page`, { method: 'PUT', body: { p: page, source: '', digest: src.digest } });
      app.toast('削除しました');
      app.bumpTree();
      onClose();
      const parent = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : null;
      nav(parent ? pagePath(app.wiki, parent) : `/w/${encodeURIComponent(app.wiki)}`);
    } catch (e2) { setErr(e2 instanceof ApiError && e2.status === 423 ? 'ページが凍結されているため削除できません' : (e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="ページを削除" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p>「{page}」を削除します。PukiWiki のバックアップには残ります（「削除済みページ」から確認できます）。</p>
        <label>確認のため、ページ名の最後の部分「{leaf(page)}」を入力してください<input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus /></label>
        {err && <p className="notice error">{err}</p>}
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>キャンセル</button><button className="btn danger" disabled={busy || confirm !== leaf(page)}>削除する</button></div>
      </form>
    </Modal>
  );
}
