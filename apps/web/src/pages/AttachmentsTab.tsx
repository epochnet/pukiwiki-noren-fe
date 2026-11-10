import { useRef, useState } from 'react';
import { api, useApi, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Layout.tsx';

export async function uploadFile(wiki: string, page: string, file: File, pass?: string, name?: string) {
  const fd = new FormData();
  fd.set('p', page);
  fd.set('file', file);
  if (name) fd.set('name', name);
  if (pass) fd.set('pass', pass);
  return api(`${wapi(wiki)}/attachments`, { form: fd });
}

const isImage = (f: string) => /\.(png|jpe?g|gif|webp)$/i.test(f);

export function AttachmentsTab({ page, onChange }: { page: string; onChange: () => void }) {
  const app = useApp();
  const { data, error, reload } = useApi<any[]>(`${wapi(app.wiki)}/attachments?p=${encodeURIComponent(page)}`);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ file: string; pcmd: 'delete' | 'freeze' | 'unfreeze' | 'rename' } | null>(null);
  const [needPass, setNeedPass] = useState<File[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const adminConfigured = !!app.caps?.adminPasswordConfigured;

  const upload = async (files: File[], pass?: string) => {
    setBusy(true);
    try {
      for (const f of files) {
        await uploadFile(app.wiki, page, f, pass);
        app.toast(`「${f.name}」をアップロードしました`);
      }
      reload(); onChange();
    } catch (e) {
      const msg = (e as Error).message;
      if (!pass && /パスワード|password|管理者/i.test(msg)) setNeedPass(files);
      else app.toast(msg, 'error');
    } finally { setBusy(false); }
  };
  const raw = (f: string, dl = false) => `${wapi(app.wiki)}/attachments/raw?page=${encodeURIComponent(page)}&file=${encodeURIComponent(f)}${dl ? '&download=1' : ''}`;

  return (
    <div>
      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}
      >
        <Icon name="upload" size={22} />
        <p>ここにファイルをドロップ、または <button className="linklike" onClick={() => input.current?.click()} disabled={busy}>ファイルを選ぶ</button></p>
        <p className="muted small">{adminConfigured ? 'アップロードに管理者パスワードは不要です（サーバー側で設定済み）。' : 'Wiki の設定によっては管理者パスワードが必要です。'}上限サイズは Wiki の設定に従います。</p>
        <input ref={input} type="file" multiple hidden onChange={(e) => { upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        {busy && <p aria-live="polite">アップロード中…</p>}
      </div>
      {error && <p className="notice error">{error.message}</p>}
      {data && data.length === 0 && <p className="muted">添付ファイルはありません。</p>}
      {data && data.length > 0 && (
        <ul className="attach-list">
          {data.map((a) => (
            <li key={a.file}>
              {isImage(a.file) ? <img src={raw(a.file)} alt="" loading="lazy" /> : <span className="attach-icon"><Icon name="file" size={22} /></span>}
              <div className="attach-main">
                <a href={raw(a.file)} target="_blank" rel="noopener noreferrer">{a.file}</a>
                <span className="muted small">{a.sizeLabel}</span>
              </div>
              <div className="attach-actions">
                <button className="btn sm ghost" onClick={() => { navigator.clipboard?.writeText(`&ref(${a.file});`); app.toast('記法をコピーしました'); }} title="本文に貼るための記法をコピー"><Icon name="copy" />&amp;ref</button>
                <a className="btn sm ghost" href={raw(a.file, true)}><Icon name="download" /><span className="sr">ダウンロード</span></a>
                <button className="btn sm ghost" onClick={() => setAction({ file: a.file, pcmd: 'rename' })}>名前変更</button>
                <button className="btn sm ghost" onClick={() => setAction({ file: a.file, pcmd: 'freeze' })}>凍結</button>
                <button className="btn sm ghost danger-text" onClick={() => setAction({ file: a.file, pcmd: 'delete' })}><Icon name="trash" /><span className="sr">削除</span></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {action && <AttachActionDialog page={page} {...action} onClose={() => setAction(null)} onDone={() => { reload(); onChange(); }} />}
      {needPass && (
        <PassDialog title="管理者パスワード" message="この Wiki では添付のアップロードに管理者パスワードが必要です。" onClose={() => setNeedPass(null)}
          onSubmit={(p) => { const f = needPass; setNeedPass(null); upload(f, p); }} />
      )}
    </div>
  );
}

function PassDialog({ title, message, onClose, onSubmit }: { title: string; message: string; onClose: () => void; onSubmit: (p: string) => void }) {
  const [pass, setPass] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSubmit(pass); }}>
        <p>{message}</p>
        <label>パスワード<input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus /></label>
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={!pass}>送信</button></div>
      </form>
    </Modal>
  );
}

function AttachActionDialog({ page, file, pcmd, onClose, onDone }: { page: string; file: string; pcmd: 'delete' | 'freeze' | 'unfreeze' | 'rename'; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const [pass, setPass] = useState('');
  const [newname, setNewname] = useState(file);
  const [mode, setMode] = useState(pcmd);
  const [err, setErr] = useState('');
  const titles = { delete: '添付を削除', freeze: '添付を凍結', unfreeze: '添付の凍結を解除', rename: '添付の名前を変更' };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await api(`${wapi(app.wiki)}/attachments/action`, { body: { page, file, pcmd: mode, pass, newname: mode === 'rename' ? newname : undefined } });
      app.toast('完了しました');
      onClose(); onDone();
    } catch (e2) { setErr((e2 as Error).message); }
  };
  return (
    <Modal title={titles[mode]} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p>対象: {file}</p>
        {(mode === 'freeze' || mode === 'unfreeze') && (
          <div className="seg" role="group" aria-label="操作">
            <button type="button" className={mode === 'freeze' ? 'on' : ''} onClick={() => setMode('freeze')}>凍結する</button>
            <button type="button" className={mode === 'unfreeze' ? 'on' : ''} onClick={() => setMode('unfreeze')}>凍結を解除する</button>
          </div>
        )}
        {mode === 'rename' && <label>新しいファイル名<input className="input" value={newname} onChange={(e) => setNewname(e.target.value)} /></label>}
        <label>管理者パスワード<input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus /></label>
        {err && <p className="notice error">{err}</p>}
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>キャンセル</button><button className={`btn ${mode === 'delete' ? 'danger' : 'primary'}`} disabled={!pass}>実行</button></div>
      </form>
    </Modal>
  );
}
