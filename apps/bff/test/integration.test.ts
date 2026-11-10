// Integration tests against the local test PukiWiki (dev/pukiwiki-test, port 18090).
// Skipped automatically when it is not running. Never point this at a real wiki.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIKI = process.env.TEST_PUKIWIKI_URL ?? 'http://127.0.0.1:18090/';
let reachable = false;
try { reachable = (await fetch(WIKI, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* not running */ }

process.env.PUKIWIKI_URL = WIKI;
process.env.PUKIWIKI_ADMIN_PASSWORD = 'testpass';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'noren-test-'));
process.env.AGENT_ENABLED = 'false';

const { loadConfig } = await import('../src/config.ts');
const { api, createWikiCtx } = await import('../src/routes.ts');

const cfg = loadConfig();
const wikis = new Map([[cfg.wikis[0].id, createWikiCtx(cfg, cfg.wikis[0])]]);
const app = api(cfg, wikis);
const W = `/w/${cfg.wikis[0].id}`;
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'noren' };
const PAGE = `試験/結合テスト-${Date.now()}`;
const q = (p: string) => encodeURIComponent(p);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const opts = { skip: !reachable && 'test PukiWiki (dev/pukiwiki-test) is not running' };

before(async () => {
  if (reachable) await wikis.values().next().value!.driver.probe();
});

test('rejects writes without the CSRF header', opts, async () => {
  const res = await app.request(`${W}/page`, { method: 'PUT', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 403);
});

test('create, read, update, conflict', opts, async () => {
  let r = await call('PUT', `${W}/page`, { p: PAGE, source: '* 見出し\n本文です。\n', digest: '' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call('GET', `${W}/page/source?p=${q(PAGE)}`);
  assert.equal(r.status, 200);
  assert.match(r.json.source, /本文です。/);
  const digest = r.json.digest;
  r = await call('PUT', `${W}/page`, { p: PAGE, source: r.json.source + '- 追記\n', digest });
  assert.equal(r.status, 200);
  r = await call('PUT', `${W}/page`, { p: PAGE, source: 'old digest write\n', digest });
  assert.equal(r.status, 409);
  assert.match(r.json.error.details.latest_source, /追記/);
  r = await call('GET', `${W}/page?p=${q(PAGE)}`);
  assert.equal(r.json.exists, true);
  assert.match(r.json.html, /<h2 id="[^"]+">見出し/);
  assert.equal(r.json.toc[0].text.replace(/#$/, ''), '見出し');
});

test('unencodable characters are refused before writing', opts, async () => {
  const r = await call('PUT', `${W}/page`, { p: PAGE, source: '髙橋さん 🙂\n', digest: 'x' });
  assert.equal(r.status, 422);
});

test('preview renders through PukiWiki', opts, async () => {
  const r = await call('POST', `${W}/page/preview`, { p: PAGE, source: "''太字''\n" });
  assert.equal(r.status, 200);
  assert.match(r.json.html, /<strong>太字<\/strong>/);
});

test('history and diff', opts, async () => {
  let r = await call('GET', `${W}/page/history?p=${q(PAGE)}`);
  assert.ok(r.json.backups.length >= 1);
  const age = r.json.backups[r.json.backups.length - 1].age;
  r = await call('GET', `${W}/page/diff?p=${q(PAGE)}&from=${age}&to=current`);
  assert.ok(r.json.rows.some((x: any) => x.type === 'add' || x.type === 'mod'));
});

test('attachments: upload (admin password from config), list, open', opts, async () => {
  const fd = new FormData();
  fd.set('p', PAGE);
  fd.set('file', new File(['hello\n'], '手順メモ.txt', { type: 'text/plain' }));
  const res = await app.request(`${W}/attachments`, { method: 'POST', body: fd, headers: { 'X-Requested-With': 'noren' } });
  assert.equal(res.status, 200, await res.clone().text());
  const list = await call('GET', `${W}/attachments?p=${q(PAGE)}`);
  assert.ok(list.json.some((a: any) => a.file === '手順メモ.txt'));
  const raw = await app.request(`${W}/attachments/raw?page=${q(PAGE)}&file=${q('手順メモ.txt')}`);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), 'hello\n');
});

test('plugin form relay (#comment)', opts, async () => {
  let r = await call('GET', `${W}/page/source?p=${q(PAGE)}`);
  await call('PUT', `${W}/page`, { p: PAGE, source: r.json.source + '#comment\n', digest: r.json.digest });
  const page = await call('GET', `${W}/page?p=${q(PAGE)}`);
  const action = /data-pkwk-action="([^"]+)"/.exec(page.json.html)![1].replace(/&amp;/g, '&');
  const digest = /name="digest" value="([0-9a-f]+)"/.exec(page.json.html)![1];
  r = await call('POST', `${W}/forms`, {
    action, page: PAGE,
    fields: { plugin: 'comment', refer: PAGE, comment_no: '0', nodate: '0', above: '1', digest, name: 'テスト', msg: '中継コメント' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call('GET', `${W}/page/source?p=${q(PAGE)}`);
  assert.match(r.json.source, /中継コメント/);
});

test('freeze / unfreeze with the admin password', opts, async () => {
  let r = await call('POST', `${W}/page/freeze`, { p: PAGE, pass: 'wrong', freeze: true });
  assert.equal(r.status, 403);
  r = await call('POST', `${W}/page/freeze`, { p: PAGE, pass: 'testpass', freeze: true });
  assert.equal(r.status, 200);
  const src = await call('GET', `${W}/page/source?p=${q(PAGE)}`);
  assert.equal(src.json.frozen, true);
  r = await call('POST', `${W}/page/freeze`, { p: PAGE, pass: 'testpass', freeze: false });
  assert.equal(r.status, 200);
});

test('search, tree, related', opts, async () => {
  let r = await call('GET', `${W}/search?q=${q('中継コメント')}`);
  assert.ok(r.json.items.some((i: any) => i.name === PAGE));
  r = await call('GET', `${W}/tree?parent=${q('試験')}`);
  assert.ok(r.json.some((i: any) => i.name === PAGE));
});

test('rename and delete', opts, async () => {
  const to = PAGE + '-改名';
  let r = await call('POST', `${W}/page/rename`, { p: PAGE, to, pass: 'testpass' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call('GET', `${W}/page/source?p=${q(to)}`);
  assert.equal(r.json.exists, true);
  r = await call('PUT', `${W}/page`, { p: to, source: '', digest: r.json.digest });
  assert.equal(r.status, 200);
  r = await call('GET', `${W}/page?p=${q(to)}`);
  assert.equal(r.json.exists, false);
});
