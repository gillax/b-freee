'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DAY_TYPE_LABELS,
  isScheduledWorkday,
  isHoliday,
  modeOf,
  buildScheduleGroups,
  aggregateAttendance,
} = require('../src/lib/aggregate.js');
const { formatHoursMinutes } = require('../src/lib/time.js');

// ---------------------------------------------------------------------------
// テスト用の RowData ビルダ（extract.js が返すのと同じ形）
// ---------------------------------------------------------------------------

/**
 * @param {object} overrides
 * @returns {object} RowData
 */
function row(overrides = {}) {
  return {
    dayType: DAY_TYPE_LABELS.WORKDAY,
    scheduleText: '09:00-18:00',
    breakText: '1:00',
    workedText: '',
    ...overrides,
  };
}

/**
 * 同じ内容の行を n 行作る。
 *
 * @param {number} count
 * @param {object} overrides
 * @returns {object[]}
 */
function rows(count, overrides = {}) {
  return Array.from({ length: count }, () => row(overrides));
}

// ---------------------------------------------------------------------------
// 勤務日種別の判定
// ---------------------------------------------------------------------------

test('isScheduledWorkday: 所定労働日だけを true にする', () => {
  assert.equal(isScheduledWorkday('所定労働日'), true);
  assert.equal(isScheduledWorkday(' 所定労働日 '), true);
  assert.equal(isScheduledWorkday('所定休日'), false);
  assert.equal(isScheduledWorkday('法定休日'), false);
  assert.equal(isScheduledWorkday(''), false);
  assert.equal(isScheduledWorkday(undefined), false);
});

test('isHoliday: 所定休日・法定休日を true にする', () => {
  assert.equal(isHoliday('所定休日'), true);
  assert.equal(isHoliday('法定休日'), true);
  assert.equal(isHoliday('所定労働日'), false);
});

test('modeOf: 最頻値（同数なら小さい値）', () => {
  assert.equal(modeOf([60, 60, 45]), 60);
  assert.equal(modeOf([45, 60]), 45);
  assert.equal(modeOf([]), null);
});

// ---------------------------------------------------------------------------
// buildScheduleGroups — 1 日の所定は勤務予定 − 休憩
// ---------------------------------------------------------------------------

test('buildScheduleGroups: 09:00-18:00 / 休憩 1:00 なら 1 日 8:00', () => {
  const groups = buildScheduleGroups(rows(22), 480);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    scheduleText: '09:00-18:00',
    days: 22,
    breakMinutes: 60,
    dailyMinutes: 480,
    usedFallback: false,
  });
});

test('buildScheduleGroups: 休憩が未入力の行は同じ勤務予定の最頻値で補う', () => {
  const groups = buildScheduleGroups(
    [...rows(3, { breakText: '1:00' }), row({ breakText: '' })],
    480
  );
  assert.equal(groups[0].days, 4);
  assert.equal(groups[0].breakMinutes, 60);
  assert.equal(groups[0].dailyMinutes, 480);
});

test('buildScheduleGroups: 休憩が全行未入力なら 0 として扱う', () => {
  const groups = buildScheduleGroups(rows(2, { breakText: '' }), 480);
  assert.equal(groups[0].breakMinutes, 0);
  assert.equal(groups[0].dailyMinutes, 540);
});

test('buildScheduleGroups: 勤務予定が取れない行はフォールバック値を使う', () => {
  const groups = buildScheduleGroups(rows(3, { scheduleText: '', breakText: '' }), 480);
  assert.deepEqual(groups[0], {
    scheduleText: '',
    days: 3,
    breakMinutes: 0,
    dailyMinutes: 480,
    usedFallback: true,
  });
});

test('buildScheduleGroups: 勤務予定が混在する場合はグループごとに分ける（日数降順）', () => {
  const groups = buildScheduleGroups(
    [...rows(5, { scheduleText: '09:00-16:00' }), ...rows(15, { scheduleText: '09:00-18:00' })],
    480
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].scheduleText, '09:00-18:00');
  assert.equal(groups[0].days, 15);
  assert.equal(groups[0].dailyMinutes, 480);
  assert.equal(groups[1].scheduleText, '09:00-16:00');
  assert.equal(groups[1].days, 5);
  assert.equal(groups[1].dailyMinutes, 360); // 7:00 − 1:00
});

// ---------------------------------------------------------------------------
// aggregateAttendance — 実地検証済みのケース
// 所定労働日 22 日 / 勤務予定 09:00-18:00 / 休憩 1:00 / 総勤務合計 166:50
//   → 所定 176:00（freee 表示の「不足時間 9時間10分」と差が一致）
// ---------------------------------------------------------------------------

