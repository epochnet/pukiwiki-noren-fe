import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { createPatch, applyPatch } from 'diff';
import { toEditorDoc, fromEditorDoc, serializeInline, parseInline, linkRaw } from '@syntax';
import type { BlockMeta } from '@syntax';
import { api, ApiError, leaf, local, pagePath, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Layout.tsx';
import { buildExtensions, flattenPastedHtml, BadCharsKey } from '../editor/extensions.ts';
import { SlashMenu, LinkMenu, menuStore, slashItems } from '../editor/menus.ts';
import type { MenuItem, MenuState } from '../editor/menus.ts';
import { editorEnv } from '../editor/NodeViews.tsx';
import { SourceEditor } from '../editor/SourceEditor.tsx';
import { Crumbs } from './PageRoute.tsx';
import { uploadFile } from './AttachmentsTab.tsx';
import { DiffView } from './HistoryTab.tsx';

type Mode = 'visual' | 'source';

function countRaw(doc: any): { blocks: number; raw: number } {
  const c = (doc?.content ?? []).filter((n: any) => n.type !== 'pkMeta');
  return { blocks: c.length, raw: c.filter((n: any) => n.type === 'pkRaw').length };
}

/** Client-side side-by-side diff rows (for conflict dialogs). */
function quickRows(a: string, b: string) {
  const A = a.split('\n'), B = b.split('\n');
  const rows: any[] = [];
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) rows.push({ type: 'eq', oldNo: i + 1, newNo: i + 1, oldHtml: esc(A[i] ?? ''), newHtml: esc(B[i] ?? '') });
    else rows.push({ type: 'mod', oldNo: A[i] !== undefined ? i + 1 : undefined, newNo: B[i] !== undefined ? i + 1 : undefined, oldHtml: A[i] !== undefined ? esc(A[i]) : undefined, newHtml: B[i] !== undefined ? esc(B[i]) : undefined });
  }
  return rows;
}

