'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  VIEW_MODES,
  resolveColumnIndexes,
  extractSummary,
  findSummaryContainer,
  countExactLabelElements,
  mostFrequentSchedulePattern,
  extractAttendance,
} = require('../src/lib/extract.js');
const { aggregateAttendance, WARNING_CODES } = require('../src/lib/aggregate.js');
const { formatHoursMinutes } = require('../src/lib/time.js');
const { parseHtml } = require('../test-helpers/mini-dom.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'test-helpers', 'fixtures');

/**
 * フィクスチャを読み込んでフェイク document にする。
 *
 * @param {string} name
 * @returns {object}
 */
function loadFixture(name) {
  return parseHtml(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

/**
 * 抽出 → 集計を通した結果を返す（content.js がやることと同じ）。
 *
 * @param {object} doc
 * @param {number} [fallbackDailyMinutes]
 * @returns {{extracted: object, result: object}}
 */
function analyze(doc, fallbackDailyMinutes = 480) {
  const extracted = extractAttendance(doc);
  const result = aggregateAttendance(extracted.rows, {
    fallbackDailyMinutes,
    workedMinutesOverride: extracted.workedMinutesOverride,
  });
  return { extracted, result };
}

// ---------------------------------------------------------------------------
// 列インデックスの解決（見出しテキストのみに依存する）
// ---------------------------------------------------------------------------

test('resolveColumnIndexes: 検証済みの列構成', () => {
  const columns = resolveColumnIndexes([
    '日付',
    '勤務日種別',
    '勤務予定',
    '勤怠種別',
    '所定内',
    '時間外',
    '休憩',
    '総勤務',
  ]);
  assert.deepEqual(columns, {
    date: 0,
    dayType: 1,
    schedule: 2,
    attendanceType: 3,
    break: 6,
    worked: 7,
  });
});

test('resolveColumnIndexes: 列順が変わっても見出しから解決できる', () => {
  const columns = resolveColumnIndexes(['総勤務時間', '休憩時間', '勤務予定', '日付', '勤務日種別']);
  assert.equal(columns.worked, 0);
  assert.equal(columns.break, 1);
  assert.equal(columns.schedule, 2);
  assert.equal(columns.date, 3);
  assert.equal(columns.dayType, 4);
});

test('resolveColumnIndexes: 見つからない列は -1', () => {
  const columns = resolveColumnIndexes(['日付', '勤務日種別', '総勤務']);
  assert.equal(columns.schedule, -1);
  assert.equal(columns.break, -1);
});

// ---------------------------------------------------------------------------
// 標準ケース：実地検証済みの値を再現する
// ---------------------------------------------------------------------------

test('table-standard: 所定労働日 22 日 / 所定 176:00 / 総勤務 166:50 / 残り 9:10', () => {
  const { extracted, result } = analyze(loadFixture('table-standard.html'));

  assert.equal(extracted.viewMode, VIEW_MODES.TABLE);
  assert.equal(extracted.rows.length, 31);

  assert.equal(result.scheduledDays, 22);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '176:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '166:50');
  assert.equal(result.isOver, false);
  assert.equal(formatHoursMinutes(result.remainingMinutes), '9:10');
});

test('table-standard: freee 表示の「不足時間」と残り時間が一致する', () => {
  const { extracted, result } = analyze(loadFixture('table-standard.html'));

  assert.equal(extracted.summary.shortageMinutes, 550);
  assert.equal(result.remainingMinutes, extracted.summary.shortageMinutes);
});

test('table-standard: 半休・未入力日・休日の内訳', () => {
  const { result } = analyze(loadFixture('table-standard.html'));

  assert.equal(result.holidayDays, 9); // 所定休日 5（土 4 + 海の日）+ 法定休日 4
  assert.equal(result.workedDays, 20); // 通常 19 日 + 半休 1 日
  assert.equal(result.missingWorkedDays, 2);
  assert.equal(result.halfDayCount, 1);
  assert.deepEqual(result.warnings, [WARNING_CODES.MISSING_WORKED_ENTRIES]);
});

test('table-standard: 合計行は勤務日種別が無いので集計に混ざらない', () => {
  const doc = loadFixture('table-standard.html');
  const extracted = extractAttendance(doc);

  // 31 日分だけが rows に入り、合計行（総勤務 166:50）は除外されている。
  assert.equal(extracted.rows.length, 31);
  assert.equal(extracted.unknownRows.length, 0);
  assert.equal(
    extracted.rows.some((row) => row.dateLabel.includes('合計')),
    false
  );
});

test('table-standard: サマリーの表示値と期間ラベルを読み取れる', () => {
  const summary = extractSummary(loadFixture('table-standard.html'));

  assert.equal(summary.workedDaysCount, 20);
  assert.equal(summary.totalWorkedMinutes, 10010); // 166時間50分
  assert.equal(summary.shortageMinutes, 550); // 9時間10分
  assert.equal(summary.periodLabel, '2026年7月1日 〜 2026年7月31日 勤務分');
});

test('table-standard: カード挿入位置（サマリー領域）を特定できる', () => {
  const doc = loadFixture('table-standard.html');
  const container = findSummaryContainer(doc);

  assert.ok(container, 'サマリー領域が見つかること');
  const text = container.textContent;
  // 「労働日数」「総勤務時間」「不足時間」を含み、かつテーブル本体は含まない要素であること。
  assert.ok(text.includes('労働日数'));
  assert.ok(text.includes('総勤務時間'));
  assert.ok(text.includes('不足時間'));
  assert.equal(text.includes('勤務日種別'), false);
});

// ---------------------------------------------------------------------------
// その他のケース
// ---------------------------------------------------------------------------

test('table-holidays-only: 休日だけの期間は所定 0 日で警告を出す', () => {
  const { extracted, result } = analyze(loadFixture('table-holidays-only.html'));

  assert.equal(extracted.viewMode, VIEW_MODES.TABLE);
  assert.equal(extracted.rows.length, 10);
  assert.equal(result.scheduledDays, 0);
  assert.equal(result.scheduledMinutes, 0);
  assert.equal(result.workedMinutes, 0);
  assert.equal(result.remainingMinutes, 0);
  assert.ok(result.warnings.includes(WARNING_CODES.NO_SCHEDULED_WORKDAYS));
});

test('table-over-scheduled: 所定 160:00 に対して総勤務 165:30 なら 5:30 の超過', () => {
  const { result } = analyze(loadFixture('table-over-scheduled.html'));

  assert.equal(result.scheduledDays, 20);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '160:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '165:30');
  assert.equal(result.isOver, true);
  assert.equal(formatHoursMinutes(result.remainingMinutes), '5:30');
  assert.equal(result.missingWorkedDays, 0);
});

test('table-mixed-schedule: 勤務予定が混在する月は行単位で所定を合算する', () => {
  const { extracted, result } = analyze(loadFixture('table-mixed-schedule.html'));

  assert.equal(result.scheduledDays, 22);
  assert.equal(result.scheduleGroups.length, 2);
  assert.deepEqual(
    result.scheduleGroups.map((group) => [group.scheduleText, group.days, group.dailyMinutes]),
    [
      ['09:00-18:00', 15, 480],
      ['09:00-16:00', 7, 360],
    ]
  );
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '162:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '157:30');
  assert.equal(formatHoursMinutes(result.remainingMinutes), '4:30');
  assert.ok(result.warnings.includes(WARNING_CODES.MULTIPLE_SCHEDULES));

  // freee 表示の不足時間と一致する
  assert.equal(result.remainingMinutes, extracted.summary.shortageMinutes);
});

// ---------------------------------------------------------------------------
// カレンダー表示（テーブルが無い）
// ---------------------------------------------------------------------------

test('calendar-view: 日種別ラベルの個数とサマリーの総勤務時間から概算する', () => {
  const { extracted, result } = analyze(loadFixture('calendar-view.html'));

  assert.equal(extracted.viewMode, VIEW_MODES.GENERIC);
  assert.equal(extracted.workedMinutesOverride, 10010);
  assert.equal(extracted.schedulePatternHint, '09:00-18:00');

  assert.equal(result.scheduledDays, 22);
  // 休憩を各日に紐付けられないので、1 日の所定は設定のフォールバック値（8:00）を使う。
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '176:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '166:50');
  assert.equal(formatHoursMinutes(result.remainingMinutes), '9:10');
  assert.ok(result.warnings.includes(WARNING_CODES.WORKED_FROM_SUMMARY));
  assert.ok(result.warnings.includes(WARNING_CODES.FALLBACK_SCHEDULE_USED));
  // 行ごとの入力状況は分からないので未入力の警告は出さない
  assert.equal(result.missingWorkedDays, 0);
});

test('calendar-view: フォールバック値を設定で上書きすると所定が変わる', () => {
  const { result } = analyze(loadFixture('calendar-view.html'), 465); // 7:45
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '170:30');
});

test('countExactLabelElements: 完全一致なので説明文は数えない', () => {
  const doc = parseHtml(`
    <body>
      <span>所定労働日</span>
      <span>所定労働日</span>
      <p>所定労働日とは会社が定めた労働義務のある日です</p>
      <span>所定休日</span>
    </body>
  `);
  assert.equal(countExactLabelElements(doc.body, '所定労働日'), 2);
  assert.equal(countExactLabelElements(doc.body, '所定休日'), 1);
});

test('mostFrequentSchedulePattern: 最も多い勤務予定パターンを返す', () => {
  const doc = parseHtml(`
    <body>
      <span>09:00-18:00</span>
      <span>09:00-18:00</span>
      <span>10:00-19:00</span>
      <span>ラベル</span>
    </body>
  `);
  assert.equal(mostFrequentSchedulePattern(doc.body), '09:00-18:00');
  assert.equal(mostFrequentSchedulePattern(parseHtml('<body><span>a</span></body>').body), '');
});

// ---------------------------------------------------------------------------
// データが揃わない場合（誤った数字を出さない）
// ---------------------------------------------------------------------------

test('データが無い画面では unavailable を返す', () => {
  for (const html of [
    '<body></body>',
    '<body><div>読み込み中…</div></body>',
    // サマリーはあるが日種別が 1 つも無い（テーブルもカレンダーも描画前）
    '<body><section><span>総勤務時間</span><span>10時間0分</span><span>不足時間</span><span>1時間0分</span></section></body>',
  ]) {
    const extracted = extractAttendance(parseHtml(html));
    assert.equal(extracted.viewMode, VIEW_MODES.UNAVAILABLE);
    assert.equal(extracted.rows.length, 0);
  }
});

test('日数が 1 か月分として不自然なカレンダーは信頼せず unavailable にする', () => {
  // 「所定労働日」ラベルが 3 個しかない（描画途中）
  const cells = Array.from(
    { length: 3 },
    () => '<div><span>所定労働日</span><span>09:00-18:00</span></div>'
  ).join('');
  const doc = parseHtml(
    `<body><section><span>総勤務時間</span><span>166時間50分</span>` +
      `<span>不足時間</span><span>9時間10分</span></section>${cells}</body>`
  );
  assert.equal(extractAttendance(doc).viewMode, VIEW_MODES.UNAVAILABLE);
});

test('サマリーの総勤務時間が読めないカレンダー表示は unavailable にする', () => {
  const cells = Array.from(
    { length: 30 },
    () => '<div><span>所定労働日</span><span>09:00-18:00</span></div>'
  ).join('');
  assert.equal(extractAttendance(parseHtml(`<body>${cells}</body>`)).viewMode, VIEW_MODES.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// freee 側の変更への耐性
// ---------------------------------------------------------------------------

test('クラス名・DOM 階層が変わっても見出しテキストが同じなら集計できる', () => {
  // クラス名は総入れ替え、セルは div でラップ、列順も入れ替えたテーブル
  const doc = parseHtml(`
    <body>
      <main class="totally-different-2027">
        <table class="x1y2z3">
          <tr>
            <th><div><span>総勤務</span></div></th>
            <th><span>勤務日種別</span></th>
            <th>休憩</th>
            <th>勤務予定</th>
          </tr>
          <tr><td>8:00</td><td>所定労働日</td><td>1:00</td><td>09:00-18:00</td></tr>
          <tr><td>7:00</td><td>所定労働日</td><td>1:00</td><td>09:00-18:00</td></tr>
          <tr><td>-</td><td>法定休日</td><td>-</td><td>-</td></tr>
        </table>
      </main>
    </body>
  `);

  const { extracted, result } = analyze(doc);
  assert.equal(extracted.viewMode, VIEW_MODES.TABLE);
  assert.equal(result.scheduledDays, 2);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '16:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '15:00');
  assert.equal(formatHoursMinutes(result.remainingMinutes), '1:00');
});

test('未知の勤務日種別の行は集計に混ぜず、別に数える', () => {
  const doc = parseHtml(`
    <body>
      <table>
        <tr><th>日付</th><th>勤務日種別</th><th>勤務予定</th><th>休憩</th><th>総勤務</th></tr>
        <tr><td>07/01</td><td>所定労働日</td><td>09:00-18:00</td><td>1:00</td><td>8:00</td></tr>
        <tr><td>07/02</td><td>特別休暇日</td><td>-</td><td>-</td><td>-</td></tr>
      </table>
    </body>
  `);

  const extracted = extractAttendance(doc);
  assert.equal(extracted.rows.length, 1);
  assert.equal(extracted.unknownRows.length, 1);
  assert.equal(extracted.unknownRows[0].dayType, '特別休暇日');
});

test('勤務予定の列が無いテーブルではフォールバック値で計算する', () => {
  const doc = parseHtml(`
    <body>
      <table>
        <tr><th>日付</th><th>勤務日種別</th><th>総勤務</th></tr>
        <tr><td>07/01</td><td>所定労働日</td><td>7:00</td></tr>
        <tr><td>07/02</td><td>所定労働日</td><td>8:00</td></tr>
      </table>
    </body>
  `);

  const { result } = analyze(doc);
  assert.equal(result.scheduledDays, 2);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '16:00');
  assert.ok(result.warnings.includes(WARNING_CODES.FALLBACK_SCHEDULE_USED));
});
