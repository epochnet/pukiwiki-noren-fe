// Markdown blocks written for the site's custom `#markdown` plugin.
//   #markdown()            … #endmarkdown()   (the form the plugin renders)
//   #markdown{{            … }}               (older form; the plugin ignores it)
// Rendering is shared by the BFF (page view / preview) and the editor (live preview).
import MarkdownIt from 'markdown-it';

/** PukiWiki appends " [#xxxxxxxx]" to lines starting with "*" on save; the plugin strips them again. */
const ANCHOR_LINE = /^(\*.*) \[#[a-zA-Z0-9]{8}\]/;

export function stripMdAnchors(body: string): string {
  return body.split('\n').map((l) => l.replace(ANCHOR_LINE, '$1')).join('\n');
}

export const MD_OPEN = /^#markdown\(\)\s*$/;
export const MD_CLOSE = /^#endmarkdown\(\)\s*$/;

export interface MarkdownRenderOptions {
  /** href for a wiki page referenced as [[Page]] / [[label>Page]] inside Markdown. */
  pageHref?: (page: string) => string;
}

let md: any = null;
function engine(): any {
  if (md) return md;
  md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  // headings one level down so they sit under the page title (h1 -> h2 …)
  md.core.ruler.push('noren_headings', (state: any) => {
    let n = 0;
    for (const t of state.tokens) {
      if (t.type === 'heading_open' || t.type === 'heading_close') {
        const lvl = Math.min(6, Number(t.tag.slice(1)) + 1);
        t.tag = `h${lvl}`;
        if (t.type === 'heading_open') t.attrSet('id', `md-${++n}`);
      }
    }
  });
  return md;
}

/** Render Markdown to (untrusted-input-safe) HTML; raw HTML in the source is escaped. */
export function renderMarkdown(text: string, opts: MarkdownRenderOptions = {}): string {
  const m = engine();
  // PukiWiki-style [[links]] are common inside these blocks: turn them into Markdown links
  const pre = stripMdAnchors(text).replace(/\[\[([^\]\n]+?)\]\]/g, (_all, inner: string) => {
    const gt = inner.indexOf('>');
    const label = gt >= 0 ? inner.slice(0, gt) : inner;
    const target = gt >= 0 ? inner.slice(gt + 1) : inner;
    if (/^(https?|mailto):/.test(target)) return `[${label}](${target})`;
    return `[${label.replace(/[[\]]/g, '')}](noren-page:${encodeURIComponent(target)})`;
  });
  const env = {};
  const tokens = m.parse(pre, env);
  for (const t of tokens) {
    for (const c of t.children ?? []) {
      if (c.type === 'link_open') {
        const href = c.attrGet('href') ?? '';
        if (href.startsWith('noren-page:')) {
          const page = decodeURIComponent(href.slice('noren-page:'.length));
          c.attrSet('href', opts.pageHref ? opts.pageHref(page) : '#');
          c.attrSet('data-kind', 'page');
        }
      }
    }
  }
  return m.renderer.render(tokens, m.options, env);
}
