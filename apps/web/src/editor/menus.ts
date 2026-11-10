// "/" block menu and "[[" page-link autocomplete, bridged to React via a tiny store.
import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { linkRaw } from '@syntax';
import { api, wapi } from '../api.ts';
import { editorEnv } from './NodeViews.tsx';

export interface MenuItem { key: string; title: string; sub?: string; hint?: string; group: string; icon?: string; run: (editor: Editor, range: Range) => void }
export interface MenuState { open: boolean; kind: 'slash' | 'link'; items: MenuItem[]; index: number; rect: DOMRect | null; query: string; range: Range | null; command: ((item: MenuItem) => void) | null; loading: boolean }

type Listener = (s: MenuState) => void;
export const menuStore = {
  state: { open: false, kind: 'slash', items: [], index: 0, rect: null, query: '', range: null, command: null, loading: false } as MenuState,
  listeners: new Set<Listener>(),
  set(patch: Partial<MenuState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  },
};

const setBlock = (type: string, attrs: Record<string, unknown> = {}) => (e: Editor, r: Range) => e.chain().focus().deleteRange(r).setNode(type, attrs).run();
const insertPlugin = (raw: string) => (e: Editor, r: Range) =>
  e.chain().focus().deleteRange(r).insertContent({ type: 'pkPlugin', attrs: { raw, name: /^#(\w+)/.exec(raw)?.[1] ?? '' } }).run();

export function slashItems(): MenuItem[] {
  const page = editorEnv.page;
  return [
    { key: 'h1', group: '基本', icon: 'H1', title: '見出し 1', sub: 'セクションの見出し', hint: '*', run: setBlock('pkHeading', { level: 1 }) },
    { key: 'h2', group: '基本', icon: 'H2', title: '見出し 2', sub: '小見出し', hint: '**', run: setBlock('pkHeading', { level: 2 }) },
    { key: 'h3', group: '基本', icon: 'H3', title: '見出し 3', sub: 'さらに小さな見出し', hint: '***', run: setBlock('pkHeading', { level: 3 }) },
    { key: 'ul', group: '基本', icon: '•', title: '箇条書き', sub: '項目を並べる', hint: '-', run: setBlock('pkList', { kind: '-', level: 1 }) },
    { key: 'ol', group: '基本', icon: '1.', title: '番号付きリスト', sub: '順番のある項目', hint: '+', run: setBlock('pkList', { kind: '+', level: 1 }) },
    { key: 'table', group: '基本', icon: '⊞', title: '表', sub: '3 × 3 の表', hint: '|', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run() },
    { key: 'pre', group: '基本', icon: '{}', title: '整形済みテキスト', sub: 'コマンドやログ（等幅）', hint: '行頭スペース', run: setBlock('pkPre') },
    { key: 'hr', group: '基本', icon: '—', title: '区切り線', hint: '----', run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'pkHr', attrs: { raw: '----' } }).run() },
    ...(!editorEnv.markdown ? [] : [{ key: 'markdown', group: '基本', icon: 'M↓', title: 'Markdown ブロック', sub: '#markdown() 〜 #endmarkdown()', hint: '#markdown', run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'pkMarkdown', attrs: { style: 'region', open: '#markdown()', close: '#endmarkdown()' }, content: [{ type: 'text', text: '## 見出し\n\n- 項目' }] }).run() }] as MenuItem[]),
    { key: 'raw', group: '基本', icon: '#', title: '生の記法', sub: 'PukiWiki 記法をそのまま書く', run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'pkRaw', attrs: { reason: '' } }).run() },
    { key: 'contents', group: 'PukiWiki プラグイン', icon: '#', title: '目次', sub: 'このページの見出し一覧', hint: '#contents', run: insertPlugin('#contents') },
    { key: 'ls2', group: 'PukiWiki プラグイン', icon: '#', title: '子ページ一覧', sub: '配下のページを並べる', hint: '#ls2', run: insertPlugin(`#ls2(${page}/)`) },
    { key: 'comment', group: 'PukiWiki プラグイン', icon: '#', title: 'コメント欄', sub: '閲覧者がコメントを書ける', hint: '#comment', run: insertPlugin('#comment') },
    { key: 'pcomment', group: 'PukiWiki プラグイン', icon: '#', title: 'コメント欄（別ページ保存）', hint: '#pcomment', run: insertPlugin('#pcomment') },
    { key: 'calendar', group: 'PukiWiki プラグイン', icon: '#', title: 'カレンダー', sub: '日付ページの一覧', hint: '#calendar_viewer', run: insertPlugin(`#calendar_viewer(${page},this)`) },
    { key: 'include', group: 'PukiWiki プラグイン', icon: '#', title: '他のページを埋め込む', hint: '#include', run: insertPlugin('#include(ページ名)') },
    { key: 'vote', group: 'PukiWiki プラグイン', icon: '#', title: '投票', hint: '#vote', run: insertPlugin('#vote(選択肢1,選択肢2)') },
    { key: 'article', group: 'PukiWiki プラグイン', icon: '#', title: '掲示板', hint: '#article', run: insertPlugin('#article') },
    { key: 'ref', group: 'PukiWiki プラグイン', icon: '#', title: '添付ファイルを表示', hint: '#ref', run: insertPlugin('#ref(ファイル名)') },
    { key: 'clear', group: 'PukiWiki プラグイン', icon: '#', title: '回り込み解除', hint: '#clear', run: insertPlugin('#clear') },
    { key: 'note', group: 'インライン', icon: '((', title: '注釈', hint: '((…))', run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'pkInline', attrs: { raw: '((注釈))' } }).run() },
  ];
}

