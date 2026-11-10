import { test, expect } from '@playwright/test';
import { W, pageUrl, waitForIndex, rawSource, writePage, assertNoLayoutBreak } from './helpers.ts';

const INCIDENT = '保守/障害対応/2026/11-05 メール配送遅延';
const errors: string[] = [];

test.beforeAll(async ({ request }) => { await waitForIndex(request); });
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
});
test.afterEach(() => { expect(errors, errors.join('\n')).toEqual([]); });

test('dashboard lists spaces and recent changes', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`${W}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/おはよう|こんにちは|お疲れさま/);
  await expect(page.locator('.cards.spaces .card').filter({ hasText: '保守' })).toBeVisible();
  await expect(page.locator('#h-recent')).toBeVisible();
  await assertNoLayoutBreak(page, 'dashboard');
});

test('page view: content, TOC, links, attachments, related', async ({ page }) => {
  await page.goto(pageUrl(INCIDENT));
  await expect(page.locator('.page-title')).toContainText('11-05 メール配送遅延');
  const content = page.locator('article.content');
  await expect(content.locator('h2', { hasText: '概要' })).toBeVisible();
  await expect(content.locator('table')).toContainText('配送遅延の問い合わせ');
  await expect(content.locator('img[src*="attachments/raw"]')).toBeVisible();
  await expect(page.locator('.rail .toc')).toContainText('経過');
  await expect(page.locator('.rail')).toContainText('mailq-1105.txt');
  // missing page link goes to the new-page flow
  await expect(content.locator('a.wikilink-missing', { hasText: 'キュー監視' })).toHaveAttribute('href', /\/new\?page=/);
  // backlinks
  await expect(page.locator('.related')).toContainText('このページへのリンク');
  await expect(page.locator('.related .card').filter({ hasText: '月次報告' })).toBeVisible();
  // sidebar tree highlights the page
  await expect(page.locator('.sidebar .tree-row.active')).toContainText('11-05 メール配送遅延');
  await assertNoLayoutBreak(page, 'page view');
  // internal link navigation stays in the SPA
  await content.locator('a', { hasText: '保守/手順書/メールサーバー設定' }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent('メールサーバー設定')));
  await expect(page.locator('.page-title')).toContainText('メールサーバー設定');
});

test('command palette search opens a page', async ({ page }) => {
  await page.goto(W);
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox');
  await input.fill('証明書');
  await expect(page.locator('.p-item').first()).toBeVisible();
  const hit = page.locator('.p-item').filter({ has: page.locator('.t', { hasText: /^保守\/手順書\/証明書の更新$/ }) });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.locator('.page-title')).toContainText('証明書の更新');
});

test('search page with filters', async ({ page }) => {
  await page.goto(`${W}/search?q=${encodeURIComponent('送信キュー')}`);
  await expect(page.locator('.search-title')).toContainText('送信キュー');
  await expect(page.locator('.search-results li').first()).toBeVisible();
  await expect(page.locator('.search-results mark').first()).toHaveText('送信キュー');
  await page.getByRole('button', { name: 'ページ名' }).click();
  await expect(page).toHaveURL(/in=title/);
  await assertNoLayoutBreak(page, 'search');
});

test('plugin form relay: #comment posts through the BFF', async ({ page, request }) => {
  await page.goto(pageUrl(INCIDENT));
  const msg = `E2E コメント ${Date.now()}`;
  const form = page.locator('article.content form').first();
  await form.locator('input[name="name"]').fill('E2E');
  await form.locator('input[name="msg"]').fill(msg);
  await form.locator('input[type="submit"]').click();
  await expect(page.locator('article.content')).toContainText(msg);
  expect(await rawSource(request, INCIDENT)).toContain(msg);
});

test('visual editor: opening and saving without changes keeps the source byte-identical', async ({ page, request }) => {
  const p = '試験/記法サンプル';
  const before = (await rawSource(request, p)).replace(/^#author.*\n/, '');
  await page.goto(pageUrl(p, 'mode=edit'));
  await page.getByRole('button', { name: 'ビジュアル' }).click();
  await expect(page.locator('.edit-surface')).toBeVisible();
  await expect(page.locator('.raw-block').first()).toBeVisible(); // quotes / dl stay raw
  // switching visual -> source -> visual must not alter anything either
  await page.getByRole('button', { name: 'ソース' }).click();
  await page.locator('.cm-content').waitFor();
  await page.getByRole('button', { name: 'ビジュアル' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent('記法サンプル') + '$'));
  const after = (await rawSource(request, p)).replace(/^#author.*\n/, '');
  expect(after).toBe(before);
});

test('visual editor: slash menu, typing, list, link autocomplete, save', async ({ page, request }) => {
  const p = `試験/E2E編集-${Date.now()}`;
  await writePage(request, p, '* 見出し\n最初の段落。\n');
  await page.goto(pageUrl(p, 'mode=edit'));
  await page.getByRole('button', { name: 'ビジュアル' }).click();
  const ed = page.locator('.edit-surface');
  await ed.locator('p', { hasText: '最初の段落。' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.keyboard.type('見出し 2');
  await expect(page.locator('.slash-item.sel')).toContainText('見出し 2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('手順');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- 一つ目');
  await page.keyboard.press('Enter');
  await page.keyboard.type('二つ目');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // leaves the list
  await page.keyboard.type('参照: [[証明書');
  await expect(page.locator('.slash-menu')).toContainText('保守/手順書/証明書の更新');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.page-title')).toContainText('E2E編集');
  const src = (await rawSource(request, p)).replace(/^#author.*\n/, '');
  expect(src).toContain('* 見出し');
  expect(src).toContain('最初の段落。');
  expect(src).toMatch(/\n\*\* 手順( \[#[\w-]+\])?\n/);
  expect(src).toContain('- 一つ目\n- 二つ目\n');
  expect(src).toContain('参照: [[保守/手順書/証明書の更新]]');
});

test('source editor and new page flow', async ({ page, request }) => {
  const name = `新規E2E-${Date.now()}`;
  await page.goto(`${W}/new?parent=${encodeURIComponent('試験')}`);
  await page.getByLabel('ページ名').fill(name);
  await page.getByRole('button', { name: '作成して編集' }).click();
  await page.getByRole('button', { name: 'ソース' }).click();
  const cm = page.locator('.cm-content');
  await cm.click();
  await page.keyboard.type("* ソースで作成\n''太字''の本文\n");
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.page-title')).toContainText(name);
  await expect(page.locator('article.content strong')).toHaveText('太字');
  expect(await rawSource(request, `試験/${name}`)).toContain("''太字''の本文");
  // the tree knows about it
  await expect(page.locator('.sidebar .tree-row.active')).toContainText(name);
});

test('conflict: concurrent edit is merged automatically when it does not overlap', async ({ page, request }) => {
  const p = `試験/E2E競合-${Date.now()}`;
  await writePage(request, p, '一行目\n\n二行目\n\n三行目\n');
  await page.goto(pageUrl(p, 'mode=edit'));
  await page.getByRole('button', { name: 'ソース' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('自分の追記\n');
  // someone else edits the first line meanwhile
  const cur = (await rawSource(request, p)).replace(/^#author.*\n/, '');
  await writePage(request, p, cur.replace('一行目', '一行目（他の人が変更）'));
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('dialog')).toContainText('自動で統合できます');
  await page.getByRole('button', { name: '統合して保存' }).click();
  await expect(page.locator('.page-title')).toContainText('E2E競合');
  const src = await rawSource(request, p);
  expect(src).toContain('一行目（他の人が変更）');
  expect(src).toContain('自分の追記');
});

test('history tab shows versions and a side-by-side diff', async ({ page }) => {
  await page.goto(pageUrl(INCIDENT, 'tab=history'));
  await expect(page.locator('.versions li').first()).toBeVisible();
  await expect(page.locator('.diff')).toBeVisible();
  await expect(page.locator('.diff .dl.add, .diff .dl.del').first()).toBeVisible();
  await assertNoLayoutBreak(page, 'history');
});

test('attachments tab lists files and uploads with the configured admin password', async ({ page }) => {
  await page.goto(pageUrl(INCIDENT, 'tab=attachments'));
  await expect(page.locator('.attach-list')).toContainText('構成図.png');
  await page.locator('.dropzone input[type=file]').setInputFiles({ name: 'e2e-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('e2e\n') });
  await expect(page.locator('.attach-list')).toContainText('e2e-upload.txt');
});

test('calendar shows daily pages', async ({ page }) => {
  await page.goto(`${W}/calendar/${encodeURIComponent('山田')}?ym=2026-11`);
  await expect(page.locator('.cal .entry')).toHaveCount(6);
  await assertNoLayoutBreak(page, 'calendar');
});

test('AI panel explains why it is disabled when no API key is configured', async ({ page }) => {
  await page.goto(pageUrl(INCIDENT));
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.locator('.ai-panel')).toContainText('ANTHROPIC_API_KEY');
  await expect(page.locator('.ai-panel')).toContainText('VPS');
});

test('old PukiWiki URLs redirect to the new UI', async ({ page }) => {
  await page.goto('/?' + '%CA%DD%BC%E9'); // EUC-JP "保守"
  await expect(page).toHaveURL(new RegExp(`${W}/p/${encodeURIComponent('保守')}$`));
});

test('mobile: menu toggle reveals the tree, no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(pageUrl(INCIDENT));
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'メニューを開く' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await assertNoLayoutBreak(page, 'mobile page');
});

test('markdown plugin: both forms render, content after #endmarkdown stays visible', async ({ page }) => {
  await page.goto(pageUrl('試験/Markdown'));
  const c = page.locator('article.content');
  await expect(c.locator('.markdown-body h2', { hasText: 'Markdown の見出し' })).toBeVisible();
  await expect(c.locator('.markdown-body table')).toContainText('列A');
  await expect(c.locator('.markdown-body a', { hasText: '保守/手順書/メールサーバー設定' })).toHaveAttribute('href', /\/w\/wiki\/p\//);
  await expect(c.locator('.markdown-body pre code.hljs')).toBeVisible();
  await expect(c).toContainText('この段落は旧 UI では隠れてしまう。');
  await expect(c).not.toContainText('#endmarkdown');
  await expect(page.locator('.rail .toc')).toContainText('Markdown の見出し');
  await page.goto(pageUrl('試験/Markdown旧形式'));
  await expect(page.locator('article.content .markdown-body h3')).toContainText('古い形式の見出し');
});

test('markdown plugin: edited in the visual editor with live preview, round-trips', async ({ page, request }) => {
  const p = `試験/MD編集-${Date.now()}`;
  const src = (await rawSource(request, '試験/Markdown')).replace(/^#author.*\n/, '');
  await writePage(request, p, src);
  const before = (await rawSource(request, p)).replace(/^#author.*\n/, '');
  // unchanged save keeps the source (including PukiWiki's auto anchors inside the block)
  await page.goto(pageUrl(p, 'mode=edit'));
  await page.getByRole('button', { name: 'ビジュアル' }).click();
  const block = page.locator('.md-block');
  await expect(block.locator('.md-preview h2')).toHaveText('Markdown の見出し');
  await expect(block.locator('.md-src')).not.toContainText('[#');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.page-title')).toContainText('MD編集');
  expect((await rawSource(request, p)).replace(/^#author.*\n/, '')).toBe(before);
  // edit the Markdown body
  await page.goto(pageUrl(p, 'mode=edit'));
  await page.getByRole('button', { name: 'ビジュアル' }).click();
  await block.locator('.md-src').click({ position: { x: 4, y: 12 } });
  await page.keyboard.press('Home');
  await page.keyboard.type('## 追加した見出し');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(block.locator('.md-preview h3').first()).toHaveText('追加した見出し');
  await page.keyboard.press('Control+s');
  await expect(page.locator('article.content .markdown-body h3').first()).toContainText('追加した見出し');
  const after = await rawSource(request, p);
  expect(after).toContain('#markdown()\n## 追加した見出し\n\n# Markdown の見出し');
  expect(after).toContain('#endmarkdown()\n** Markdown の後ろの見出し');
});

test('markdown plugin: slash menu inserts a block', async ({ page, request }) => {
  const p = `試験/MD挿入-${Date.now()}`;
  await writePage(request, p, '本文\n');
  await page.goto(pageUrl(p, 'mode=edit'));
  await page.getByRole('button', { name: 'ビジュアル' }).click();
  await page.locator('.edit-surface p', { hasText: '本文' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/markdown');
  await expect(page.locator('.slash-item.sel')).toContainText('Markdown ブロック');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md-block .md-preview li')).toHaveText('項目');
  await page.keyboard.press('Control+s');
  await expect(page.locator('article.content .markdown-body li')).toHaveText('項目');
  expect(await rawSource(request, p)).toContain('#markdown()\n## 見出し\n\n- 項目\n#endmarkdown()');
});
