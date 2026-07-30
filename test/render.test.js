'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCardModel, BASIS_NOTE, UNAVAILABLE_MESSAGE } = require('../src/lib/render.js');
const { aggregateAttendance } = require('../src/lib/aggregate.js');
const { extractAttendance, VIEW_MODES } = require('../src/lib/extract.js');
const { parseHtml } = require('../test-helpers/mini-dom.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'test-helpers', 'fixtures');

/**
 * フィクスチャを content.js と同じ経路（抽出 → 集計 → 表示モデル）で処理する。
 *
 * @param {string} name
 * @param {number} [fallbackDailyMinutes]
 * @returns {object} カードの表示モデル
 */
function modelFromFixture(name, fallbackDailyMinutes = 480) {
  const doc = parseHtml(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  const extracted = extractAttendance(doc);
  const aggregate = aggregateAttendance(extracted.rows, {
    fallbackDailyMinutes,
    workedMinutesOverride: extracted.workedMinutesOverride,
  });
  return buildCardModel({
    viewMode: extracted.viewMode,
    aggregate,
    summary: extracted.summary,
    schedulePatternHint: extracted.schedulePatternHint,
    unknownRowCount: extracted.unknownRows.length,
  });
}

/**
 * @param {object} model
 * @param {string} label
 * @returns {object | undefined}
 */
function rowOf(model, label) {
  return model.rows.find((row) => row.label === label);
}

// ---------------------------------------------------------------------------
// 標準ケース
// ---------------------------------------------------------------------------

test('標準ケースの表示内容', () => {
  const model = modelFromFixture('table-standard.html');

  assert.equal(model.available, true);
  assert.equal(rowOf(model, '所定労働日数').value, '22 日');
  assert.equal(rowOf(model, '所定労働時間').value, '176:00');
  assert.equal(rowOf(model, '総勤務時間').value, '166:50');
  assert.equal(rowOf(model, '所定まで残り').value, '9:10（9時間10分）');
  assert.equal(rowOf(model, '所定まで残り').tone, 'remaining');
  assert.equal(rowOf(model, '所定を超過'), undefined);
});

test('標準ケース: 対象期間と内訳を表示する（表示月とのずれ対策）', () => {
  const model = modelFromFixture('table-standard.html');

  assert.ok(model.meta.includes('対象期間: 2026年7月1日 〜 2026年7月31日 勤務分'));
  assert.ok(model.meta.includes('内訳: 09:00-18:00（休憩 1:00）= 1日 8:00 × 22日'));
  assert.ok(model.meta.includes('freee 表示の「不足時間」と一致しています。'));
});

test('標準ケース: 未入力日の注意と基準の明記', () => {
  const model = modelFromFixture('table-standard.html');

  assert.ok(model.notes.includes('勤怠が未入力の所定労働日が 2 日あります。'));
  assert.ok(model.notes.includes(BASIS_NOTE));
  // 36 協定ベースの残業モニターと混同させない文言が必ず入っていること
  assert.ok(model.notes.some((note) => note.includes('残業モニター')));
});

// ---------------------------------------------------------------------------
// 超過・休日のみ・混在
// ---------------------------------------------------------------------------

test('超過ケース: ラベルを「所定を超過」に変え、符号を反転して表示する', () => {
  const model = modelFromFixture('table-over-scheduled.html');

  assert.equal(rowOf(model, '所定まで残り'), undefined);
  assert.equal(rowOf(model, '所定を超過').value, '5:30（5時間30分）');
  assert.equal(rowOf(model, '所定を超過').tone, 'over');
});

test('休日のみのケース: 所定労働日が無いことを伝える', () => {
  const model = modelFromFixture('table-holidays-only.html');

  assert.equal(rowOf(model, '所定労働日数').value, '0 日');
  assert.equal(rowOf(model, '所定労働時間').value, '0:00');
  assert.ok(model.notes.includes('この期間に所定労働日がありません。'));
});

test('勤務予定が混在するケース: 内訳を勤務予定ごとに並べる', () => {
  const model = modelFromFixture('table-mixed-schedule.html');

  assert.ok(model.meta.includes('内訳: 09:00-18:00（休憩 1:00）= 1日 8:00 × 15日'));
  assert.ok(model.meta.includes('内訳: 09:00-16:00（休憩 1:00）= 1日 6:00 × 7日'));
  assert.ok(
    model.notes.some((note) => note.includes('勤務予定が 2 種類あるため')),
    '勤務予定ごとに合算していることを伝える'
  );
});

// ---------------------------------------------------------------------------
// カレンダー表示（概算）
// ---------------------------------------------------------------------------

test('カレンダー表示: 概算であることと設定値を使っていることを明記する', () => {
  const model = modelFromFixture('calendar-view.html');

  assert.equal(model.available, true);
  assert.equal(rowOf(model, '所定労働時間').value, '176:00');
  assert.ok(model.meta.includes('内訳: 勤務予定 09:00-18:00 / 1日 8:00（設定値）× 22日'));
  assert.ok(
    model.notes.some((note) => note.includes('テーブル')),
    'テーブル表示ならより正確だと案内する'
  );
  assert.ok(
    model.notes.some((note) => note.includes('1 日 8:00 として計算')),
    'フォールバック値を使っていることを明記する'
  );
});

// ---------------------------------------------------------------------------
// データが取れない場合
// ---------------------------------------------------------------------------

test('データが取れない表示モードではフォールバック文言を出す', () => {
  const model = buildCardModel({ viewMode: VIEW_MODES.UNAVAILABLE, aggregate: null });

  assert.equal(model.available, false);
  assert.equal(model.message, UNAVAILABLE_MESSAGE);
  assert.ok(model.message.includes('テーブル'));
  assert.deepEqual(model.rows, []);
  // 基準の説明はデータが無いときも出す
  assert.ok(model.notes.includes(BASIS_NOTE));
});

// ---------------------------------------------------------------------------
// 個別の注意文言
// ---------------------------------------------------------------------------

test('freee の不足時間と差がある場合は注意を出す', () => {
  const aggregate = aggregateAttendance([
    { dayType: '所定労働日', scheduleText: '09:00-18:00', breakText: '1:00', workedText: '7:00' },
  ]);
  const model = buildCardModel({
    viewMode: VIEW_MODES.TABLE,
    aggregate,
    summary: { shortageMinutes: 30, periodLabel: '' },
  });

  assert.ok(
    model.notes.some((note) => note.includes('freee 表示の「不足時間」（0時間30分）と差があります')),
    '差分がある場合の注意文言'
  );
  assert.equal(model.meta.includes('freee 表示の「不足時間」と一致しています。'), false);
});

test('集計対象外の行があれば行数を伝える', () => {
  const aggregate = aggregateAttendance([
    { dayType: '所定労働日', scheduleText: '09:00-18:00', breakText: '1:00', workedText: '8:00' },
  ]);
  const model = buildCardModel({
    viewMode: VIEW_MODES.TABLE,
    aggregate,
    summary: {},
    unknownRowCount: 3,
  });

  assert.ok(model.notes.some((note) => note.includes('3 行あり、集計に含めていません')));
});

test('休日出勤を含む場合はその旨を伝える', () => {
  const aggregate = aggregateAttendance([
    { dayType: '所定労働日', scheduleText: '09:00-18:00', breakText: '1:00', workedText: '8:00' },
    { dayType: '法定休日', scheduleText: '', breakText: '', workedText: '3:00' },
  ]);
  const model = buildCardModel({ viewMode: VIEW_MODES.TABLE, aggregate, summary: {} });

  assert.ok(model.notes.includes('休日の勤務 3:00 も総勤務時間に含めています。'));
});
