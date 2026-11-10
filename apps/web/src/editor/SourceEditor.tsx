import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { keymap } from '@codemirror/view';

interface PState { inPlugin: string | null; inMd: boolean }

export const pukiwikiLanguage = StreamLanguage.define<PState>({
  name: 'pukiwiki',
  startState: () => ({ inPlugin: null, inMd: false }),
  token(stream, state) {
    if (stream.sol()) {
      if (state.inMd) {
        if (stream.match(/^#endmarkdown\(\)\s*$/)) { state.inMd = false; return 'keyword'; }
        if (stream.match(/^\s{0,3}#{1,6}\s.*/)) return 'heading';
        stream.skipToEnd();
        return 'string';
      }
      if (stream.match(/^#markdown\(\)\s*$/)) { state.inMd = true; return 'keyword'; }
      if (state.inPlugin) {
        if (stream.match(new RegExp(`^${state.inPlugin.replace(/\}/g, '\\}')}\\s*$`))) { state.inPlugin = null; return 'keyword'; }
        stream.skipToEnd();
        return 'string';
      }
      if (stream.match(/^\*{1,3}.*/)) return 'heading';
      if (stream.match(/^\/\/.*/)) return 'comment';
      const plug = stream.match(/^#[A-Za-z_]\w*/);
      if (plug) {
        const m = /(\{{2,})\s*$/.exec(stream.string);
        if (m) state.inPlugin = '}'.repeat(m[1].length);
        return 'keyword';
      }
      if (stream.match(/^-{4,}.*/)) return 'contentSeparator';
      if (stream.match(/^(-{1,3}|\+{1,3}|:|>{1,3}|<|LEFT:|CENTER:|RIGHT:)/)) return 'list';
      if (stream.peek() === ' ' || stream.peek() === '\t') { stream.skipToEnd(); return 'monospace'; }
    }
    if (stream.match(/^\[\[[^\]]*\]\]/)) return 'link';
    if (stream.match(/^&[A-Za-z_]\w*(\([^)]*\))?(\{[^}]*\})?;/)) return 'atom';
    if (stream.match(/^&#?\w+;/)) return 'atom';
    if (stream.match(/^'''|^''/)) return 'strong';
    if (stream.match(/^%%%?/)) return 'emphasis';
    if (stream.match(/^\(\(|^\)\)/)) return 'meta';
    if (stream.match('|')) return 'operator';
    if (stream.match(/^~$/)) return 'meta';
    stream.next();
    return null;
  },
});

export function SourceEditor({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          pukiwikiLanguage,
          EditorView.lineWrapping,
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { cb.current.onSave?.(); return true; } }]),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
          EditorView.contentAttributes.of({ 'aria-label': 'PukiWiki 記法のソース' }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external value replacement (e.g. switching from visual mode, conflict resolution)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="source-editor" ref={host} />;
}
