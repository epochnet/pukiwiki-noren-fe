// PUKIWIKI_PUBLIC_URL: the BFF reaches the wiki by an internal URL, users get links to the public one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PukiWikiDriver } from '../src/pukiwiki/driver.ts';
import { rewriteHref } from '../src/pukiwiki/render.ts';
import type { WikiConfig } from '../src/config.ts';

const cfg = (url: string, publicUrl: string) => ({
  id: 'w', label: 'w', url, publicUrl, encoding: 'euc-jp', verifyTls: true, timeoutMs: 1000, concurrency: 1,
  markdownPlugin: 'auto', tzOffsetHours: 9, agent: { enabled: false, exclude: [], excludePatterns: [] }, hiddenPages: [],
}) as WikiConfig;

const d = new PukiWikiDriver(cfg('http://wiki-internal/', 'https://wiki.example.com/'));

test('classic links use the public URL', () => {
  assert.equal(rewriteHref(d, 'w', './?cmd=list').href, 'https://wiki.example.com/?cmd=list');
  assert.equal(rewriteHref(d, 'w', 'http://wiki-internal/?cmd=list').href, 'https://wiki.example.com/?cmd=list');
  assert.equal(rewriteHref(d, 'w', 'http://wiki-internal/').href, 'https://wiki.example.com/');
  assert.equal(d.publicUrlFor('FrontPage'), 'https://wiki.example.com/?FrontPage');
});

test('links by either URL are recognised as pages of this wiki', () => {
  assert.deepEqual(rewriteHref(d, 'w', 'http://wiki-internal/?FrontPage'), { href: '/w/w/p/FrontPage', kind: 'page' });
  assert.deepEqual(rewriteHref(d, 'w', 'https://wiki.example.com/?FrontPage'), { href: '/w/w/p/FrontPage', kind: 'page' });
  assert.equal(rewriteHref(d, 'w', 'https://other.example.com/?FrontPage').kind, 'external');
});

test('without a public URL, links use the wiki URL', () => {
  const d2 = new PukiWikiDriver(cfg('https://wiki.example.com/', 'https://wiki.example.com/'));
  assert.equal(rewriteHref(d2, 'w', './?cmd=list').href, 'https://wiki.example.com/?cmd=list');
});
