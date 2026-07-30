/**
 * aggregate.js — 勤怠行データの集計（純粋関数のみ）
 *
 * 入力は extract.js が DOM から取り出した RowData の配列。DOM も chrome.* も
 * 参照しないので、フィクスチャ由来のデータでも手書きのデータでもテストできる。
 *
 * RowData:
 *   {
 *     dateLabel:          string,  // "07/01(水)" など。表示・デバッグ用
 *     dayType:            string,  // "所定労働日" / "所定休日" / "法定休日"
 *     scheduleText:       string,  // "09:00-18:00"（未設定なら空文字）
 *     breakText:          string,  // "1:00"（未入力なら空文字）
 *     workedText:         string,  // "8:00"（未入力なら空文字）
 *     attendanceTypeText: string,  // "有休（半休）" など（任意）
 *   }
 */

'use strict';

const aggregateTimeLib =
  typeof require === 'function'
    ? require('./time.js')
    : { normalizeText, parseDurationToMinutes, parseScheduleRange };

/**
 * 勤務日種別の判定文字列。
 *
 * ここが freee の表記変更に最も影響を受ける箇所。文言が変わった場合は
 * この定数だけを直せば集計は復旧する（README「DOM 変更で壊れた場合」参照）。
 */
const DAY_TYPE_LABELS = Object.freeze({
  WORKDAY: '所定労働日',
  PRESCRIBED_HOLIDAY: '所定休日',
  STATUTORY_HOLIDAY: '法定休日',
});

/** 半休の判定に使う部分文字列（勤怠種別セル。例: "有休（半休）"）。 */
const HALF_DAY_LABEL = '半休';

/** 集計時の注意点コード。日本語化は render.js が行う。 */
const WARNING_CODES = Object.freeze({
  NO_SCHEDULED_WORKDAYS: 'NO_SCHEDULED_WORKDAYS',
  FALLBACK_SCHEDULE_USED: 'FALLBACK_SCHEDULE_USED',
  MULTIPLE_SCHEDULES: 'MULTIPLE_SCHEDULES',
  MISSING_WORKED_ENTRIES: 'MISSING_WORKED_ENTRIES',
  HOLIDAY_WORK_INCLUDED: 'HOLIDAY_WORK_INCLUDED',
  WORKED_FROM_SUMMARY: 'WORKED_FROM_SUMMARY',
});

/**
 * 勤務日種別が「所定労働日」かどうか。
 *
 * 完全一致ではなく部分一致で判定する。"所定休日" に "所定労働日" は含まれないので
 * 休日と誤判定する心配はなく、前後に記号や注釈が付いた場合にも耐えられる。
 *
 * @param {string} dayType
 * @returns {boolean}
 */
function isScheduledWorkday(dayType) {
  return aggregateTimeLib.normalizeText(dayType).includes(DAY_TYPE_LABELS.WORKDAY);
}

/**
 * 勤務日種別が休日（所定休日 / 法定休日）かどうか。
 *
 * @param {string} dayType
 * @returns {boolean}
 */
function isHoliday(dayType) {
  const normalized = aggregateTimeLib.normalizeText(dayType);
  return (
    normalized.includes(DAY_TYPE_LABELS.PRESCRIBED_HOLIDAY) ||
    normalized.includes(DAY_TYPE_LABELS.STATUTORY_HOLIDAY)
  );
}

/**
 * 数値配列の最頻値を返す。同数の場合は小さい値を採る（結果を決定的にするため）。
 *
 * @param {number[]} values
 * @returns {number | null} 空配列なら null
 */