test('aggregateAttendance: 検証済みケース（22日・176:00・実績 166:50）', () => {
  const attendance = [
    // 通常勤務 19 日（8:30 = 510 分）
    ...rows(19, { workedText: '8:30' }),
    // 半休 1 日（実働 + 有休分が所定内に計上されて総勤務に乗るので特別扱いは不要）
    row({ workedText: '5:20' }),
    // これから入力する（未打刻の）所定労働日 2 日
    ...rows(2, { workedText: '' }),
    // 休日 9 日（所定休日 5・法定休日 4）は所定にも総勤務にも影響しない
    ...rows(5, { dayType: '所定休日', scheduleText: '', breakText: '', workedText: '' }),
    ...rows(4, { dayType: '法定休日', scheduleText: '', breakText: '', workedText: '' }),
  ];

  const result = aggregateAttendance(attendance, { fallbackDailyMinutes: 480 });

  assert.equal(result.scheduledDays, 22);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '176:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '166:50');
  assert.equal(result.workedDays, 20); // 未入力の 2 日は数えない
  // 所定 − 総勤務 = 9:10 は freee 表示の「不足時間 9時間10分」と一致する
  assert.equal(formatHoursMinutes(result.scheduledMinutes - result.workedMinutes), '9:10');
});

// ---------------------------------------------------------------------------
// aggregateAttendance — その他のケース
// ---------------------------------------------------------------------------

test('aggregateAttendance: 休日のみの月は所定 0 日', () => {
  const attendance = [
    ...rows(6, { dayType: '所定休日', scheduleText: '', breakText: '', workedText: '' }),
    ...rows(4, { dayType: '法定休日', scheduleText: '', breakText: '', workedText: '' }),
  ];

  const result = aggregateAttendance(attendance);

  assert.equal(result.scheduledDays, 0);
  assert.equal(result.scheduledMinutes, 0);
  assert.equal(result.workedMinutes, 0);
  assert.equal(result.workedDays, 0);
});

test('aggregateAttendance: 全日入力済みで所定を超過している月', () => {
  // 所定 20 日 × 8:00 = 160:00、総勤務 19 日 × 8:00 + 1 日 13:30 = 165:30
  const attendance = [
    ...rows(19, { workedText: '8:00' }),
    row({ workedText: '13:30' }),
    ...rows(8, { dayType: '所定休日', scheduleText: '', breakText: '', workedText: '' }),
  ];

  const result = aggregateAttendance(attendance);

  assert.equal(result.scheduledDays, 20);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '160:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '165:30');
  // 総勤務が所定を 5:30 上回る
  assert.equal(result.workedMinutes - result.scheduledMinutes, 330);
  assert.equal(result.workedDays, 20);
});

test('aggregateAttendance: 勤務予定が混在する月は行単位で所定を合算する', () => {
  // 通常 15 日 × 8:00 + 時短 5 日 × 6:00 = 150:00、総勤務 145:30 → 残り 4:30
  const attendance = [
    ...rows(15, { workedText: '8:00' }),
    ...rows(4, { scheduleText: '09:00-16:00', workedText: '6:00' }),
    row({ scheduleText: '09:00-16:00', workedText: '1:30' }),
  ];

  const result = aggregateAttendance(attendance);

  assert.equal(result.scheduledDays, 20);
  assert.equal(formatHoursMinutes(result.scheduledMinutes), '150:00');
  assert.equal(formatHoursMinutes(result.workedMinutes), '145:30');
  assert.equal(formatHoursMinutes(result.scheduledMinutes - result.workedMinutes), '4:30');
});

test('aggregateAttendance: 休日出勤も総勤務に含める（freee の不足時間と同じ挙動）', () => {
  const attendance = [
    ...rows(20, { workedText: '8:00' }),
    row({ dayType: '法定休日', scheduleText: '', breakText: '', workedText: '4:00' }),
  ];

  const result = aggregateAttendance(attendance);

  assert.equal(result.scheduledDays, 20);
  assert.equal(formatHoursMinutes(result.workedMinutes), '164:00');
  assert.equal(result.workedDays, 21);
});

test('aggregateAttendance: 勤務予定が取れない月はフォールバック値（既定 8:00）を使う', () => {
  const attendance = rows(10, { scheduleText: '', breakText: '', workedText: '8:00' });

  const withDefault = aggregateAttendance(attendance);
  assert.equal(formatHoursMinutes(withDefault.scheduledMinutes), '80:00');

  // 設定で 7:45 に上書きした場合
  const withOverride = aggregateAttendance(attendance, { fallbackDailyMinutes: 465 });
  assert.equal(formatHoursMinutes(withOverride.scheduledMinutes), '77:30');
});

test('aggregateAttendance: 空配列・不正入力でも例外を投げない', () => {
  for (const input of [[], null, undefined, 'nonsense', [null, undefined, 1]]) {
    const result = aggregateAttendance(input);
    assert.equal(result.scheduledDays, 0);
    assert.equal(result.scheduledMinutes, 0);
    assert.equal(result.workedMinutes, 0);
  }
});
