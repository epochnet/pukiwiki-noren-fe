import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, fmtDate, pagePath, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';
import { Crumbs } from './PageRoute.tsx';
import { DiffView } from './HistoryTab.tsx';

export function ProposalPage() {
  const app = useApp();
  const nav = useNavigate();
  const { id = '' } = useParams();
  const { data, error, reload } = useApi<any>(`${wapi(app.wiki)}/agent/proposals/${encodeURIComponent(id)}`);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  if (error) return <main className="main"><p className="notice error">{error.message}</p></main>;
  if (!data) return <main className="main"><div className="skeleton title" /><div className="skeleton" /></main>;

  const apply = async (source?: string) => {
    setBusy(true);
    try {
      await api(`${wapi(app.wiki)}/agent/proposals/${encodeURIComponent(id)}/apply`, { body: source !== undefined ? { source } : {} });
      app.toast('提案を保存しました');
      if (data.kind === 'create') app.bumpTree();
      nav(pagePath(app.wiki, data.page));
    } catch (e) {
      const err = e as ApiError;
      app.toast(err.status === 409 ? '提案を作った後にページが更新されています。差分を確認し直してください。' : err.message, 'error');
      reload();
    } finally { setBusy(false); }
  };
  const reject = async () => {
    await api(`${wapi(app.wiki)}/agent/proposals/${encodeURIComponent(id)}/reject`, { body: {} });
    app.toast('提案を却下しました');
    nav(pagePath(app.wiki, data.page));
  };

  return (
    <main className="main">
      <div className="main-narrow wide">
        <Crumbs page={data.page} wiki={app.wiki} />
        <div className="page-head">
          <h1 className="page-title">AI の提案を確認</h1>
          <span className={`badge ${data.status === 'open' ? 'ai' : ''}`}><Icon name="spark" />{data.status === 'open' ? 'AI 提案 ・ 未反映' : data.status === 'applied' ? '保存済み' : '却下済み'}</span>
        </div>
        <p className="muted">{data.kind === 'create' ? '新しいページ' : 'ページ'}「<Link to={pagePath(app.wiki, data.page)}>{data.page}</Link>」への提案 ・ {fmtDate(data.created_at)} ・ 依頼者 {data.created_by}</p>
        <p className="proposal-summary">{data.summary}</p>
        {data.stale && data.status === 'open' && (
          <p className="notice warn">提案を作った後に、このページは更新されています。下の差分は「最新の版 → 提案」です。承認すると競合として検出され、保存されません。AI にもう一度依頼してください。</p>
        )}
        {!editing
          ? <DiffView rows={data.diff.rows} plus={data.diff.plus} minus={data.diff.minus} leftLabel={data.kind === 'create' ? '（新規）' : '現在の版'} rightLabel="提案" />
          : (
            <div className="form">
              <label htmlFor="ptext">提案を直してから保存</label>
              <textarea id="ptext" className="input mono tall" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          )}
        {data.status === 'open' && (
          <div className="row-actions sticky-actions">
            {!editing ? (
              <>
                <button className="btn primary" disabled={busy || data.stale} onClick={() => apply()}><Icon name="check" />承認して保存</button>
                <button className="btn" onClick={() => { setText(data.source); setEditing(true); }}><Icon name="edit" />直してから保存</button>
                <button className="btn" onClick={reject}><Icon name="x" />却下</button>
              </>
            ) : (
              <>
                <button className="btn primary" disabled={busy || data.stale} onClick={() => apply(text)}><Icon name="check" />この内容で保存</button>
                <button className="btn" onClick={() => setEditing(false)}>差分に戻る</button>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
