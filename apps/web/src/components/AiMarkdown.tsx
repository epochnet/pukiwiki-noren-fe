// Renders the AI assistant's answer as Markdown. Raw HTML is never rendered
// (html: false), and [[Page]] references become in-app links.
import { useMemo, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import MarkdownIt from 'markdown-it';
import { pagePath } from '../api.ts';
import { iconHtml } from './Icon.tsx';

function createMd(wiki: string) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

  // [[Page]], [[label>Page]], [[Page#anchor]]
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf(']]', start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || /[\n[\]]/.test(inner)) return false;
    if (!silent) {
      const target = (inner.includes('>') ? inner.slice(inner.indexOf('>') + 1) : inner).replace(/#.*$/, '').trim();
      const label = inner.includes('>') ? inner.slice(0, inner.indexOf('>')) : inner;
      const t = state.push('wikilink', '', 0);
      t.meta = { target: target || label, label };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, i) => {
    const { target, label } = tokens[i].meta as { target: string; label: string };
    const href = md.utils.escapeHtml(pagePath(wiki, target));
    return `<a class="cite" href="${href}" data-internal="1">${iconHtml('file')}${md.utils.escapeHtml(label)}</a>`;
  };

  // wide tables scroll inside the panel
  md.renderer.rules.table_open = () => '<div class="ai-table"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  // other links open in a new tab
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    tokens[i].attrSet('target', '_blank');
    tokens[i].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, i, opts, env, self);
  };
  return md;
}

export function AiMarkdown({ wiki, text }: { wiki: string; text: string }) {
  const navigate = useNavigate();
  const md = useMemo(() => createMd(wiki), [wiki]);
  const html = useMemo(() => md.render(text), [md, text]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[data-internal]') as HTMLAnchorElement | null;
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute('href')!);
  };
  return <div className="ai-text ai-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
