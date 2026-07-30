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

test('標準ケースの表示内容（実績 / 所定 の 2 行）', () => {
  const model = modelFromFixture('table-standard.html');

  assert.equal(model.available, true);
  // 労働日数と総勤務時間の 2 行だけ。「所定労働日数」「所定労働時間」「所定まで残り」の
  // 独立行は分数の分母・meta の残り時間に統合したので出さない。
  assert.equal(model.rows.length, 2);
  assert.equal(rowOf(model, '労働日数').value, '20 日 / 22 日');
  assert.equal(rowOf(model, '労働日数').tone, 'remaining');
  assert.equal(rowOf(model, '総勤務時間').value, '166:50 / 176:00');
  assert.equal(rowOf(model, '総勤務時間').tone, 'remaining');

  assert.equal(rowOf(model, '所定労働日数'), undefined);
  assert.equal(rowOf(model, '所定労働時間'), undefined);
  assert.equal(rowOf(model, '所定まで残り'), undefined);
  assert.equal(rowOf(model, '所定を超過'), undefined);
});

test('標準ケース: 対象期間・残り時間・内訳を meta に表示する', () => {
  const model = modelFromFixture('table-standard.html');

  assert.ok(model.meta.includes('対象期間: 2026年7月1日 〜 2026年7月31日 勤務分'));
  // 分数だけだと残り時間が読み取りづらいので、日本語表記で補助的に出す。
  assert.ok(model.meta.includes('所定まで残り: 9時間10分'));
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

test('超過ケース: 総勤務時間が所定を超えていれば over の色で表示し、meta に超過分を出す', () => {
  const model = modelFromFixture('table-over-scheduled.html');

  assert.equal(rowOf(model, '総勤務時間').value, '165:30 / 160:00');
  assert.equal(rowOf(model, '総勤務時間').tone, 'over');
  // 労働日数は 20/20 で超過していない
  assert.equal(rowOf(model, '労働日数').value, '20 日 / 20 日');
  assert.equal(rowOf(model, '労働日数').tone, 'remaining');

  assert.ok(model.meta.includes('所定を超過: 5時間30分'));
});

test('休日のみのケース: 所定 0 でも 2 行の分数として崩れずに出す', () => {
  const model = modelFromFixture('table-holidays-only.html');

  assert.equal(rowOf(model, '労働日数').value, '0 日 / 0 日');
  assert.equal(rowOf(model, '総勤務時間').value, '0:00 / 0:00');
  assert.ok(model.notes.includes('この期間に所定労働日がありません。'));
  // 所定が 0 の月は残り時間の meta を出さない（意味がないため）
  assert.equal(
    model.meta.some((line) => line.startsWith('所定まで残り') || line.startsWith('所定を超過')),
    false
  );
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
  // content.js が渡すのと同じ経路（workedDaysOverride も含めて集計する）で処理する
  const doc = parseHtml(
    require('node:fs').readFileSync(
      require('node:path').join(FIXTURE_DIR, 'calendar-view.html'),
      'utf8'
    )
  );
  const extracted = extractAttendance(doc);
  const aggregate = aggregateAttendance(extracted.rows, {
    fallbackDailyMinutes: 480,
    workedMinutesOverride: extracted.workedMinutesOverride,
    workedDaysOverride: extracted.workedDaysOverride,
  });
  const model = buildCardModel({
    viewMode: extracted.viewMode,
    aggregate,
    summary: extracted.summary,
    schedulePatternHint: extracted.schedulePatternHint,
    unknownRowCount: extracted.unknownRows.length,
  });

  assert.equal(model.available, true);
  // 労働日数は行から数えられないのでサマリーの表示値（20日）を使う
  assert.equal(rowOf(model, '労働日数').value, '20 日 / 22 日');
  assert.equal(rowOf(model, '総勤務時間').value, '166:50 / 176:00');
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
