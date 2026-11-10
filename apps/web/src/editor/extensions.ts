// Tiptap schema mirroring packages/syntax (node names / attrs must match).
import { Extension, Node, nodeInputRule, textblockTypeInputRule } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactNodeViewRenderer } from '@tiptap/react';
import Document from '@tiptap/extension-document';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Strike from '@tiptap/extension-strike';
import Underline from '@tiptap/extension-underline';
import HardBreak from '@tiptap/extension-hard-break';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { UndoRedo, Dropcursor, Gapcursor, Placeholder, TrailingNode } from '@tiptap/extensions';
import { parseLinkInner } from '@syntax';
import { PluginView, RawView, MarkdownView } from './NodeViews.tsx';

const hidden = (d: unknown = null) => ({ default: d, rendered: false, keepOnSplit: false });
const blockMeta = () => ({ bid: hidden(), noFinalNewline: hidden(false) });

export const Paragraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  priority: 1000,
  addAttributes() { return { ...blockMeta(), lead: hidden('') }; },
  parseHTML() { return [{ tag: 'p' }]; },
  renderHTML({ HTMLAttributes }) { return ['p', HTMLAttributes, 0]; },
});

export const PkHeading = Node.create({
  name: 'pkHeading',
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return { ...blockMeta(), level: { default: 1, rendered: false }, space: hidden(' '), anchor: hidden(null) };
  },
  parseHTML() {
    return [
      { tag: 'h1', attrs: { level: 1 } }, { tag: 'h2', attrs: { level: 1 } }, { tag: 'h3', attrs: { level: 2 } },
      { tag: 'h4', attrs: { level: 3 } }, { tag: 'h5', attrs: { level: 3 } }, { tag: 'h6', attrs: { level: 3 } },
    ];
  },
  renderHTML({ node, HTMLAttributes }) { return [`h${Math.min(4, node.attrs.level + 1)}`, HTMLAttributes, 0]; },
  addInputRules() {
    return [textblockTypeInputRule({ find: /^(\*{1,3}|#{1,3})\s$/, type: this.type, getAttributes: (m) => ({ level: m[1].length }) })];
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-1': () => this.editor.commands.setNode(this.name, { level: 1 }),
      'Mod-Alt-2': () => this.editor.commands.setNode(this.name, { level: 2 }),
      'Mod-Alt-3': () => this.editor.commands.setNode(this.name, { level: 3 }),
      'Mod-Alt-0': () => this.editor.commands.setNode('paragraph'),
    };
  },
});

export const PkList = Node.create({
  name: 'pkList',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return { ...blockMeta(), kind: { default: '-', rendered: false }, level: { default: 1, rendered: false }, space: hidden(' ') };
  },
  parseHTML() {
    return [{ tag: 'div[data-pk-list]', getAttrs: (el) => ({ kind: (el as HTMLElement).dataset.pkList === '+' ? '+' : '-', level: Math.min(3, Math.max(1, Number((el as HTMLElement).dataset.level) || 1)) }) }];
  },
  renderHTML({ node }) {
    const k = node.attrs.kind === '+' ? 'plus' : 'minus';
    return ['div', { class: `pk-li pk-li-${k} l${node.attrs.level}`, 'data-pk-list': node.attrs.kind, 'data-level': node.attrs.level }, 0];
  },
  addInputRules() {
    return [textblockTypeInputRule({
      find: /^(-{1,3}|\+{1,3}|1\.)\s$/,
      type: this.type,
      getAttributes: (m) => (m[1] === '1.' ? { kind: '+', level: 1 } : { kind: m[1][0], level: m[1].length }),
    })];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('pkListNumbers'),
      props: {
        decorations(state) {
          const decos: Decoration[] = [];
          const counters = [0, 0, 0, 0];
          state.doc.forEach((node, pos) => {
            if (node.type.name !== 'pkList') { counters.fill(0); return; }
            const lv = Math.min(3, Math.max(1, node.attrs.level));
            for (let i = lv + 1; i <= 3; i++) counters[i] = 0;
            if (node.attrs.kind === '+') {
              counters[lv]++;
              decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-num': String(counters[lv]) }));
            } else counters[lv] = 0;
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
  addKeyboardShortcuts() {
    const inList = () => this.editor.state.selection.$from.parent.type.name === this.name;
    const attrs = () => this.editor.state.selection.$from.parent.attrs;
    return {
      Tab: () => inList() && this.editor.commands.updateAttributes(this.name, { level: Math.min(3, attrs().level + 1) }),
      'Shift-Tab': () => {
        if (!inList()) return false;
        if (attrs().level <= 1) return this.editor.commands.setNode('paragraph');
        return this.editor.commands.updateAttributes(this.name, { level: attrs().level - 1 });
      },
      Enter: () => {
        if (!inList()) return false;
        const { $from, empty } = this.editor.state.selection;
        if (empty && $from.parent.content.size === 0) return this.editor.commands.setNode('paragraph');
        const { kind, level, space } = attrs();
        return this.editor.chain().splitBlock().setNode(this.name, { kind, level, space }).run();
      },
      Backspace: () => {
        if (!inList()) return false;
        const { $from, empty } = this.editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        return this.editor.commands.setNode('paragraph');
      },
      'Mod-Shift-8': () => this.editor.commands.setNode(this.name, { kind: '-', level: 1 }),
      'Mod-Shift-7': () => this.editor.commands.setNode(this.name, { kind: '+', level: 1 }),
    };
  },
});

export const PkPre = Node.create({
  name: 'pkPre',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() { return { ...blockMeta(), prefixes: hidden('') }; },
  parseHTML() { return [{ tag: 'pre', preserveWhitespace: 'full' }]; },
  renderHTML() { return ['pre', { class: 'pk-pre' }, ['code', 0]]; },
  addInputRules() { return [textblockTypeInputRule({ find: /^```\s?$/, type: this.type })]; },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.exitCode() };
  },
});

export const PkRaw = Node.create({
  name: 'pkRaw',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() { return { ...blockMeta(), reason: { default: '', rendered: false } }; },
  parseHTML() { return [{ tag: 'div.pk-raw', preserveWhitespace: 'full', contentElement: 'pre' }]; },
  renderHTML() { return ['div', { class: 'pk-raw' }, ['pre', 0]]; },
  addNodeView() { return ReactNodeViewRenderer(RawView); },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.exitCode() };
  },
});

export const PkMarkdown = Node.create({
  name: 'pkMarkdown',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() {
    return {
      ...blockMeta(),
      style: { default: 'region', rendered: false },
      open: { default: '#markdown()', rendered: false },
      close: { default: '#endmarkdown()', rendered: false },
      origBody: hidden(null),
      origStripped: hidden(null),
      hasBody: hidden(false),
    };
  },
  parseHTML() { return [{ tag: 'div.pk-md', preserveWhitespace: 'full', contentElement: 'pre' }]; },
  renderHTML() { return ['div', { class: 'pk-md' }, ['pre', 0]]; },
  addNodeView() { return ReactNodeViewRenderer(MarkdownView); },
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => this.editor.commands.exitCode(),
      // indent with spaces inside Markdown (lists)
      Tab: () => this.editor.state.selection.$from.parent.type.name === this.name && this.editor.commands.insertContent('  '),
    };
  },
});

export const PkHr = Node.create({
  name: 'pkHr',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() { return { ...blockMeta(), raw: { default: '----', rendered: false } }; },
  parseHTML() { return [{ tag: 'hr' }]; },
  renderHTML() { return ['hr', { class: 'pk-hr' }]; },
  addInputRules() { return [nodeInputRule({ find: /^-{4}\s$/, type: this.type })]; },
});

const atomBlock = (name: string, view: boolean) => Node.create({
  name,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() { return { ...blockMeta(), raw: { default: '', rendered: false }, name: { default: '', rendered: false } }; },
  parseHTML() { return [{ tag: `div[data-${name}]`, getAttrs: (el) => ({ raw: (el as HTMLElement).dataset.raw ?? '' }) }]; },
  renderHTML({ node }) { return ['div', { [`data-${name}`]: '', 'data-raw': node.attrs.raw, class: name === 'pkMeta' ? 'pk-meta' : 'pk-atom' }, name === 'pkMeta' ? '' : node.attrs.raw]; },
  ...(view ? { addNodeView() { return ReactNodeViewRenderer(PluginView); } } : {}),
});

export const PkPlugin = atomBlock('pkPlugin', true);
export const PkComment = atomBlock('pkComment', true);
export const PkMeta = atomBlock('pkMeta', false);

export const PkLink = Node.create({
  name: 'pkLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { raw: { default: '', rendered: false }, label: { default: '', rendered: false }, target: { default: '', rendered: false } };
  },
  parseHTML() { return [{ tag: 'span[data-pk-link]', getAttrs: (el) => ({ raw: (el as HTMLElement).dataset.raw ?? '', ...parseLinkInner(((el as HTMLElement).dataset.raw ?? '').slice(2, -2)) }) }]; },
  renderHTML({ node }) {
    const ext = /^(https?|mailto):/.test(node.attrs.target);
    return ['span', { 'data-pk-link': '', 'data-raw': node.attrs.raw, class: `pk-link ${ext ? 'ext' : ''}`, title: node.attrs.target }, node.attrs.label || node.attrs.target];
  },
  addInputRules() {
    return [nodeInputRule({
      find: /\[\[([^\]\n]+)\]\]$/,
      type: this.type,
      getAttributes: (m) => ({ raw: m[0], ...parseLinkInner(m[1]) }),
    })];
  },
});

export const PkInline = Node.create({
  name: 'pkInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { raw: { default: '', rendered: false } }; },
  parseHTML() { return [{ tag: 'span[data-pk-inline]', getAttrs: (el) => ({ raw: (el as HTMLElement).dataset.raw ?? '' }) }]; },
  renderHTML({ node }) {
    const raw: string = node.attrs.raw;
    const base = { 'data-pk-inline': '', 'data-raw': raw, title: raw };
    const color = /^&color\(([#\w]+)(?:,([#\w]+))?\)\{(.*)\};$/.exec(raw);
    if (color) return ['span', { ...base, class: 'inline-chip styled', style: `color:${color[1]};${color[2] ? `background:${color[2]};` : ''}` }, color[3]];
    const size = /^&size\((\d{1,2})\)\{(.*)\};$/.exec(raw);
    if (size) return ['span', { ...base, class: 'inline-chip styled', style: `font-size:${Math.min(40, Number(size[1]))}px` }, size[2]];
    const nw = /^&new(?:\([^)]*\))?\{(.*)\};$/.exec(raw);
    if (nw) return ['span', { ...base, class: 'inline-chip' }, nw[1].replace(/ \(.\) /, ' ')];
    const ref = /^&ref\(([^,)]+)/.exec(raw);
    const label = ref ? `添付: ${ref[1]}` : raw.startsWith('((') ? `注: ${raw.slice(2, -2)}` : raw;
    return ['span', { ...base, class: 'inline-chip' }, label];
  },
});

const PkHardBreak = HardBreak.extend({
  addAttributes() { return { tilde: { default: true, rendered: false } }; },
  renderHTML({ node }) { return ['br', node.attrs.tilde ? {} : { class: 'soft' }]; },
});

const PkTable = Table.extend({ addAttributes() { return { ...this.parent?.(), ...blockMeta() }; } });
const PkTableRow = TableRow.extend({
  addAttributes() {
    return { ...this.parent?.(), fmt: { default: '', parseHTML: (el) => (el as HTMLElement).dataset.fmt ?? '', renderHTML: (a) => ({ 'data-fmt': a.fmt }) } };
  },
});
const cellExt = <T extends typeof TableCell>(base: T) => base.extend({
  content: 'inline*',
  addAttributes() { return { ...this.parent?.(), prefix: { default: '', rendered: false } }; },
});

/** Highlights characters that the wiki cannot store. */
export const BadCharsKey = new PluginKey<Set<string>>('badChars');
const BadChars = Extension.create({
  name: 'badChars',
  addProseMirrorPlugins() {
    return [new Plugin<Set<string>>({
      key: BadCharsKey,
      state: {
        init: () => new Set(),
        apply: (tr, v) => (tr.getMeta(BadCharsKey) as Set<string>) ?? v,
      },
      props: {
        decorations(state) {
          const chars = BadCharsKey.getState(state);
          if (!chars || !chars.size) return null;
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;
            let i = 0;
            for (const ch of node.text) {
              if (chars.has(ch)) decos.push(Decoration.inline(pos + i, pos + i + ch.length, { class: 'bad-char', title: 'Wiki の文字コードで保存できない文字' }));
              i += ch.length;
            }
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});

export function buildExtensions(extra: any[] = []) {
  return [
    Document,
    Text,
    Paragraph,
    PkHeading,
    PkList,
    PkPre,
    PkRaw,
    PkMarkdown,
    PkHr,
    PkPlugin,
    PkComment,
    PkMeta,
    PkLink,
    PkInline,
    PkHardBreak,
    Bold,
    Italic,
    Strike,
    Underline,
    PkTable.configure({ resizable: false }),
    PkTableRow,
    cellExt(TableCell),
    cellExt(TableHeader as unknown as typeof TableCell),
    UndoRedo,
    Dropcursor,
    Gapcursor,
    TrailingNode.configure({ node: 'paragraph' }),
    Placeholder.configure({ placeholder: '本文を入力（「/」でブロックやプラグインを挿入）', includeChildren: false }),
    BadChars,
    ...extra,
  ];
}

/** Flatten pasted HTML lists into PukiWiki-style list lines. */
export function flattenPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (list: Element, depth: number, out: string[]) => {
    const kind = list.tagName === 'OL' ? '+' : '-';
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      const clone = li.cloneNode(true) as Element;
      clone.querySelectorAll('ul,ol').forEach((n) => n.remove());
      out.push(`<div data-pk-list="${kind}" data-level="${Math.min(3, depth)}">${clone.innerHTML.replace(/<\/?p[^>]*>/g, '')}</div>`);
      for (const sub of Array.from(li.children)) if (sub.tagName === 'UL' || sub.tagName === 'OL') walk(sub, depth + 1, out);
    }
  };
  doc.body.querySelectorAll('ul,ol').forEach((list) => {
    if (list.parentElement?.closest('ul,ol')) return;
    const out: string[] = [];
    walk(list, 1, out);
    const wrap = doc.createElement('div');
    wrap.innerHTML = out.join('');
    list.replaceWith(...Array.from(wrap.childNodes));
  });
  doc.body.querySelectorAll('td p, th p').forEach((p) => p.replaceWith(...Array.from(p.childNodes)));
  return doc.body.innerHTML;
}