export function EditorPage({ page }: { page: string }) {
  const app = useApp();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const template = sp.get('template');
  const [loaded, setLoaded] = useState<{ source: string; digest: string; frozen: boolean; exists: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => local.get<Mode>('noren:editor-mode', 'visual'));
  const [source, setSource] = useState('');
  const metaRef = useRef<Record<string, BlockMeta>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notimestamp, setNotimestamp] = useState(false);
  const [badChars, setBadChars] = useState<string[]>([]);
  const [conflict, setConflict] = useState<null | { latest: string; latestDigest: string; merged: string | null; mine: string }>(null);
  const [draftOffer, setDraftOffer] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [linkEdit, setLinkEdit] = useState<null | { pos: number | null; label: string; target: string }>(null);
  const [inlineEdit, setInlineEdit] = useState<null | { pos: number; raw: string }>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [coverage, setCoverage] = useState({ blocks: 0, raw: 0 });
  const [frozenPass, setFrozenPass] = useState(false);
  const draftKey = loaded ? `noren:draft:${app.wiki}:${page}:${loaded.digest}` : null;
  const fileInput = useRef<HTMLInputElement>(null);
  editorEnv.wiki = app.wiki;
  editorEnv.page = page;
  editorEnv.markdown = !!app.caps?.markdownPlugin;

  const editor = useEditor({
    extensions: buildExtensions([SlashMenu, LinkMenu]),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: {
      attributes: { class: 'content edit-surface', 'aria-label': '本文（ビジュアル編集）', spellcheck: 'false' },
      transformPastedHTML: flattenPastedHtml,
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/') || f.size > 0);
        if (!files.length) return false;
        event.preventDefault();
        void pasteFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length) return false;
        event.preventDefault();
        void pasteFiles(files);
        return true;
      },
      handleClickOn: (_view, pos, node) => {
        if (node.type.name === 'pkLink') { setLinkEdit({ pos, label: node.attrs.label, target: node.attrs.target }); return true; }
        if (node.type.name === 'pkInline') { setInlineEdit({ pos, raw: node.attrs.raw }); return true; }
        return false;
      },
      handleKeyDown: (_view, e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveRef.current(); return true; }
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openLinkDialog(); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => { setDirty(true); setCoverage(countRaw(ed.getJSON())); },
  }, []);

  // ---- load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api<any>(`${wapi(app.wiki)}/page/source?p=${encodeURIComponent(page)}`);
        let src = r.source;
        if (!r.exists && template) {
          const t = await api<any>(`${wapi(app.wiki)}/page/source?p=${encodeURIComponent(template)}`).catch(() => null);
          if (t?.exists) src = t.source.replace(/ \[#[A-Za-z][\w-]*\]$/gm, '');
        }
        if (!alive) return;
        setLoaded({ source: r.exists ? r.source : '', digest: r.exists ? r.digest : '', frozen: r.frozen, exists: r.exists });
        setSource(src);
        const cov = r.coverage ?? { blocks: 0, raw: 0 };
        if (cov.blocks > 4 && cov.raw / cov.blocks > 0.5) setMode('source');
        setDirty(!r.exists && !!src);
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [app.wiki, page, template]);

  // push source into the visual editor
  const loadIntoVisual = useCallback((src: string) => {
    if (!editor) return;
    const { doc, meta } = toEditorDoc(src);
    metaRef.current = meta;
    const content = (doc.content ?? []).length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] };
    editor.commands.setContent(content as any, { emitUpdate: false });
    setCoverage(countRaw(content));
  }, [editor]);

  useEffect(() => {
    if (loaded && editor && mode === 'visual') loadIntoVisual(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, editor]);

  // draft offer
  useEffect(() => {
    if (!draftKey) return;
    const d = local.get<string | null>(draftKey, null);
    if (d && d !== loaded?.source) setDraftOffer(d);
  }, [draftKey]); // eslint-disable-line

  const currentSource = useCallback((): string => {
    if (mode === 'source' || !editor) return source;
    return fromEditorDoc(editor.getJSON() as any, metaRef.current);
  }, [mode, editor, source]);

  // autosave draft every 5 s while dirty
  useEffect(() => {
    if (!draftKey || !dirty) return;
    const t = setInterval(() => local.set(draftKey, currentSource()), 5000);
    return () => clearInterval(t);
  }, [draftKey, dirty, currentSource]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // live preview (debounced)
  useEffect(() => {
    if (!showPreview) return;
    const t = setTimeout(() => {
      api<{ html: string }>(`${wapi(app.wiki)}/page/preview`, { body: { p: page, source: currentSource() } })
        .then((r) => setPreview(r.html)).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [showPreview, source, coverage, dirty, app.wiki, page, currentSource]);

  useEffect(() => {
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(BadCharsKey, new Set(badChars)));
  }, [badChars, editor]);

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    if (m === 'source') setSource(currentSource());
    else loadIntoVisual(source);
    setMode(m);
    local.set('noren:editor-mode', m);
  };

  // ---- save
  const doSave = async (src: string, digest: string) => {
    setSaving(true);
    setBadChars([]);
    try {
      await api(`${wapi(app.wiki)}/page`, { method: 'PUT', body: { p: page, source: src, digest, notimestamp } });
      if (draftKey) local.del(draftKey);
      setDirty(false);
      app.toast('保存しました');
      if (!loaded?.exists) app.bumpTree();
      nav(pagePath(app.wiki, page));
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409 && err.details?.latest_source !== undefined) {
        const base = loaded?.source ?? '';
        const latest: string = err.details.latest_source;
        let merged: string | null = null;
        if (err.code === 'conflict') {
          const patch = createPatch('p', base, src);
          const r = applyPatch(latest, patch);
          merged = typeof r === 'string' ? r : null;
        }
        setConflict({ latest, latestDigest: err.details.latest_digest, merged, mine: src });
      } else if (err.status === 422) {
        const chars = [...new Set(((err.details?.chars ?? []) as any[]).map((c) => c.char))];
        setBadChars(chars);
        app.toast(err.message, 'error');
      } else if (err.status === 423) {
        setFrozenPass(true);
      } else app.toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const save = () => { if (loaded && !saving) void doSave(currentSource(), loaded.digest); };
  const saveRef = useRef(save);
  saveRef.current = save;

  const cancel = () => {
    if (dirty && !confirm('編集中の内容は保存されません。よろしいですか？')) return;
    if (draftKey) local.del(draftKey);
    setDirty(false);
    nav(loaded?.exists ? pagePath(app.wiki, page) : (page.includes('/') ? pagePath(app.wiki, page.slice(0, page.lastIndexOf('/'))) : `/w/${encodeURIComponent(app.wiki)}`));
  };

  // ---- attachments pasted / inserted
  async function pasteFiles(files: File[]) {
    if (!loaded?.exists) { app.toast('画像や添付は、ページを一度保存してから追加してください', 'error'); return; }
    for (const f of files) {
      const ext = (f.name.split('.').pop() || (f.type.split('/')[1] ?? 'bin')).replace(/[^\w]/g, '');
      const name = f.name && f.name !== 'image.png' ? f.name : `paste-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${ext}`;
      try {
        await uploadFile(app.wiki, page, f, undefined, name);
        editor?.chain().focus().insertContent({ type: 'pkInline', attrs: { raw: `&ref(${name});` } }).run();
        if (mode === 'source') setSource((s) => s + `\n#ref(${name})\n`);
        app.toast(`「${name}」を添付しました`);
      } catch (e) { app.toast((e as Error).message, 'error'); }
    }
  }

  function openLinkDialog() {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    const text = empty ? '' : editor.state.doc.textBetween(from, to);
    setLinkEdit({ pos: null, label: text, target: '' });
  }

  const applyLink = (label: string, target: string) => {
    if (!editor || !target.trim()) { setLinkEdit(null); return; }
    const attrs = { raw: linkRaw(label.trim(), target.trim()), label: label.trim() || target.trim(), target: target.trim() };
    if (linkEdit?.pos !== null && linkEdit?.pos !== undefined) {
      editor.chain().focus().command(({ tr }) => { tr.setNodeMarkup(linkEdit.pos as number, undefined, attrs); return true; }).run();
    } else {
      editor.chain().focus().insertContent({ type: 'pkLink', attrs }).run();
    }
    setLinkEdit(null);
  };

  const selectionSource = (): { text: string; inline: boolean } | null => {
    if (!editor) return null;
    const { from, to, empty } = editor.state.selection;
    if (empty) return null;
    const slice = editor.state.doc.slice(from, to);
    const json = slice.content.toJSON() ?? [];
    const inline = json.every((n: any) => n.type === 'text' || n.type === 'hardBreak' || n.type === 'pkLink' || n.type === 'pkInline');
    if (inline) return { text: serializeInline(json), inline: true };
    return { text: fromEditorDoc({ type: 'doc', content: json } as any, {}), inline: false };
  };

  const applyRewrite = (text: string, inline: boolean) => {
    if (!editor) return;
    try {
      if (inline) editor.chain().focus().insertContent(parseInline(text.replace(/\n+$/, '')) as any).run();
      else editor.chain().focus().insertContent(toEditorDoc(text.endsWith('\n') ? text : text + '\n').doc.content as any).run();
    } catch {
      editor.chain().focus().insertContent({ type: 'pkRaw', attrs: { reason: 'AI の出力' }, content: [{ type: 'text', text }] }).run();
    }
  };

  if (loadError) return <main className="main"><Crumbs page={page} wiki={app.wiki} /><p className="notice error">{loadError}</p></main>;
  if (!loaded) return <main className="main" aria-busy="true"><div className="skeleton title" /><div className="skeleton" /></main>;

  if (loaded.frozen) {
    return (
      <main className="main">
        <div className="main-narrow">
          <Crumbs page={page} wiki={app.wiki} />
          <h1 className="page-title">{leaf(page)}</h1>
          <p className="notice warn"><Icon name="lock" /> このページは凍結されているため編集できません。編集するには、ページの「その他」メニューから凍結を解除してください（管理者パスワードが必要です）。</p>
          <Link className="btn" to={pagePath(app.wiki, page)}>ページに戻る</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="editor-main">
      <div className="editor-bar">
        <button className="icon-btn" onClick={cancel} aria-label="編集をやめてページに戻る"><Icon name="left" /></button>
        <div className="editor-title">
          <Crumbs page={page} wiki={app.wiki} />
          <strong className="ellipsis">{loaded.exists ? leaf(page) : `${leaf(page)}（新規）`}</strong>
        </div>
        <div className="seg" role="group" aria-label="編集モード">
          <button className={mode === 'visual' ? 'on' : ''} aria-pressed={mode === 'visual'} onClick={() => switchMode('visual')}>ビジュアル</button>
          <button className={mode === 'source' ? 'on' : ''} aria-pressed={mode === 'source'} onClick={() => switchMode('source')}>ソース</button>
        </div>
        <button className={`btn sm ${showPreview ? 'on-toggle' : ''}`} aria-pressed={showPreview} onClick={() => setShowPreview((v) => !v)}><Icon name="eye" />プレビュー</button>
        <div className="editor-bar-end">
          {loaded.exists && <label className="inline-check small"><input type="checkbox" checked={notimestamp} onChange={(e) => setNotimestamp(e.target.checked)} /> タイムスタンプを変更しない</label>}
          <button className="btn" onClick={cancel}>キャンセル</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>

      {draftOffer && (
        <div className="banner">
          保存していない下書きがあります。
          <button className="btn sm" onClick={() => { if (mode === 'visual') loadIntoVisual(draftOffer); else setSource(draftOffer); setDirty(true); setDraftOffer(null); }}>復元する</button>
          <button className="btn sm ghost" onClick={() => { if (draftKey) local.del(draftKey); setDraftOffer(null); }}>破棄する</button>
        </div>
      )}

      {mode === 'visual' && editor && <Toolbar editor={editor} onLink={openLinkDialog} onFile={() => fileInput.current?.click()} onAi={() => setAiOpen(true)} />}
      <input ref={fileInput} type="file" hidden multiple onChange={(e) => { void pasteFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />

      <div className={`editor-split ${showPreview ? 'with-preview' : ''}`}>
        <div className="edit-canvas">
          {mode === 'visual'
            ? <><EditorContent editor={editor} /><SuggestPopup editor={editor} /></>
            : <SourceEditor value={source} onChange={(v) => { setSource(v); setDirty(true); }} onSave={save} />}
        </div>
        {showPreview && (
          <aside className="preview-pane" aria-label="プレビュー">
            <div className="preview-head">プレビュー（PukiWiki で描画）</div>
            {preview === null ? <div className="skeleton" /> : <div className="content" dangerouslySetInnerHTML={{ __html: preview }} />}
          </aside>
        )}
      </div>

      <div className="status-bar">
        {mode === 'visual' && <span>ビジュアル編集できるブロック {coverage.blocks - coverage.raw} / {coverage.blocks}</span>}
        {badChars.length > 0 && <span className="warnmsg">Wiki の文字コードで保存できない文字: {badChars.join(' ')}</span>}
        <span>{dirty ? '未保存の変更があります' : '変更なし'}</span>
        <span className="status-end">{loaded.exists ? '基にした版: 最新' : '新しいページ'} ・ <kbd>Ctrl</kbd>+<kbd>S</kbd> で保存</span>
      </div>

      {linkEdit && <LinkDialog init={linkEdit} onClose={() => setLinkEdit(null)} onApply={applyLink} onRemove={linkEdit.pos !== null ? () => {
        editor?.chain().focus().command(({ tr }) => { const n = tr.doc.nodeAt(linkEdit.pos as number); if (n) tr.replaceWith(linkEdit.pos as number, (linkEdit.pos as number) + n.nodeSize, editor.schema.text(n.attrs.label || n.attrs.target)); return true; }).run();
        setLinkEdit(null);
      } : undefined} />}
      {inlineEdit && (
        <RawInlineDialog raw={inlineEdit.raw} onClose={() => setInlineEdit(null)} onApply={(raw) => {
          editor?.chain().focus().command(({ tr }) => { tr.setNodeMarkup(inlineEdit.pos, undefined, { raw }); return true; }).run();
          setInlineEdit(null);
        }} />
      )}
      {aiOpen && <AiRewriteDialog wiki={app.wiki} page={page} getSelection={selectionSource} onClose={() => setAiOpen(false)} onApply={(t, inline) => { applyRewrite(t, inline); setAiOpen(false); }} />}
      {conflict && (
        <Modal title="他の人が先に更新しました" onClose={() => setConflict(null)} wide>
          {conflict.merged !== null ? (
            <>
              <p>あなたが編集を始めた後に、このページが更新されました。お互いの変更は重なっていないため、<strong>自動で統合できます</strong>。統合後の内容を確認してください（左: 最新の版、右: 統合後）。</p>
              <DiffView rows={quickRows(conflict.latest, conflict.merged)} leftLabel="最新の版" rightLabel="統合後" />
              <div className="dialog-actions">
                <button className="btn" onClick={() => setConflict(null)}>編集に戻る</button>
                <button className="btn primary" onClick={() => { const c = conflict; setConflict(null); setLoaded((l) => l && { ...l, source: c.latest, digest: c.latestDigest }); void doSave(c.merged as string, c.latestDigest); }}>統合して保存</button>
              </div>
            </>
          ) : (
            <>
              <p>同じ箇所が変更されているため、自動では統合できません。左が最新の版、右があなたの内容です。</p>
              <DiffView rows={quickRows(conflict.latest, conflict.mine)} leftLabel="最新の版" rightLabel="あなたの内容" />
              <div className="dialog-actions">
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(conflict.mine); app.toast('あなたの内容をコピーしました'); }}><Icon name="copy" />あなたの内容をコピー</button>
                <button className="btn" onClick={() => { const c = conflict; setConflict(null); setLoaded((l) => l && { ...l, source: c.latest, digest: c.latestDigest }); if (mode === 'visual') loadIntoVisual(c.latest); else setSource(c.latest); setDirty(false); }}>最新の版を読み込む</button>
                <button className="btn danger" onClick={() => { const c = conflict; setConflict(null); void doSave(c.mine, c.latestDigest); }}>自分の内容で上書き</button>
              </div>
            </>
          )}
        </Modal>
      )}
      {frozenPass && (
        <Modal title="ページが凍結されています" onClose={() => setFrozenPass(false)}>
          <p>編集中にページが凍結されました。内容をコピーしてから、凍結の解除を管理者に依頼してください。</p>
          <div className="dialog-actions"><button className="btn" onClick={() => { navigator.clipboard?.writeText(currentSource()); app.toast('コピーしました'); }}>内容をコピー</button><button className="btn primary" onClick={() => setFrozenPass(false)}>閉じる</button></div>
        </Modal>
      )}
    </main>
  );
}

function Toolbar({ editor, onLink, onFile, onAi }: { editor: Editor; onLink: () => void; onFile: () => void; onAi: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    editor.on('selectionUpdate', f);
    editor.on('transaction', f);
    return () => { editor.off('selectionUpdate', f); editor.off('transaction', f); };
  }, [editor]);
  const parent = editor.state.selection.$from.parent;
  const blockValue = parent.type.name === 'pkHeading' ? `h${parent.attrs.level}` : parent.type.name === 'pkList' ? (parent.attrs.kind === '+' ? 'ol' : 'ul') : parent.type.name === 'pkPre' ? 'pre' : 'p';
  const setBlock = (v: string) => {
    const c = editor.chain().focus();
    if (v === 'p') c.setNode('paragraph').run();
    else if (v.startsWith('h')) c.setNode('pkHeading', { level: Number(v[1]) }).run();
    else if (v === 'ul') c.setNode('pkList', { kind: '-', level: 1 }).run();
    else if (v === 'ol') c.setNode('pkList', { kind: '+', level: 1 }).run();
    else if (v === 'pre') c.setNode('pkPre').run();
  };
  const B = ({ icon, label, on, run, disabled }: { icon: string; label: string; on?: boolean; run: () => void; disabled?: boolean }) => (
    <button type="button" className={`icon-btn ${on ? 'on' : ''}`} aria-label={label} title={label} aria-pressed={on} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}><Icon name={icon} /></button>
  );
  const inTable = editor.isActive('table');
  return (
    <div className="toolbar" role="toolbar" aria-label="書式">
      <B icon="undo" label="元に戻す（Ctrl+Z）" run={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} />
      <B icon="redo" label="やり直す（Ctrl+Shift+Z）" run={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} />
      <span className="sep" aria-hidden="true" />
      <label className="sr" htmlFor="blk">段落の種類</label>
      <select id="blk" className="tb-select" value={blockValue} onChange={(e) => setBlock(e.target.value)}>
        <option value="p">本文</option><option value="h1">見出し 1（*）</option><option value="h2">見出し 2（**）</option><option value="h3">見出し 3（***）</option>
        <option value="ul">箇条書き（-）</option><option value="ol">番号付き（+）</option><option value="pre">整形済み</option>
      </select>
      <span className="sep" aria-hidden="true" />
      <B icon="bold" label="太字（''）Ctrl+B" on={editor.isActive('bold')} run={() => editor.chain().focus().toggleBold().run()} />
      <B icon="italic" label="斜体（'''）Ctrl+I" on={editor.isActive('italic')} run={() => editor.chain().focus().toggleItalic().run()} />
      <B icon="strike" label="取り消し線（%%）" on={editor.isActive('strike')} run={() => editor.chain().focus().toggleStrike().run()} />
      <B icon="under" label="下線（%%%）Ctrl+U" on={editor.isActive('underline')} run={() => editor.chain().focus().toggleUnderline().run()} />
      <B icon="link" label="リンク（[[ ]]）Ctrl+K" run={onLink} />
      <span className="sep" aria-hidden="true" />
      <B icon="ul" label="箇条書き" on={blockValue === 'ul'} run={() => setBlock(blockValue === 'ul' ? 'p' : 'ul')} />
      <B icon="ol" label="番号付きリスト" on={blockValue === 'ol'} run={() => setBlock(blockValue === 'ol' ? 'p' : 'ol')} />
      <B icon="code" label="整形済みテキスト" on={blockValue === 'pre'} run={() => setBlock(blockValue === 'pre' ? 'p' : 'pre')} />
      <B icon="table" label="表を挿入" run={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run()} />
      <B icon="hr" label="区切り線（----）" run={() => editor.chain().focus().insertContent({ type: 'pkHr', attrs: { raw: '----' } }).run()} />
      <B icon="image" label="画像・ファイルを添付して挿入" run={onFile} />
      <PluginMenu editor={editor} />
      {inTable && (
        <>
          <span className="sep" aria-hidden="true" />
          <button type="button" className="btn sm ghost" onClick={() => editor.chain().focus().addRowAfter().run()}>行を追加</button>
          <button type="button" className="btn sm ghost" onClick={() => editor.chain().focus().addColumnAfter().run()}>列を追加</button>
          <button type="button" className="btn sm ghost" onClick={() => editor.chain().focus().deleteRow().run()}>行を削除</button>
          <button type="button" className="btn sm ghost" onClick={() => editor.chain().focus().deleteColumn().run()}>列を削除</button>
          <button type="button" className="btn sm ghost" onClick={() => {
            const { $from } = editor.state.selection;
            for (let d = $from.depth; d > 0; d--) {
              const n = $from.node(d);
              if (n.type.name === 'tableRow') {
                const pos = $from.before(d);
                editor.chain().focus().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...n.attrs, fmt: n.attrs.fmt === 'h' ? '' : 'h' }); return true; }).run();
                break;
              }
            }
          }}>見出し行の切替</button>
        </>
      )}
      <span className="sep" aria-hidden="true" />
      <button type="button" className="btn sm ai" onMouseDown={(e) => e.preventDefault()} onClick={onAi}><Icon name="spark" />選択範囲を AI で</button>
    </div>
  );
}

function PluginMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const items = slashItems().filter((i) => i.group !== '基本');
  return (
    <div className="menu-wrap">
      <button type="button" className="icon-btn" aria-label="プラグインを挿入" title="プラグインを挿入" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}><Icon name="puzzle" /></button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button key={it.key} role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => {
              setOpen(false);
              const pos = editor.state.selection.from;
              it.run(editor, { from: pos, to: pos });
            }}><code>{it.hint}</code>{it.title}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestPopup({ editor }: { editor: Editor | null }) {
  const [s, setS] = useState<MenuState>(menuStore.state);
  useEffect(() => {
    const l = (x: MenuState) => setS(x);
    menuStore.listeners.add(l);
    return () => { menuStore.listeners.delete(l); };
  }, [editor]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }, [s.index]);
  if (!s.open || !s.rect || !s.items.length) return null;
  const top = Math.min(s.rect.bottom + 6, window.innerHeight - 320);
  const left = Math.min(s.rect.left, window.innerWidth - 360);
  let lastGroup = '';
  return (
    <div className="slash-menu" style={{ position: 'fixed', top, left }} role="listbox" aria-label={s.kind === 'slash' ? '挿入するブロック' : 'リンクするページ'} ref={listRef}>
      {s.items.map((it, i) => {
        const head = it.group !== lastGroup ? <h4 key={'g' + it.group}>{(lastGroup = it.group)}</h4> : null;
        return (
          <div key={it.key + i}>
            {head}
            <button type="button" role="option" aria-selected={i === s.index} className={`slash-item ${i === s.index ? 'sel' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); const cmd = menuStore.state.command; menuStore.set({ open: false }); cmd?.(it); }}>
              {it.icon && <span className="ico">{it.icon}</span>}
              <span className="slash-main"><strong>{it.title}</strong>{it.sub && <span className="sub">{it.sub}</span>}</span>
              {it.hint && <code>{it.hint}</code>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function LinkDialog({ init, onClose, onApply, onRemove }: { init: { label: string; target: string }; onClose: () => void; onApply: (label: string, target: string) => void; onRemove?: () => void }) {
  const app = useApp();
  const [target, setTarget] = useState(init.target);
  const [label, setLabel] = useState(init.label === init.target ? '' : init.label);
  const [sugg, setSugg] = useState<any[]>([]);
  useEffect(() => {
    if (!target || /^https?:/.test(target)) { setSugg([]); return; }
    const t = setTimeout(() => api<any[]>(`${wapi(app.wiki)}/suggest?q=${encodeURIComponent(target)}&limit=6`).then(setSugg).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [target, app.wiki]);
  return (
    <Modal title="リンク" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onApply(label, target); }}>
        <label>リンク先（ページ名または URL）<input className="input" value={target} onChange={(e) => setTarget(e.target.value)} autoFocus list="link-sugg" /></label>
        <datalist id="link-sugg">{sugg.map((s) => <option key={s.name} value={s.name} />)}</datalist>
        <label>表示する文字（省略するとリンク先を表示）<input className="input" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <div className="dialog-actions">
          {onRemove && <button type="button" className="btn ghost" onClick={onRemove}>リンクを外す</button>}
          <button type="button" className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn primary" disabled={!target.trim()}>適用</button>
        </div>
      </form>
    </Modal>
  );
}

function RawInlineDialog({ raw, onClose, onApply }: { raw: string; onClose: () => void; onApply: (raw: string) => void }) {
  const [v, setV] = useState(raw);
  return (
    <Modal title="インラインの記法" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onApply(v); }}>
        <label>PukiWiki 記法<input className="input mono" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></label>
        <p className="muted small">例: <code>&amp;color(red){'{'}文字{'}'};</code> <code>&amp;ref(画像.png);</code> <code>((注釈))</code></p>
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>キャンセル</button><button className="btn primary">適用</button></div>
      </form>
    </Modal>
  );
}

function AiRewriteDialog({ wiki, page, getSelection, onClose, onApply }: { wiki: string; page: string; getSelection: () => { text: string; inline: boolean } | null; onClose: () => void; onApply: (t: string, inline: boolean) => void }) {
  const sel = useMemo(getSelection, []); // eslint-disable-line
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const presets = ['読みやすく書き直す', '要約する', '箇条書きにする', '表にする', '敬体（です・ます）にそろえる', '誤字脱字を直す'];
  const run = async (ins: string) => {
    if (!sel) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ text: string }>(`${wapi(wiki)}/agent/rewrite`, { body: { instruction: ins, text: sel.text, page } });
      setResult(r.text);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="選択範囲を AI で書き換え" onClose={onClose} wide>
      {!sel ? <p>書き換えたい範囲を選択してから実行してください。</p> : (
        <div className="form">
          <div className="chips plain">{presets.map((p) => <button key={p} type="button" className="chip" disabled={busy} onClick={() => { setInstruction(p); void run(p); }}>{p}</button>)}</div>
          <form className="field-row" onSubmit={(e) => { e.preventDefault(); void run(instruction); }}>
            <label className="sr" htmlFor="ai-ins">指示</label>
            <input id="ai-ins" className="input" placeholder="指示を書く（例: 手順を番号付きにして）" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            <button className="btn ai-solid" disabled={busy || !instruction.trim()}>{busy ? '書き換え中…' : '実行'}</button>
          </form>
          {err && <p className="notice error">{err}</p>}
          {result !== null && <DiffView rows={quickRows(sel.text, result)} leftLabel="選択範囲" rightLabel="AI の案" />}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>キャンセル</button>
            <button type="button" className="btn primary" disabled={result === null} onClick={() => onApply(result as string, sel.inline)}>置き換える</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