function filter(items: MenuItem[], q: string): MenuItem[] {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, '');
  const s = norm(q);
  if (!s) return items;
  return items.filter((i) => norm(i.title).includes(s) || i.key.includes(s) || norm(i.hint ?? '').includes(s) || norm(i.sub ?? '').includes(s));
}

const render = (kind: MenuState['kind']) => () => ({
  onBeforeUpdate: () => menuStore.set({ loading: true }),
  onStart: (p: any) => menuStore.set({ open: true, kind, items: p.items, index: 0, rect: p.clientRect?.() ?? null, query: p.query, range: p.range, command: p.command, loading: false }),
  onUpdate: (p: any) => menuStore.set({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, query: p.query, range: p.range, command: p.command, loading: false }),
  onExit: () => menuStore.set({ open: false, items: [], range: null, command: null, loading: false }),
  onKeyDown: ({ event }: { event: KeyboardEvent }) => {
    const s = menuStore.state;
    if (!s.open) return false;
    if (event.key === 'ArrowDown') { menuStore.set({ index: Math.min(s.index + 1, s.items.length - 1) }); return true; }
    if (event.key === 'ArrowUp') { menuStore.set({ index: Math.max(s.index - 1, 0) }); return true; }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // results for the latest query are still loading: swallow the key instead of acting on stale ones
      if (s.loading) return true;
      if (!s.items.length || !s.command) return false;
      menuStore.set({ open: false });
      s.command(s.items[s.index]);
      return true;
    }
    if (event.key === 'Escape') { menuStore.set({ open: false }); return true; }
    return false;
  },
});

export const SlashMenu = Extension.create({
  name: 'slashMenu',
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      pluginKey: new PluginKey('slashMenu'),
      char: '/',
      startOfLine: true,
      allowSpaces: true,
      allow: ({ state, range }) => {
        const $from = state.doc.resolve(range.from);
        return ['paragraph'].includes($from.parent.type.name);
      },
      items: ({ query }) => filter(slashItems(), query).slice(0, 30),
      command: ({ editor, range, props }) => (props as MenuItem).run(editor, range),
      render: render('slash'),
    })];
  },
});

let linkCtrl: AbortController | null = null;
export const LinkMenu = Extension.create({
  name: 'linkMenu',
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      pluginKey: new PluginKey('linkMenu'),
      char: '[[',
      allowSpaces: true,
      allowedPrefixes: null,
      items: async ({ query }) => {
        linkCtrl?.abort();
        linkCtrl = new AbortController();
        const q = query.replace(/\]+$/, '');
        const make = (name: string, sub?: string): MenuItem => ({
          key: name, group: 'ページ', title: name, sub,
          run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: 'pkLink', attrs: { raw: linkRaw(name, name), label: name, target: name } }).insertContent(' ').run(),
        });
        try {
          const rows = q ? await api<any[]>(`${wapi(editorEnv.wiki)}/suggest?q=${encodeURIComponent(q)}&limit=8`, { signal: linkCtrl.signal }) : [];
          const items = rows.map((r) => make(r.name, r.space));
          if (q && !rows.some((r) => r.name === q)) items.push({ ...make(q, '新しいページへのリンク'), key: '__new' });
          return items;
        } catch { return []; }
      },
      command: ({ editor, range, props }) => (props as MenuItem).run(editor, range),
      render: render('link'),
    })];
  },
});
