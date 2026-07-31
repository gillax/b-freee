'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildSummaryRowModel,
  summaryRowLabels,
  formatSummaryValue,
  SUMMARY_TOGGLE_LABELS,
} = require('../src/lib/render.js');
const { aggregateAttendance } = require('../src/lib/aggregate.js');
const { extractAttendance, readSummaryItems } = require('../src/lib/extract.js');
const { parseHtml } = require('../test-helpers/mini-dom.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'test-helpers', 'fixtures');

// ---------------------------------------------------------------------------
// サマリーのコピー行（並び替え + 折りたたみ）
// ---------------------------------------------------------------------------

/**
 * コピー行を content.js と同じ経路で組み立てる。
 *
 * @param {string} name - フィクスチャ名
 * @param {boolean} [collapsed]
 * @returns {object} コピー行の表示モデル
 */
function summaryRowFromFixture(name, collapsed = true) {
  const doc = parseHtml(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  const extracted = extractAttendance(doc);
  const aggregate = aggregateAttendance(extracted.rows, { fallbackDailyMinutes: 480 });
  return buildSummaryRowModel({
    aggregate,
    summaryItems: readSummaryItems(doc, summaryRowLabels()),
    collapsed,
  });
}

test('コピー行: 指定した並び順で、必要な項目だけを出す', () => {
  const model = summaryRowFromFixture('summary-full.html');

  // freee の並び（労働日数 / 総勤務時間 / 所定内労働 / 時間外労働 / 法定休日労働 /
  // 深夜労働 / 欠勤日数 / 有休取得数 / 有休残数 / 遅刻早退時間 / 不足時間）を組み替え、
  // 不足時間を 3 番目に繰り上げ、使わない項目は落とす。
  assert.deepEqual(
    model.items.map((item) => [item.label, item.value]),
    [
      ['労働日数', '2 日 / 3 日'],
      ['総勤務時間', '15:00 / 24:00'],
      ['不足時間', '9:00'],
      ['時間外労働', '0:00'],
      ['法定休日労働', '0:00'],
      ['深夜労働', '0:00'],
      ['有休取得数', '0.5日'],
    ]
  );
});

test('コピー行: 労働日数と総勤務時間は「実績 / 所定」を 1 行で出す', () => {
  const model = summaryRowFromFixture('summary-full.html');

  // 値は 1 つの文字列なので、freee 側のように 2 行に折り返されない。
  assert.equal(model.items[0].value, '2 日 / 3 日');
  assert.equal(model.items[0].tone, 'remaining');
  assert.equal(model.items[1].value, '15:00 / 24:00');
  // freee の表示値をそのまま出す項目は色を付けない
  assert.equal(model.items[2].tone, 'plain');
});

test('コピー行: 超過している項目は over の色にする', () => {
  const model = buildSummaryRowModel({
    aggregate: aggregateAttendance([
      { dayType: '所定労働日', scheduleText: '09:00-18:00', breakText: '1:00', workedText: '9:00' },
    ]),
    summaryItems: {},
  });

  assert.equal(model.items[0].label, '労働日数');
  assert.equal(model.items[0].tone, 'remaining'); // 1 日 / 1 日
  assert.equal(model.items[1].value, '9:00 / 8:00');
  assert.equal(model.items[1].tone, 'over');
});

test('コピー行: 折りたたみ状態でトグルの文言が変わる', () => {
  assert.equal(summaryRowFromFixture('summary-full.html', true).toggleLabel, SUMMARY_TOGGLE_LABELS.collapsed);
  assert.equal(summaryRowFromFixture('summary-full.html', false).toggleLabel, SUMMARY_TOGGLE_LABELS.expanded);
  assert.equal(summaryRowFromFixture('summary-full.html', true).collapsed, true);
});

test('コピー行: 集計できない画面では freee の表示値だけを並べ替える', () => {
  const model = buildSummaryRowModel({
    aggregate: null,
    summaryItems: { 労働日数: '21日', 総勤務時間: '175時間30分', 不足時間: '0時間30分' },
  });

  assert.deepEqual(
    model.items.map((item) => [item.label, item.value, item.tone]),
    [
      ['労働日数', '21日', 'plain'],
      ['総勤務時間', '175:30', 'plain'],
      ['不足時間', '0:30', 'plain'],
    ]
  );
});

test('コピー行: 1 項目も読めなければ空にする（content.js は元の表示を隠さない）', () => {
  assert.deepEqual(buildSummaryRowModel({ aggregate: null, summaryItems: {} }).items, []);
});

test('formatSummaryValue: 時間は H:MM に揃え、日数表記はそのまま返す', () => {
  assert.equal(formatSummaryValue('175時間30分'), '175:30');
  assert.equal(formatSummaryValue('0時間'), '0:00');
  assert.equal(formatSummaryValue('176:00'), '176:00');
  assert.equal(formatSummaryValue('0.5日'), '0.5日');
  assert.equal(formatSummaryValue('21日'), '21日');
});
