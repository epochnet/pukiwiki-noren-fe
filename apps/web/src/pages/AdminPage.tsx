import { api, fmtDate, fmtRelative, pagePath, useApi, wapi } from '../api.ts';
import { Link } from 'react-router';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';

export function AdminPage() {
  const app = useApp();
  const sync = useApi<any>(`${wapi(app.wiki)}/sync/status`);
  const audit = useApi<any[]>(`${wapi(app.wiki)}/audit?limit=100`);
  const agent = useApi<any>(`${wapi(app.wiki)}/agent/status`);
  const caps = app.caps;
  const run = async (kind: 'full' | 'incremental') => {
    try {
      const r = await api<any>(`${wapi(app.wiki)}/sync/${kind}`, { body: {} });
      app.toast(kind === 'full' ? '全件同期を開始しました' : `差分同期: ${r.updated} 件更新`);
      setTimeout(sync.reload, 800);
    } catch (e) { app.toast((e as Error).message, 'error'); }
  };
  const s = sync.data;
  return (
    <main className="main">
      <div className="main-narrow wide">
        <h1 className="page-title">管理・同期状態</h1>
        <div className="grid-2">
          <section className="panel">
            <h2><Icon name="settings" />接続先 PukiWiki</h2>
            <dl className="kv pad">
              <dt>版</dt><dd>{caps?.version ?? '—'}</dd>
              <dt>文字コード</dt><dd>{caps?.encoding ?? '—'}</dd>
              <dt>search2</dt><dd>{caps ? (caps.search2 ? 'あり' : 'なし') : '—'}</dd>
              <dt>読み取り専用</dt><dd>{caps ? (caps.readonly ? 'はい' : 'いいえ') : '—'}</dd>
              <dt>管理者パスワード</dt><dd>{caps?.adminPasswordConfigured ? '設定済み（添付のアップロードに使用）' : '未設定'}</dd>
            </dl>
          </section>
          <section className="panel">
            <h2><Icon name="refresh" />索引の同期</h2>
            <dl className="kv pad">
              <dt>ページ数</dt><dd>{s?.pages?.toLocaleString() ?? '—'}</dd>
              <dt>状態</dt><dd>{s?.running ? (s.running === 'full' ? `全件同期中 ${s.progress ? `${s.progress.done}/${s.progress.total}` : ''}` : '差分同期中') : '待機中'}</dd>
              <dt>最終の全件同期</dt><dd>{fmtDate(s?.lastFull)}</dd>
              <dt>最終の差分同期</dt><dd>{fmtRelative(s?.lastIncremental)}</dd>
              {s?.lastError && <><dt>エラー</dt><dd className="danger-text">{s.lastError}</dd></>}
            </dl>
            <div className="row-actions pad">
              <button className="btn" onClick={() => run('incremental')}>差分同期を実行</button>
              <button className="btn" onClick={() => run('full')} disabled={!!s?.running}>全件同期を実行</button>
              <button className="btn ghost" onClick={sync.reload}><Icon name="refresh" />更新</button>
            </div>
          </section>
          <section className="panel">
            <h2><Icon name="spark" />AI アシスタント</h2>
            <dl className="kv pad">
              <dt>状態</dt><dd>{agent.data ? (agent.data.enabled ? '有効' : `無効（${agent.data.reason}）`) : '—'}</dd>
              <dt>API</dt><dd>{agent.data ? (agent.data.provider === 'openai' ? 'OpenAI 互換' : 'Claude API') : '—'}</dd>
              <dt>モデル</dt><dd>{agent.data?.model ?? '—'}</dd>
              <dt>MCP</dt><dd>{agent.data?.mcp ? `${agent.data.mcp.url}${agent.data.mcp.error ? `（${agent.data.mcp.error}）` : ''}` : '未設定'}</dd>
              <dt>AI から除外</dt><dd>{agent.data?.excluded?.length ? agent.data.excluded.join('、') : 'なし'}</dd>
            </dl>
          </section>
        </div>
        <section className="panel audit">
          <h2><Icon name="history" />操作ログ（新しい順）</h2>
          <div className="table-wrap flush">
            <table>
              <thead><tr><th>日時</th><th>利用者</th><th>操作</th><th>ページ</th><th>結果</th></tr></thead>
              <tbody>
                {(audit.data ?? []).map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.time)}</td><td>{a.user}</td><td><code>{a.action}</code></td>
                    <td>{a.page ? <Link to={pagePath(app.wiki, a.page)}>{a.page}</Link> : '—'}</td>
                    <td>{a.ok ? '成功' : <span className="danger-text">失敗</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
