import { useEffect, useMemo, useState } from 'react';
import { renderMarkdown } from '@syntax';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { api, pagePath, wapi } from '../api.ts';
import { Icon } from '../components/Icon.tsx';

/** Set by the editor page so node views can reach the BFF. */
export const editorEnv = { wiki: '', page: '', markdown: false };

const cache = new Map<string, string>();

export function PluginView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const raw: string = node.attrs.raw;
  const isComment = node.type.name === 'pkComment';
  const [editing, setEditing] = useState(raw === '');
  const [draft, setDraft] = useState(raw);
  const [html, setHtml] = useState<string | null>(cache.get(raw) ?? null);
  const name = /^#([A-Za-z_]\w*)/.exec(raw)?.[1] ?? '';

  useEffect(() => {
    if (isComment || !raw || cache.has(raw)) { setHtml(cache.get(raw) ?? null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api<{ html: string }>(`${wapi(editorEnv.wiki)}/render-fragment`, { body: { p: editorEnv.page, source: raw + '\n' } })
        .then((r) => { cache.set(raw, r.html); if (alive) setHtml(r.html); })
        .catch(() => { if (alive) setHtml(''); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [raw, isComment]);

  const apply = () => {
    const v = draft.replace(/\n+$/, '');
    updateAttributes({ raw: v, name: /^#([A-Za-z_]\w*)/.exec(v)?.[1] ?? '' });
    setEditing(false);
    editor.commands.focus();
  };

  return (
    <NodeViewWrapper className={`block-plugin ${isComment ? 'is-comment' : ''} ${selected ? 'is-selected' : ''}`} data-drag-handle="">
      <div className="head" contentEditable={false}>
        <span>{isComment ? 'コメント（表示されません）' : 'プラグイン'}</span>
        {!isComment && <code>#{name}</code>}
        {!editing && <button type="button" className="btn sm" onClick={() => { setDraft(raw); setEditing(true); }}>{isComment ? '編集' : '引数を編集'}</button>}
      </div>
      {editing ? (
        <div contentEditable={false} className="plugin-edit">
          <label className="sr" htmlFor={`pe-${node.attrs.bid}`}>記法</label>
          <textarea id={`pe-${node.attrs.bid}`} className="input mono" value={draft} rows={Math.min(12, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } if (e.key === 'Escape') setEditing(false); }} />
          <div className="row-actions"><button type="button" className="btn sm primary" onClick={apply}>適用</button><button type="button" className="btn sm" onClick={() => setEditing(false)}>キャンセル</button></div>
        </div>
      ) : isComment ? (
        <pre className="plugin-raw" contentEditable={false}>{raw}</pre>
      ) : (
        <div className="plugin-preview content" contentEditable={false}>
          {html === null ? <span className="muted small">表示を読み込み中…</span>
            : html && (html.replace(/<[^>]+>/g, '').trim() || /<(img|hr|table|form|input)/.test(html)) ? <div dangerouslySetInnerHTML={{ __html: html }} />
            : <code className="muted">{raw}</code>}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export function RawView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="raw-block">
      <div className="head" contentEditable={false}>
        <Icon name="warn" /><strong>生の記法</strong>
        <span>{node.attrs.reason ? `ビジュアル編集できない書き方のため元のまま保持しています（${node.attrs.reason}）` : '元のまま保持しています'}</span>
      </div>
      <NodeViewContent<'pre'> as="pre" className="raw-pre" />
    </NodeViewWrapper>
  );
}

export function MarkdownView({ node, editor, getPos }: NodeViewProps) {
  const text = node.textContent;
  const [layout, setLayout] = useState<'split' | 'edit' | 'preview'>(() => (window.innerWidth < 900 ? 'edit' : 'split'));
  const [debounced, setDebounced] = useState(text);
  useEffect(() => { const t = setTimeout(() => setDebounced(text), 250); return () => clearTimeout(t); }, [text]);
  const html = useMemo(() => renderMarkdown(debounced, { pageHref: (p) => pagePath(editorEnv.wiki, p) }), [debounced]);
  // the block is only rendered by PukiWiki itself when the markdown plugin is installed
  const classicWarn = editorEnv.markdown ? '' : 'この Wiki には markdown プラグインが入っていないため、PukiWiki の画面では Markdown として表示されません';
  return (
    <NodeViewWrapper className={`md-block layout-${layout}`}>
      <div className="head" contentEditable={false}>
        <strong>Markdown</strong>
        <code>{node.attrs.open}</code>
        {classicWarn && <span className="md-warn" title={classicWarn}><Icon name="warn" />{classicWarn}</span>}
        <span className="seg md-seg" role="group" aria-label="Markdown の表示">
          {([['edit', '編集'], ['split', '左右'], ['preview', '表示']] as const).map(([k, l]) => (
            <button key={k} type="button" className={layout === k ? 'on' : ''} aria-pressed={layout === k} onMouseDown={(e) => e.preventDefault()} onClick={() => setLayout(k)}>{l}</button>
          ))}
        </span>
      </div>
      <div className="md-panes">
        <NodeViewContent<'pre'> as="pre" className="md-src" aria-label="Markdown のソース" />
        <div className="md-preview content markdown-body" contentEditable={false} dangerouslySetInnerHTML={{ __html: html || '<p class="muted">（空の Markdown ブロック）</p>' }} />
      </div>
    </NodeViewWrapper>
  );
}
