import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from './Icon.tsx';
import { AiMarkdown } from './AiMarkdown.tsx';

interface Step { id: string; label: string; done: boolean; ok: boolean }
interface Proposal { id: string; page: string; summary: string; plus: number; minus: number; kind: string }
interface Msg { role: 'user' | 'assistant'; text: string; steps?: Step[]; proposals?: Proposal[]; thinking?: string; error?: string; pending?: boolean }

export function AgentPanel() {
  const app = useApp();
  const status = useApi<any>(`${wapi(app.wiki)}/agent/status`);
  const storeKey = `noren:ai:${app.wiki}`;
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(storeKey) ?? '[]'); } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [usePage, setUsePage] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const handled = useRef<object | null>(null);

  useEffect(() => {
    try { sessionStorage.setItem(storeKey, JSON.stringify(msgs.filter((m) => !m.pending).slice(-30))); } catch { /* ignore */ }
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, storeKey]);

  // a request coming from elsewhere (palette "AI に聞く", page button)
  useEffect(() => {
    const r = app.aiRequest;
    if (r && r !== handled.current && r.message) {
      handled.current = r;
      send(r.message, r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.aiRequest]);

  const update = (fn: (m: Msg) => Msg) => setMsgs((list) => {
    const copy = [...list];
    copy[copy.length - 1] = fn(copy[copy.length - 1]);
    return copy;
  });

  async function send(text: string, extra?: { selection?: string; draft?: string; page?: string }) {
    const message = text.trim();
    if (!message || busy) return;
    const history = msgs.filter((m) => !m.error).slice(-12).map((m) => ({ role: m.role, content: m.text }));
    setMsgs((l) => [...l, { role: 'user', text: message }, { role: 'assistant', text: '', steps: [], proposals: [], pending: true }]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const page = extra?.page ?? (usePage ? app.currentPage ?? undefined : undefined);
    try {
      const res = await fetch(`${wapi(app.wiki)}/agent/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'noren' },
        body: JSON.stringify({ message, history, context: { page, selection: extra?.selection, draft: extra?.draft } }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let ev: any;
          try { ev = JSON.parse(data); } catch { continue; }
          handleEvent(ev);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') update((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      update((m) => ({ ...m, pending: false }));
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleEvent(ev: any) {
    switch (ev.type) {
      case 'text': update((m) => ({ ...m, text: m.text + ev.delta })); break;
      case 'thinking': update((m) => ({ ...m, thinking: (m.thinking ?? '') + ev.delta })); break;
      case 'tool_start': update((m) => ({ ...m, steps: [...(m.steps ?? []), { id: ev.id, label: ev.summary, done: false, ok: true }] })); break;
      case 'tool_end': update((m) => ({ ...m, steps: (m.steps ?? []).map((s) => (s.id === ev.id ? { ...s, done: true, ok: ev.ok, label: ev.ok ? s.label : `${s.label}（${ev.summary}）` } : s)) })); break;
      case 'proposal': update((m) => ({ ...m, proposals: [...(m.proposals ?? []), ev] })); break;
      case 'error': update((m) => ({ ...m, error: ev.message })); break;
      default: break;
    }
  }

  const disabled = status.data && !status.data.enabled;
  return (
    <aside className="ai-panel" aria-label="AI アシスタント">
      <div className="ai-head">
        <Icon name="spark" className="ai-color" />
        <strong>AI アシスタント</strong>
        {msgs.length > 0 && <button className="btn sm ghost" onClick={() => setMsgs([])} disabled={busy}>新しい会話</button>}
        <button className="icon-btn" aria-label="パネルを閉じる" onClick={app.closeAi}><Icon name="x" /></button>
      </div>
      <div className="ai-body" ref={bodyRef} aria-live="polite">
        {disabled && <p className="notice warn">{status.data.reason}</p>}
        {!disabled && msgs.length === 0 && (
          <div className="ai-empty">
            <p>Wiki の内容について質問したり、ページの要約・下書き・書き換えを頼めます。</p>
            <div className="ai-suggest">
              {(app.currentPage ? ['このページを要約して', 'このページに関連するページは？', 'このページの誤字脱字を直して'] : ['最近更新された障害対応記録は？', '手順書の一覧を見せて']).map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => m.role === 'user'
          ? <div key={i} className="msg-user">{m.text}</div>
          : (
            <div key={i} className="msg-ai">
              {m.steps && m.steps.length > 0 && (
                <ul className="steps" aria-label="AI の作業">
                  {m.steps.map((s) => <li key={s.id}><Icon name={s.done ? (s.ok ? 'check' : 'warn') : 'clock'} />{s.label}</li>)}
                </ul>
              )}
              {m.thinking && <details className="thinking"><summary>考えた過程（要約）</summary><p>{m.thinking}</p></details>}
              {m.text && <AiMarkdown wiki={app.wiki} text={m.text} />}
              {m.pending && !m.text && <p className="muted">考えています…</p>}
              {(m.proposals ?? []).map((p) => (
                <div key={p.id} className="proposal">
                  <div className="ph"><Icon name="spark" />{p.kind === 'create' ? '新規ページの提案' : '変更の提案'} ・ <span className="ellipsis">{p.page}</span>
                    <span className="ph-delta"><span className="plus">+{p.plus}</span> <span className="minus">−{p.minus}</span></span></div>
                  <div className="pb">{p.summary}</div>
                  <div className="pa"><Link className="btn sm primary" to={`/w/${encodeURIComponent(app.wiki)}/proposals/${p.id}`}>差分を見て承認する</Link></div>
                </div>
              ))}
              {m.error && <p className="notice error">{m.error}</p>}
            </div>
          ))}
        {status.data && (
          <p className="scope-note"><Icon name="shield" />AI はページに直接書き込みません。変更は提案として表示され、承認したときだけ保存されます。
            {status.data.excluded?.length ? ` AI から見えないページ: ${status.data.excluded.join('、')}` : ''}</p>
        )}
      </div>
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <label className="sr" htmlFor="ai-ask">AI への依頼</label>
        <textarea id="ai-ask" value={input} onChange={(e) => setInput(e.target.value)} disabled={!!disabled}
          placeholder="質問や依頼を書く（Enter で送信、Shift+Enter で改行）"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }} />
        <div className="row">
          {app.currentPage && (
            <label className="inline-check"><input type="checkbox" checked={usePage} onChange={(e) => setUsePage(e.target.checked)} /> このページを対象にする</label>
          )}
          {busy
            ? <button type="button" className="btn sm" onClick={() => abortRef.current?.abort()}>止める</button>
            : <button type="submit" className="btn sm ai-solid" disabled={!input.trim() || !!disabled}><Icon name="send" />送信</button>}
        </div>
      </form>
    </aside>
  );
}