function modeOf(values) {
  if (values.length === 0) {
    return null;
  }
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 所定労働日の行を「勤務予定の文字列」でグループ化し、グループごとの
 * 1 日の所定労働時間を決める。
 *
 * 勤務予定が行ごとに違う（時短勤務、期間途中の所定変更）場合でも
 * 「日数 × 一定時間」にならないよう、グループ単位で合算する。
 *
 * 休憩が未入力の行は、同じ勤務予定を持つ行の休憩の最頻値で補う。それも無ければ 0。
 * 勤務予定そのものが取れないグループは fallbackDailyMinutes を使う。
 *
 * @param {object[]} workdayRows - 所定労働日の RowData
 * @param {number} fallbackDailyMinutes
 * @returns {Array<{scheduleText: string, days: number, breakMinutes: number,
 *                  dailyMinutes: number, usedFallback: boolean}>}
 */
function buildScheduleGroups(workdayRows, fallbackDailyMinutes) {
  const groups = new Map();

  for (const row of workdayRows) {
    const key = aggregateTimeLib.normalizeText(row.scheduleText);
    if (!groups.has(key)) {
      groups.set(key, { scheduleText: key, days: 0, breakValues: [] });
    }
    const group = groups.get(key);
    group.days += 1;

    const breakMinutes = aggregateTimeLib.parseDurationToMinutes(row.breakText);
    if (breakMinutes !== null && breakMinutes >= 0) {
      group.breakValues.push(breakMinutes);
    }
  }

  const result = [];
  for (const group of groups.values()) {
    const range = aggregateTimeLib.parseScheduleRange(group.scheduleText);
    const breakMinutes = modeOf(group.breakValues) ?? 0;

    if (range === null) {
      result.push({
        scheduleText: group.scheduleText,
        days: group.days,
        breakMinutes: 0,
        dailyMinutes: fallbackDailyMinutes,
        usedFallback: true,
      });
      continue;
    }

    result.push({
      scheduleText: group.scheduleText,
      days: group.days,
      breakMinutes,
      dailyMinutes: Math.max(0, range.spanMinutes - breakMinutes),
      usedFallback: false,
    });
  }

  // 日数の多いグループを先に（表示時の主たる勤務パターンを先頭にするため）。
  // 同数なら勤務予定の文字列順で安定させる。
  result.sort((a, b) => b.days - a.days || a.scheduleText.localeCompare(b.scheduleText));
  return result;
}

/**
 * 勤怠行データを集計する。
 *
 * - 所定労働日数 = 勤務日種別が「所定労働日」の行数
 * - 所定労働時間 = 勤務予定グループごとの（日数 × 1 日の所定）の合計
 * - 総勤務時間   = 全行の「総勤務」の合計（休日出勤も含む。freee の不足時間と同じ挙動）
 * - 残り         = 所定労働時間 − 総勤務時間（負なら超過）
 *
 * 半休（有休（半休））の日は実働 + 有休分が所定内に計上されて「総勤務」に乗るため、
 * 単純な引き算で freee の「不足時間」と一致する。
 *
 * @param {object[]} rows - RowData の配列
 * @param {{fallbackDailyMinutes?: number, workedMinutesOverride?: number|null,
 *          workedDaysOverride?: number|null}} [options]
 *   workedMinutesOverride / workedDaysOverride は、行ごとの「総勤務」が取れない
 *   カレンダー／リスト表示でサマリーの表示値を使うためのもの（extract.js が渡す）。
 * @returns {object} 集計結果（render.js が表示モデルに変換する）
 */
function aggregateAttendance(rows, options = {}) {
  const fallbackDailyMinutes =
    typeof options.fallbackDailyMinutes === 'number' && Number.isFinite(options.fallbackDailyMinutes)
      ? options.fallbackDailyMinutes
      : 8 * 60;

  const safeRows = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];

  const workdayRows = safeRows.filter((row) => isScheduledWorkday(row.dayType));
  const holidayRows = safeRows.filter((row) => isHoliday(row.dayType));

  let workedMinutes = 0;
  let workedDays = 0;
  let holidayWorkMinutes = 0;
  let missingWorkedDays = 0;
  let halfDayCount = 0;

  for (const row of safeRows) {
    const minutes = aggregateTimeLib.parseDurationToMinutes(row.workedText);
    if (minutes !== null) {
      workedMinutes += minutes;
      if (minutes > 0) {
        workedDays += 1;
        if (isHoliday(row.dayType)) {
          holidayWorkMinutes += minutes;
        }
      }
    } else if (isScheduledWorkday(row.dayType)) {
      // 所定労働日なのに総勤務が未入力 = これから入力される日（または未打刻）。
      missingWorkedDays += 1;
    }

    if (aggregateTimeLib.normalizeText(row.attendanceTypeText).includes(HALF_DAY_LABEL)) {
      halfDayCount += 1;
    }
  }

  // カレンダー／リスト表示では行ごとの「総勤務」が取れないため、サマリーの
  // 表示値で置き換える（extract.js が判断して渡す）。
  const usesSummaryWorkedMinutes =
    typeof options.workedMinutesOverride === 'number' &&
    Number.isFinite(options.workedMinutesOverride);
  if (usesSummaryWorkedMinutes) {
    workedMinutes = options.workedMinutesOverride;
  }
  // 労働日数もカレンダー／リスト表示ではサマリーの表示値で置き換える（同上）。
  if (
    typeof options.workedDaysOverride === 'number' &&
    Number.isFinite(options.workedDaysOverride)
  ) {
    workedDays = options.workedDaysOverride;
  }

  const scheduleGroups = buildScheduleGroups(workdayRows, fallbackDailyMinutes);
  const scheduledMinutes = scheduleGroups.reduce(
    (total, group) => total + group.days * group.dailyMinutes,
    0
  );
  const differenceMinutes = scheduledMinutes - workedMinutes;

  const warnings = [];
  if (workdayRows.length === 0) {
    warnings.push(WARNING_CODES.NO_SCHEDULED_WORKDAYS);
  }
  if (scheduleGroups.some((group) => group.usedFallback)) {
    warnings.push(WARNING_CODES.FALLBACK_SCHEDULE_USED);
  }
  if (scheduleGroups.length > 1) {
    warnings.push(WARNING_CODES.MULTIPLE_SCHEDULES);
  }
  if (usesSummaryWorkedMinutes) {
    // 行ごとの入力状況は判定できないので、未入力日数の警告は出さない。
    missingWorkedDays = 0;
    warnings.push(WARNING_CODES.WORKED_FROM_SUMMARY);
  } else if (missingWorkedDays > 0) {
    warnings.push(WARNING_CODES.MISSING_WORKED_ENTRIES);
  }
  if (holidayWorkMinutes > 0) {
    warnings.push(WARNING_CODES.HOLIDAY_WORK_INCLUDED);
  }

  return {
    totalRows: safeRows.length,
    scheduledDays: workdayRows.length,
    holidayDays: holidayRows.length,
    scheduledMinutes,
    workedMinutes,
    workedDays,
    missingWorkedDays,
    halfDayCount,
    holidayWorkMinutes,
    differenceMinutes,
    isOver: differenceMinutes < 0,
    remainingMinutes: Math.abs(differenceMinutes),
    fallbackDailyMinutes,
    scheduleGroups,
    warnings,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DAY_TYPE_LABELS,
    HALF_DAY_LABEL,
    WARNING_CODES,
    isScheduledWorkday,
    isHoliday,
    modeOf,
    buildScheduleGroups,
    aggregateAttendance,
  };
}
