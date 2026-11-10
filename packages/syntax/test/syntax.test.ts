import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseBlocks, toEditorDoc, fromEditorDoc, parseInline, serializeInline,
  plainText, extractLinks, resolvePageLink, visualCoverage,
} from '../src/index.ts';

const SAMPLE = `#author("2026-10-13T04:56:12+00:00","","")
* サーバー障害対応記録 [#dff6883d]
** テンプレート [#i47388a5]
[[VPS/障害情報/テンプレート]]

*VPS一覧 [#be09de58]

 お名前ID: 1700986
 パスワード：xxxx

*** %%157.7.129.37%% [#m048cf11]
- %%VPS（KVM）2GBプラン%%
-- kodukadaishi.jp
+ 番号付き ''太字'' と '''斜体''' と %%%下線%%%
- [[VPS/157.7.196.44]]

|時刻|事象|h
|09:10|問い合わせ|
|LEFT:09:25|&color(red){再送};|

#ls2(VPS/){{
ignored body
}}
// comment line
----
- 項目
  続きの行
>引用
CENTER:中央
~明示的な段落
本文の行1~
本文の行2 ((注釈)) &br; &amp;
`;

test('blocks always concatenate back to the source', () => {
  for (const s of [SAMPLE, '', '\n\n', 'a', 'a\n', '* h\nno newline at end', '|a|b|\n|c|']) {
    assert.equal(parseBlocks(s).map((b) => b.src).join(''), s);
  }
});

test('unchanged editor document round-trips byte for byte', () => {
  for (const s of [SAMPLE, '', '\n\nx', 'a', '* h\nno newline at end', '- a\n- b']) {
    const { doc, meta } = toEditorDoc(s);
    assert.equal(fromEditorDoc(doc, meta), s);
  }
});

test('structured blocks are recognised', () => {
  const types = parseBlocks(SAMPLE).map((b) => b.node.type);
  assert.ok(types.includes('pkHeading'));
  assert.ok(types.includes('pkList'));
  assert.ok(types.includes('table'));
  assert.ok(types.includes('pkPre'));
  assert.ok(types.includes('pkPlugin'));
  assert.ok(types.includes('pkMeta'));
  assert.ok(types.includes('pkRaw')); // list continuation / quote / align
});

test('editing one block leaves the others untouched', () => {
  const { doc, meta } = toEditorDoc(SAMPLE);
  const blocks = doc.content as any[];
  const h = blocks.find((b) => b.type === 'pkHeading');
  h.content = [{ type: 'text', text: '変更した見出し' }];
  const out = fromEditorDoc(doc, meta);
  assert.ok(out.includes('* 変更した見出し [#dff6883d]\n'));
  assert.equal(out.replace('* 変更した見出し [#dff6883d]', '* サーバー障害対応記録 [#dff6883d]'), SAMPLE);
});

test('a new paragraph after a paragraph gets a separating blank line', () => {
  const src = 'first\n* h\n';
  const { doc, meta } = toEditorDoc(src);
  (doc.content as any[]).splice(1, 0, { type: 'paragraph', attrs: { lead: '' }, content: [{ type: 'text', text: 'second' }] });
  assert.equal(fromEditorDoc(doc, meta), 'first\n\nsecond\n* h\n');
});

test('inline round trip and marks', () => {
  for (const s of ["a ''b'' c", "''a'''b'''''", '%%x%% %%%y%%%', '[[A>B]] [[x:https://e.jp]]', 'x~\ny', '&size(12){大};', '((注))']) {
    assert.equal(serializeInline(parseInline(s)), s);
  }
  assert.throws(() => parseInline("''unclosed"));
});

test('plain text and links for the index', () => {
  const t = plainText(SAMPLE);
  assert.ok(t.includes('サーバー障害対応記録'));
  assert.ok(t.includes('再送'));
  assert.ok(!t.includes('#author'));
  const links = extractLinks('VPS', SAMPLE);
  assert.ok(links.includes('VPS/障害情報/テンプレート'));
  assert.ok(links.includes('VPS/157.7.196.44'));
  assert.equal(resolvePageLink('A/B/C', './D'), 'A/B/C/D');
  assert.equal(resolvePageLink('A/B/C', '../D'), 'A/B/D');
  assert.equal(resolvePageLink('A', 'X#anchor'), 'X');
});

// Optional corpus test: put real page sources (*.txt, UTF-8) in dev/corpus/
const corpus = join(import.meta.dirname, '../../../dev/corpus');
test('corpus round trip', { skip: !existsSync(corpus) }, () => {
  let files = 0, blocks = 0, raw = 0;
  for (const f of readdirSync(corpus).filter((n) => n.endsWith('.txt'))) {
    const s = readFileSync(join(corpus, f), 'utf8');
    const { doc, meta } = toEditorDoc(s);
    assert.equal(fromEditorDoc(doc, meta), s, f);
    const c = visualCoverage(s);
    files++; blocks += c.blocks; raw += c.raw;
  }
  console.log(`corpus: ${files} pages, ${blocks} blocks, visual ${(100 * (1 - raw / Math.max(blocks, 1))).toFixed(1)}%`);
});

import { renderMarkdown } from '../src/index.ts';

const MD = `* 前
#markdown()
# 見出し
* 項目 [#a1b2c3d4]
- [[保守/手順書|x]] と [[ラベル>保守/手順書]]

| a | b |
|---|---|
| 1 | 2 |
#endmarkdown()
後ろの段落
#markdown{{
## 古い形式
}}
`;

test('markdown blocks: recognised, round-trip, anchors hidden while editing', () => {
  const blocks = parseBlocks(MD);
  const md = blocks.filter((b) => b.node.type === 'pkMarkdown');
  assert.equal(md.length, 2);
  assert.equal(md[0].node.attrs?.style, 'region');
  assert.equal(md[1].node.attrs?.style, 'braces');
  assert.ok(!(md[0].node.content as any[])[0].text.includes('[#a1b2c3d4]'));
  const { doc, meta } = toEditorDoc(MD);
  assert.equal(fromEditorDoc(doc, meta), MD);
  // editing the markdown body writes the stripped text back (PukiWiki re-adds anchors itself)
  const node = (doc.content as any[]).find((n) => n.type === 'pkMarkdown');
  node.content = [{ type: 'text', text: '# 変更' }];
  assert.ok(fromEditorDoc(doc, meta).includes('#markdown()\n# 変更\n#endmarkdown()\n'));
  for (const s of ['#markdown()\n#endmarkdown()\n', '#markdown()\nno close', '#markdown()\n\n#endmarkdown()']) {
    const e = toEditorDoc(s);
    assert.equal(fromEditorDoc(e.doc, e.meta), s);
  }
});

test('markdown rendering: GFM tables, wiki links, escaped HTML, shifted headings', () => {
  const html = renderMarkdown('# T\n\n[[ラベル>保守/手順書]]\n\n| a |\n|---|\n| 1 |\n\n<script>x</script>', { pageHref: (p) => `/p/${p}` });
  assert.match(html, /<h2 id="md-1">T<\/h2>/);
  assert.match(html, /<a href="\/p\/保守\/手順書" data-kind="page">ラベル<\/a>/);
  assert.match(html, /<table>/);
  assert.ok(!html.includes('<script>'));
});
