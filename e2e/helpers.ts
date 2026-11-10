import { expect, type Page, type APIRequestContext } from '@playwright/test';

export const W = '/w/wiki';
export const pageUrl = (p: string, q = '') => `${W}/p/${p.split('/').map(encodeURIComponent).join('/')}${q ? '?' + q : ''}`;

/** Wait until the BFF finished its first full sync. */
export async function waitForIndex(request: APIRequestContext) {
  await expect.poll(async () => {
    const r = await request.get('/api/w/wiki/sync/status');
    const j = await r.json();
    return !j.running && j.pages > 5;
  }, { timeout: 60_000 }).toBe(true);
}

export async function rawSource(request: APIRequestContext, p: string): Promise<string> {
  const r = await request.get(`/api/w/wiki/page/raw?p=${encodeURIComponent(p)}`);
  return (await r.json()).source;
}

export async function writePage(request: APIRequestContext, p: string, source: string) {
  const s = await (await request.get(`/api/w/wiki/page/source?p=${encodeURIComponent(p)}`)).json();
  const r = await request.put('/api/w/wiki/page', {
    headers: { 'X-Requested-With': 'noren' },
    data: { p, source, digest: s.exists ? s.digest : '' },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
}

/** Layout sanity checks used on every screen. */
export async function assertNoLayoutBreak(page: Page, label: string) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${vw})`);
    const skip = (el: Element) => !!el.closest('.table-wrap, .diff, pre, .cm-editor, .tableWrapper, .source-view, .toolbar, .tabs, .palette-list, .slash-menu, .menu');
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed') continue;
      if (r.right > vw + 2 && !skip(el)) out.push(`overflows viewport: <${el.tagName.toLowerCase()} class="${(el as HTMLElement).className}"> right=${Math.round(r.right)}`);
      if (out.length > 8) break;
    }
    for (const img of Array.from(document.images)) {
      if (img.complete && img.naturalWidth === 0 && img.getBoundingClientRect().width > 0) out.push(`broken image: ${img.src}`);
    }
    return out;
  });
  expect(problems, `${label}: ${problems.join('\n')}`).toEqual([]);
}
