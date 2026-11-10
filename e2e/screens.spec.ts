// Captures every main screen (desktop / mobile, light / dark) into e2e/screenshots
// and runs the layout checks on each.
import { test, expect } from '@playwright/test';
import { W, pageUrl, waitForIndex, assertNoLayoutBreak } from './helpers.ts';

const INCIDENT = '保守/障害対応/2026/11-05 メール配送遅延';
const SCREENS: { name: string; url: string; ready: string; action?: (p: import('@playwright/test').Page) => Promise<void> }[] = [
  { name: '00-dashboard', url: W, ready: '.cards.spaces .card' },
  { name: '01-page', url: pageUrl(INCIDENT), ready: 'article.content h2' },
  { name: '02-editor-visual', url: pageUrl(INCIDENT, 'mode=edit'), ready: '.edit-surface', action: async (p) => {
    await p.getByRole('button', { name: 'ビジュアル' }).click();
    await p.locator('.edit-surface h2').first().waitFor();
  } },
  { name: '03-editor-source', url: pageUrl(INCIDENT, 'mode=edit'), ready: '.editor-bar', action: async (p) => {
    await p.getByRole('button', { name: 'ソース' }).click();
    await p.locator('.cm-content').waitFor();
  } },
  { name: '04-editor-syntax-sample', url: pageUrl('試験/記法サンプル', 'mode=edit'), ready: '.editor-bar', action: async (p) => {
    await p.getByRole('button', { name: 'ビジュアル' }).click();
    await p.locator('.edit-surface .raw-block').first().waitFor();
  } },
  { name: '05-palette', url: W, ready: '.cards.spaces .card', action: async (p) => {
    await p.keyboard.press('Control+k');
    await p.getByRole('combobox').fill('メール');
    await p.locator('.p-item').first().waitFor();
  } },
  { name: '06-search', url: `${W}/search?q=${encodeURIComponent('メール')}`, ready: '.search-results li' },
  { name: '07-history', url: pageUrl(INCIDENT, 'tab=history'), ready: '.diff' },
  { name: '08-attachments', url: pageUrl(INCIDENT, 'tab=attachments'), ready: '.attach-list' },
  { name: '09-calendar', url: `${W}/calendar/${encodeURIComponent('山田')}?ym=2026-11`, ready: '.cal .entry' },
  { name: '10-ai-panel', url: pageUrl(INCIDENT), ready: 'article.content h2', action: async (p) => {
    await p.getByRole('button', { name: 'AI', exact: true }).click();
    await p.locator('.ai-panel').waitFor();
  } },
  { name: '11-new-page', url: `${W}/new?parent=${encodeURIComponent('保守/手順書')}`, ready: 'form.form' },
  { name: '12-syntax-sample', url: pageUrl('試験/記法サンプル'), ready: 'article.content h2' },
  { name: '13-admin', url: `${W}/admin`, ready: '.panel' },
  { name: '14-all-pages', url: `${W}/pages`, ready: '.cards.spaces .card' },
  { name: '15-markdown-page', url: pageUrl('試験/Markdown'), ready: '.markdown-body h2' },
  { name: '16-markdown-editor', url: pageUrl('試験/Markdown', 'mode=edit'), ready: '.editor-bar', action: async (p) => {
    await p.getByRole('button', { name: 'ビジュアル' }).click();
    await p.locator('.md-block .md-src').waitFor();
  } },
];

test.beforeAll(async ({ request }) => { await waitForIndex(request); });

for (const vp of [{ tag: 'desktop', width: 1440, height: 900 }, { tag: 'mobile', width: 390, height: 844 }]) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${vp.tag} ${theme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme });
      for (const s of SCREENS) {
        test(s.name, async ({ page }) => {
          const errors: string[] = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(s.url);
          await page.locator(s.ready).first().waitFor();
          if (s.action) await s.action(page);
          await page.waitForTimeout(300);
          await page.screenshot({ path: `e2e/screenshots/${vp.tag}-${theme}/${s.name}.png`, fullPage: true });
          await assertNoLayoutBreak(page, `${vp.tag} ${theme} ${s.name}`);
          expect(errors).toEqual([]);
        });
      }
    });
  }
}
