import { useEffect, useState } from 'react';
import { api, fmtDate, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Layout.tsx';

export function DiffView({ rows, leftLabel, rightLabel, plus, minus }: { rows: any[]; leftLabel: string; rightLabel: string; plus?: number; minus?: number }) {
  const [mode, setMode] = useState<'split' | 'unified'>(() => (typeof window !== 'undefined' && window.innerWidth < 760 ? 'unified' : 'split'));
  return (
    <div className="diff">
      <div className="diff-head">
        <span>{leftLabel}</span><span aria-hidden="true">→</span><span>{rightLabel}</span>
        {plus !== undefined && <><span className="plus">+{plus}</span><span className="minus">−{minus}</span></>}
        <span className="seg diff-mode" role="group" aria-label="差分の表示形式">
          <button className={mode === 'split' ? 'on' : ''} aria-pressed={mode === 'split'} onClick={() => setMode('split')}>左右</button>
          <button className={mode === 'unified' ? 'on' : ''} aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>一列</button>
        </span>
      </div>
      {rows.length === 0 && <p className="diff-empty">違いはありません。</p>}
      {mode === 'split' ? (
        <div className="diff-cols">
          {(['old', 'new'] as const).map((side) => (
            <div key={side} className="diff-col" aria-label={side === 'old' ? leftLabel : rightLabel}>
              {rows.map((r, i) => {
                if (r.type === 'gap') return <div key={i} className="dl gap"><span className="c">… 変更のない {r.count} 行 …</span></div>;
                const html = side === 'old' ? r.oldHtml : r.newHtml;
                const no = side === 'old' ? r.oldNo : r.newNo;
                if (html === undefined) return <div key={i} className="dl empty"><span className="n" /><span className="s" /><span className="c" /></div>;
                const cls = r.type === 'eq' ? '' : side === 'old' ? (r.type === 'add' ? '' : 'del') : (r.type === 'del' ? '' : 'add');
                return <div key={i} className={`dl ${cls}`}><span className="n">{no}</span><span className="s">{cls === 'del' ? '−' : cls === 'add' ? '+' : ''}</span><span className="c" dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} /></div>;
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="diff-col">
          {rows.flatMap((r, i) => {
            if (r.type === 'gap') return [<div key={i} className="dl gap"><span className="c">… 変更のない {r.count} 行 …</span></div>];
            if (r.type === 'eq') return [<div key={i} className="dl"><span className="n">{r.newNo}</span><span className="s" /><span className="c" dangerouslySetInnerHTML={{ __html: r.newHtml || '&nbsp;' }} /></div>];
            const out = [];
            if (r.oldHtml !== undefined) out.push(<div key={i + 'o'} className="dl del"><span className="n">{r.oldNo}</span><span className="s">−</span><span className="c" dangerouslySetInnerHTML={{ __html: r.oldHtml || '&nbsp;' }} /></div>);
            if (r.newHtml !== undefined) out.push(<div key={i + 'n'} className="dl add"><span className="n">{r.newNo}</span><span className="s">+</span><span className="c" dangerouslySetInnerHTML={{ __html: r.newHtml || '&nbsp;' }} /></div>);
            return out;
          })}
        </div>
      )}
    </div>
  );
}

export function HistoryTab({ page, onRestored }: { page: string; onRestored: () => void }) {
  const app = useApp();
  const { data, error } = useApi<any>(`${wapi(app.wiki)}/page/history?p=${encodeURIComponent(page)}`);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('current');
  const [diff, setDiff] = useState<any>(null);
  const [view, setView] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (data?.backups?.length && !from) setFrom(String(data.backups[0].age));
  }, [data, from]);
  useEffect(() => {
    if (!from && !data?.backups?.length) return;
    let alive = true;
    setDiff(null);
    api(`${wapi(app.wiki)}/page/diff?p=${encodeURIComponent(page)}&from=${from}&to=${to}`).then((d) => { if (alive) setDiff(d); }).catch((e) => app.toast(e.message, 'error'));
    return () => { alive = false; };
  }, [from, to, page, app.wiki]); // eslint-disable-line

  const label = (v: string) => (v === 'current' ? '現在の版' : `版 ${v}（${data?.backups.find((b: any) => String(b.age) === v)?.label ?? ''}）`);
  const restore = async (age: string) => {
    try {
      const old = await api<any>(`${wapi(app.wiki)}/page/history/source?p=${encodeURIComponent(page)}&age=${age}`);
      const cur = await api<any>(`${wapi(app.wiki)}/page/source?p=${encodeURIComponent(page)}`);
      await api(`${wapi(app.wiki)}/page`, { method: 'PUT', body: { p: page, source: old.source, digest: cur.digest } });
      app.toast(`版 ${age} に戻しました`);
      setConfirm(null);
      onRestored();
    } catch (e) { app.toast((e as Error).message, 'error'); }
  };

  if (error) return <p className="notice error">{error.message}</p>;
  if (!data) return <div className="skeleton" />;
  const versions = [{ age: 'current', label: '現在の版', time: data.current?.mtime }, ...data.backups.map((b: any) => ({ age: String(b.age), label: `版 ${b.age}`, time: b.time }))];
  return (
    <div className="history">
      <section className="history-list" aria-label="版の一覧">
        <h2>版（{versions.length}）</h2>
        <ul className="versions">
          {versions.map((v) => (
            <li key={v.age} className={v.age === to || v.age === from ? 'on' : ''}>
              <span className="v">{v.age === 'current' ? '現在' : v.age}</span>
              <span>{fmtDate(v.time)}</span>
              <span className="v-actions">
                {v.age !== 'current' && <button className="btn sm ghost" onClick={() => setView(v.age)}>表示</button>}
                {v.age !== 'current' && <button className="btn sm ghost" onClick={() => setConfirm(v.age)}>戻す</button>}
              </span>
            </li>
          ))}
        </ul>
        {data.backups.length === 0 && <p className="muted small">バックアップはまだありません（PukiWiki は一定時間ごとにバックアップを作ります）。</p>}
      </section>
      <section className="history-diff" aria-label="差分">
        {data.backups.length > 0 && (
          <div className="diff-picker">
            <label className="sr" htmlFor="from">比較元</label>
            <select className="tb-select" id="from" value={from} onChange={(e) => setFrom(e.target.value)}>
              {data.backups.map((b: any) => <option key={b.age} value={b.age}>版 {b.age}（{b.label}）</option>)}
            </select>
            <span aria-hidden="true">→</span>
            <label className="sr" htmlFor="to">比較先</label>
            <select className="tb-select" id="to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="current">現在の版</option>
              {data.backups.map((b: any) => <option key={b.age} value={b.age}>版 {b.age}（{b.label}）</option>)}
            </select>
          </div>
        )}
        {diff ? <DiffView rows={diff.rows} plus={diff.plus} minus={diff.minus} leftLabel={label(from)} rightLabel={label(to)} />
          : data.backups.length > 0 ? <div className="skeleton" /> : null}
      </section>
      {view && <VersionModal page={page} age={view} onClose={() => setView(null)} />}
      {confirm && (
        <Modal title={`版 ${confirm} に戻す`} onClose={() => setConfirm(null)}>
          <p>版 {confirm} の内容で、新しい版として保存します。今の内容もバックアップに残ります。</p>
          <div className="dialog-actions"><button className="btn" onClick={() => setConfirm(null)}>キャンセル</button><button className="btn primary" onClick={() => restore(confirm)}><Icon name="undo" />戻す</button></div>
        </Modal>
      )}
    </div>
  );
}

function VersionModal({ page, age, onClose }: { page: string; age: string; onClose: () => void }) {
  const app = useApp();
  const { data } = useApi<any>(`${wapi(app.wiki)}/page/history/source?p=${encodeURIComponent(page)}&age=${age}`);
  return (
    <Modal title={`版 ${age} の元テキスト`} onClose={onClose} wide>
      {data ? <pre className="source-view">{data.source}</pre> : <div className="skeleton" />}
    </Modal>
  );
}
