'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeText,
  isBlankValue,
  parseDurationToMinutes,
  parseClockToMinutes,
  parseScheduleRange,
  formatHoursMinutes,
} = require('../src/lib/time.js');

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------

test('normalizeText: 前後と内部の空白を落とす', () => {
  assert.equal(normalizeText('  09:00 - 18:00 '), '09:00-18:00');
});

test('normalizeText: 全角空白・改行・NBSP も空白として落とす', () => {
  assert.equal(normalizeText('　所定労働日\n '), '所定労働日');
});

test('normalizeText: 全角英数字と全角コロン・全角ハイフンを半角化する', () => {
  assert.equal(normalizeText('０９：００－１８：００'), '09:00-18:00');
});

test('normalizeText: 文字列以外は空文字', () => {
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '');
});

test('isBlankValue: 数字を含まない値は未入力扱い', () => {
  assert.equal(isBlankValue(''), true);
  assert.equal(isBlankValue('-'), true);
  assert.equal(isBlankValue('--:--'), true);
  assert.equal(isBlankValue('0:00'), false);
});

// ---------------------------------------------------------------------------
// parseDurationToMinutes
// ---------------------------------------------------------------------------

test('parseDurationToMinutes: H:MM 形式（24 時間を超える時数も可）', () => {
  assert.equal(parseDurationToMinutes('8:00'), 480);
  assert.equal(parseDurationToMinutes('1:00'), 60);
  assert.equal(parseDurationToMinutes('166:50'), 10010);
  assert.equal(parseDurationToMinutes('176:00'), 10560);
  assert.equal(parseDurationToMinutes('0:00'), 0);
});

test('parseDurationToMinutes: 負の値', () => {
  assert.equal(parseDurationToMinutes('-1:30'), -90);
});

test('parseDurationToMinutes: 日本語表記（サマリー由来）', () => {
  assert.equal(parseDurationToMinutes('9時間10分'), 550);
  assert.equal(parseDurationToMinutes('8時間'), 480);
  assert.equal(parseDurationToMinutes('50分'), 50);
  assert.equal(parseDurationToMinutes('0時間0分'), 0);
});

test('parseDurationToMinutes: 未入力・不正値は null', () => {
  assert.equal(parseDurationToMinutes(''), null);
  assert.equal(parseDurationToMinutes('   '), null);
  assert.equal(parseDurationToMinutes('-'), null);
  assert.equal(parseDurationToMinutes('--:--'), null);
  assert.equal(parseDurationToMinutes('時間分'), null);
  assert.equal(parseDurationToMinutes(null), null);
});

test('parseDurationToMinutes: 分が 60 以上のものは受け付けない', () => {
  assert.equal(parseDurationToMinutes('8:60'), null);
  assert.equal(parseDurationToMinutes('8:99'), null);
});

// ---------------------------------------------------------------------------
// parseClockToMinutes
// ---------------------------------------------------------------------------

test('parseClockToMinutes: 時刻を 0:00 起点の分に変換', () => {
  assert.equal(parseClockToMinutes('09:00'), 540);
  assert.equal(parseClockToMinutes('9:00'), 540);
  assert.equal(parseClockToMinutes('18:30'), 1110);
  assert.equal(parseClockToMinutes('00:00'), 0);
  assert.equal(parseClockToMinutes('23:59'), 1439);
});

test('parseClockToMinutes: 時刻としてありえない値は null', () => {
  assert.equal(parseClockToMinutes('24:00'), null);
  assert.equal(parseClockToMinutes('09:60'), null);
  assert.equal(parseClockToMinutes('9'), null);
  assert.equal(parseClockToMinutes(''), null);
});

// ---------------------------------------------------------------------------
// parseScheduleRange
// ---------------------------------------------------------------------------

test('parseScheduleRange: 標準的な勤務予定', () => {
  assert.deepEqual(parseScheduleRange('09:00-18:00'), {
    startMinutes: 540,
    endMinutes: 1080,
    spanMinutes: 540,
  });
});

test('parseScheduleRange: 空白入り・全角ハイフン・波ダッシュ区切り', () => {
  const expected = { startMinutes: 540, endMinutes: 1080, spanMinutes: 540 };
  assert.deepEqual(parseScheduleRange(' 09:00 - 18:00 '), expected);
  assert.deepEqual(parseScheduleRange('09:00－18:00'), expected);
  assert.deepEqual(parseScheduleRange('09:00〜18:00'), expected);
  assert.deepEqual(parseScheduleRange('09:00~18:00'), expected);
});

test('parseScheduleRange: 時短勤務の予定', () => {
  assert.deepEqual(parseScheduleRange('09:00-16:00'), {
    startMinutes: 540,
    endMinutes: 960,
    spanMinutes: 420,
  });
});

test('parseScheduleRange: 日跨ぎ勤務は終了に 24 時間を足す', () => {
  assert.deepEqual(parseScheduleRange('22:00-07:00'), {
    startMinutes: 1320,
    endMinutes: 1860,
    spanMinutes: 540,
  });
});

test('parseScheduleRange: 開始と終了が同じなら 0 分（24 時間勤務とは解釈しない）', () => {
  assert.equal(parseScheduleRange('09:00-09:00').spanMinutes, 0);
});

test('parseScheduleRange: 予定なし・不正値は null', () => {
  assert.equal(parseScheduleRange(''), null);
  assert.equal(parseScheduleRange('-'), null);
  assert.equal(parseScheduleRange('09:00'), null);
  assert.equal(parseScheduleRange('所定休日'), null);
  assert.equal(parseScheduleRange('09:00-'), null);
});

// ---------------------------------------------------------------------------
// 整形
// ---------------------------------------------------------------------------

test('formatHoursMinutes: 60 進表記', () => {
  assert.equal(formatHoursMinutes(10560), '176:00');
  assert.equal(formatHoursMinutes(10010), '166:50');
  assert.equal(formatHoursMinutes(550), '9:10');
  assert.equal(formatHoursMinutes(0), '0:00');
  assert.equal(formatHoursMinutes(-70), '-1:10');
});

test('整形関数: 数値でない入力は空文字（表示を壊さない）', () => {
  assert.equal(formatHoursMinutes(NaN), '');
  assert.equal(formatHoursMinutes(undefined), '');
  assert.equal(formatHoursMinutes(Infinity), '');
});
