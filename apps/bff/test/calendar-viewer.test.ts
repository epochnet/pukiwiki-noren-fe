// #calendar_viewer argument parsing and entry selection (PukiWiki 1.5.4 behaviour).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCvArgs, selectEntries, withNav, dateLabel, wikiToday } from '../src/pukiwiki/calendarViewer.ts';

const t = wikiToday(9);
const pad = (n: number) => String(n).padStart(2, '0');
const today = `${t.y}-${pad(t.m)}-${pad(t.d)}`;
const names = ['日報/2020-01-01', '日報/2020-01-15', '日報/2020-02-03', `日報/${today}`, '日報/2999-12-31', '日報/メモ', '日報/2020-01-01/子', '別/2020-01-01'];

test('parses arguments', () => {
  assert.deepEqual(parseCvArgs('#calendar_viewer(日報,5)', 'X', 9), { base: '日報', month: null, offset: 0, pitch: 5, mode: 'past', sep: '-' });
  assert.equal(parseCvArgs('#calendar_viewer(日報,5,future)', 'X', 9)!.mode, 'future');
  assert.deepEqual(parseCvArgs('#calendar_viewer(日報,2*3,view)', 'X', 9)!.offset, 2);
  assert.equal(parseCvArgs('#calendar_viewer(日報,2020-1)', 'X', 9)!.month, '2020-01');
  assert.equal(parseCvArgs('#calendar_viewer(,5)', '山田', 9)!.base, '山田');
  assert.equal(parseCvArgs('#calendar_viewer(./日報,5)', '山田', 9)!.base, '山田/日報');
  assert.equal(parseCvArgs('#comment()', 'X', 9), null);
});

test('past: today and older, newest first, paged', () => {
  const a = parseCvArgs('#calendar_viewer(日報,2)', 'X', 9)!;
  const r = selectEntries(a, names, 9);
  assert.equal(r.total, 4);
  assert.deepEqual(r.entries.map((e) => e.date), [today, '2020-02-03']);
  assert.deepEqual(selectEntries(withNav(a, '2'), names, 9).entries.map((e) => e.date), ['2020-01-15', '2020-01-01']);
});

test('future: today and later, oldest first', () => {
  const a = parseCvArgs('#calendar_viewer(日報,5,future)', 'X', 9)!;
  assert.deepEqual(selectEntries(a, names, 9).entries.map((e) => e.date), [today, '2999-12-31']);
});

test('month mode and month navigation', () => {
  const a = parseCvArgs('#calendar_viewer(日報,2020-01,view)', 'X', 9)!;
  assert.deepEqual(selectEntries(a, names, 9).entries.map((e) => e.date), ['2020-01-01', '2020-01-15']);
  assert.deepEqual(selectEntries(withNav(a, '2020-02'), names, 9).entries.map((e) => e.date), ['2020-02-03']);
});

test('date label with weekday', () => {
  assert.equal(dateLabel('2026-11-09', '-'), '2026/11/9 (月)');
});
