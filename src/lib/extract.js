/**
 * extract.js — 勤怠編集画面の DOM から集計用データを取り出すアダプタ層
 *
 * DOM に触る唯一のロジック層。ただし `document` は必ず引数で受け取るので、
 * テストでは test-helpers/mini-dom.js が作るフェイク document を渡せる。
 *
 * 設計方針：
 *   - freee のクラス名や DOM 階層に依存したセレクタは使わない。使うのは
 *     タグ名（table / tr / th / td / *）と、画面に表示されている
 *     **日本語のラベル文字列** だけ。
 *   - 列の位置は見出しテキスト（「勤務日種別」「勤務予定」「休憩」「総勤務」）から
 *     解決する。列順が変わっても壊れない。
 *   - 数字を誤って出すより「計算できない」と言う方がましなので、データが
 *     揃わない場合は viewMode: 'unavailable' を返す。
 */

'use strict';

const extractTimeLib =
  typeof require === 'function'
    ? require('./time.js')
    : { normalizeText, parseDurationToMinutes };

const extractAggregateLib =
  typeof require === 'function'
    ? require('./aggregate.js')
    : { isScheduledWorkday, isHoliday, DAY_TYPE_LABELS };

/** 取得できたデータの種類。 */
const VIEW_MODES = Object.freeze({
  /** テーブル表示：行ごとの完全なデータが取れた（最も正確）。 */
  TABLE: 'table',
  /** カレンダー／リスト表示：日種別の個数 + サマリーの総勤務時間から概算した。 */
  GENERIC: 'generic',
  /** 計算に必要なデータが見つからなかった。 */
  UNAVAILABLE: 'unavailable',
});

/**
 * 列見出しの判定キーワード。
 *
 * **freee の DOM / 表記が変わって壊れた場合、まずここを直す。**
 * 部分一致（includes）で判定するので「総勤務時間」でも「総勤務」で拾える。
 */
const COLUMN_KEYWORDS = Object.freeze({
  date: ['日付'],
  dayType: ['勤務日種別', '勤務日区分', '日種別'],
  schedule: ['勤務予定', '予定勤務', 'シフト'],
  attendanceType: ['勤怠種別', '勤怠区分'],
  break: ['休憩'],
  worked: ['総勤務', '総労働'],
});

/** サマリー領域から読み取るラベル。挿入位置のアンカーにも使う。 */
const SUMMARY_LABELS = Object.freeze({
  workedDays: '労働日数',
  totalWorked: '総勤務時間',
  shortage: '不足時間',
});

/** カード挿入位置を決めるためのアンカー文字列（サマリー内のラベル）。 */
const SUMMARY_ANCHOR_LABEL = SUMMARY_LABELS.shortage;

/** 「◯年◯月◯日 〜 ◯月◯日 勤務分」の抽出パターン。 */
const PERIOD_PATTERN =
  /(\d{4}年\d{1,2}月\d{1,2}日)\s*[〜~\-–—]\s*((?:\d{4}年)?\d{1,2}月\d{1,2}日)\s*勤務分/;

/** テキスト中の時間表記（"9時間10分" / "166:50"）。 */
const DURATION_IN_TEXT_PATTERN = /(\d+時間(?:\d+分)?|\d+分|\d+:\d{1,2})/;

/** 勤務予定らしいテキスト（"09:00-18:00"）。 */
const SCHEDULE_TEXT_PATTERN = /^\d{1,2}:\d{2}[-〜~–—]\d{1,2}:\d{2}$/;

/** 1 か月分のデータとして妥当な日数レンジ（generic モードの信頼性チェック用）。 */
const MIN_DAYS_IN_PERIOD = 28;
const MAX_DAYS_IN_PERIOD = 31;

/**
 * 要素の直下のテキストノードだけを連結する。
 *
 * textContent と違って子要素のテキストを巻き込まないので、
 * 「『不足時間』というラベルそのものを持つ要素」を特定できる。
 * 全要素を走査しても軽い（textContent の再帰構築を避けられる）。
 *
 * @param {Element} element
 * @returns {string}
 */
function ownText(element) {
  let text = '';
  const nodes = element.childNodes || [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      text += node.nodeValue;
    }
  }
  return text;
}

/**
 * document / 要素の探索起点を返す。
 *
 * @param {Document} doc
 * @returns {Element}
 */
function rootOf(doc) {
  return doc.body || doc.documentElement || doc;
}

/**
 * 見出しセルのテキスト配列から、各フィールドの列インデックスを解決する。
 *
 * @param {string[]} headerTexts - 正規化済みの見出しテキスト
 * @returns {Record<string, number>} 見つからなかったフィールドは -1
 */
function resolveColumnIndexes(headerTexts) {
  const indexes = {};
  for (const [field, keywords] of Object.entries(COLUMN_KEYWORDS)) {
    indexes[field] = -1;
    for (let i = 0; i < headerTexts.length; i += 1) {
      if (keywords.some((keyword) => headerTexts[i].includes(keyword))) {
        indexes[field] = i;
        break;
      }
    }
  }
  return indexes;
}

/**
 * 勤怠テーブル（「勤務日種別」と「総勤務」の列を持つ table）を探す。
 *
 * @param {Document} doc
 * @returns {{table: Element, rows: Element[], headerRowIndex: number,
 *            columns: Record<string, number>} | null}
 */
function findAttendanceTable(doc) {
  const tables = Array.from(doc.querySelectorAll('table'));
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr'));
    // 見出しは先頭付近にあるはず。走査範囲を絞って誤検出を防ぐ。
    const limit = Math.min(rows.length, 5);
    for (let i = 0; i < limit; i += 1) {
      const headerTexts = Array.from(rows[i].querySelectorAll('th, td')).map((cell) =>
        extractTimeLib.normalizeText(cell.textContent)
      );
      const columns = resolveColumnIndexes(headerTexts);
      if (columns.dayType >= 0 && columns.worked >= 0) {
        return { table, rows, headerRowIndex: i, columns };
      }
    }
  }
  return null;
}

/**
 * 勤怠テーブルの各行を RowData に変換する。
 *
 * 勤務日種別が「所定労働日 / 所定休日 / 法定休日」のいずれでもない行（合計行、
 * 見出しの繰り返し、未知の種別）は rows に入れず unknownRows に分けて数える。
 * 集計に混ぜないことで、誤った数字が出るのを防ぐ。
 *
 * @param {{rows: Element[], headerRowIndex: number, columns: Record<string, number>}} found
 * @returns {{rows: object[], unknownRows: object[]}}
 */
function extractRowsFromTable(found) {
  const rows = [];
  const unknownRows = [];

  for (let i = found.headerRowIndex + 1; i < found.rows.length; i += 1) {
    const cells = Array.from(found.rows[i].querySelectorAll('th, td'));
    if (cells.length === 0) {
      continue;
    }

    const cellText = (index) =>
      index >= 0 && index < cells.length
        ? extractTimeLib.normalizeText(cells[index].textContent)
        : '';

    const row = {
      dateLabel: cellText(found.columns.date),
      dayType: cellText(found.columns.dayType),
      scheduleText: cellText(found.columns.schedule),
      breakText: cellText(found.columns.break),
      workedText: cellText(found.columns.worked),
      attendanceTypeText: cellText(found.columns.attendanceType),
    };

    if (
      extractAggregateLib.isScheduledWorkday(row.dayType) ||
      extractAggregateLib.isHoliday(row.dayType)
    ) {
      rows.push(row);
    } else if (row.dayType.length > 0) {
      unknownRows.push(row);
    }
  }

  return { rows, unknownRows };
}

/**
 * テキスト中から最初の時間表記を分に変換して返す。
 *
 * @param {string} text
 * @returns {number | null}
 */
function matchDurationInText(text) {
  const match = extractTimeLib.normalizeText(text).match(DURATION_IN_TEXT_PATTERN);
  return match ? extractTimeLib.parseDurationToMinutes(match[1]) : null;
}

/**
 * サマリー領域の表示値を読み取る。
 *
 * DOM 構造を仮定せず、画面テキスト全体を 1 回だけ取得し「ラベルの直後に現れる
 * 時間表記」を拾う方式にしている。ラベルと値が別要素・別階層にあっても動く。
 *
 * @param {Document} doc
 * @returns {{workedDaysCount: number|null, totalWorkedMinutes: number|null,
 *            shortageMinutes: number|null, periodLabel: string}}
 */
function extractSummary(doc) {
  const allText = extractTimeLib.normalizeText(rootOf(doc).textContent || '');

  /**
   * @param {string} label
   * @returns {number | null}
   */
  const readMinutesAfter = (label) => {
    const index = allText.indexOf(label);
    if (index === -1) {
      return null;
    }
    // ラベル直後の 16 文字以内に現れる時間表記だけを見る（別項目の値を拾わないため）。
    return matchDurationInText(allText.slice(index + label.length, index + label.length + 16));
  };

  const workedDaysMatch = allText.match(
    new RegExp(`${SUMMARY_LABELS.workedDays}[^\\d]{0,4}(\\d+)日`)
  );
  const periodMatch = (rootOf(doc).textContent || '').match(PERIOD_PATTERN);

  return {
    workedDaysCount: workedDaysMatch ? Number(workedDaysMatch[1]) : null,
    totalWorkedMinutes: readMinutesAfter(SUMMARY_LABELS.totalWorked),
    shortageMinutes: readMinutesAfter(SUMMARY_LABELS.shortage),
    periodLabel: periodMatch ? `${periodMatch[1]} 〜 ${periodMatch[2]} 勤務分` : '',
  };
}

/**
 * カードの挿入位置を決めるためのアンカー要素を探す。
 *
 * 「不足時間」というラベルそのものを持つ要素から親を辿り、サマリーの主要ラベルを
 * すべて含む最小の祖先（= サマリー領域）を返す。カードはその直後に挿入する。
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
function findSummaryContainer(doc) {
  const root = rootOf(doc);
  const labelElement = Array.from(root.querySelectorAll('*')).find((element) =>
    extractTimeLib.normalizeText(ownText(element)).includes(SUMMARY_ANCHOR_LABEL)
  );
  if (!labelElement) {
    return null;
  }

  // サマリー全体を含むところまで上がる（最大 6 段。それ以上辿るとページ全体になる）。
  let current = labelElement;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = current.parentElement;
    if (!parent || parent === root) {
      break;
    }
    const text = extractTimeLib.normalizeText(parent.textContent || '');
    if (text.includes(SUMMARY_LABELS.totalWorked) && text.includes(SUMMARY_LABELS.shortage)) {
      return parent;
    }
    current = parent;
  }
  return labelElement.parentElement || labelElement;
}

/**
 * 正規化後のテキストが label と完全一致する要素の数を数える。
 *
 * 完全一致にしているのは、凡例や説明文（「所定労働日とは…」）を
 * 日数として数えてしまわないため。
 *
 * @param {Element} root
 * @param {string} label
 * @returns {number}
 */
function countExactLabelElements(root, label) {
  let count = 0;
  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (extractTimeLib.normalizeText(ownText(element)) === label) {
      count += 1;
    }
  }
  return count;
}

/**
 * カレンダー／リスト表示から概算用のデータを組み立てる。
 *
 * これらの表示には行単位の「総勤務」「休憩」が揃っていないため：
 *   - 日数   … 「所定労働日 / 所定休日 / 法定休日」ラベルの出現数を数える
 *   - 総勤務 … サマリーの「総勤務時間」の表示値を採用する
 *   - 1 日の所定 … 休憩を各日に紐付けられないので設定のフォールバック値を使う
 *     （勤務予定は取れても休憩が分からないと 1 時間ずれるため、あえて使わない）
 *
 * 日数の合計が 1 か月として妥当でない、または総勤務時間が読めない場合は
 * 「信頼できない」と判断して null を返す。
 *
 * @param {Document} doc
 * @param {{totalWorkedMinutes: number|null}} summary
 * @returns {{rows: object[], workedMinutesOverride: number, schedulePatternHint: string} | null}
 */
function extractGenericView(doc, summary) {
  if (summary.totalWorkedMinutes === null) {
    return null;
  }

  const root = rootOf(doc);
  const labels = extractAggregateLib.DAY_TYPE_LABELS;
  const workdayCount = countExactLabelElements(root, labels.WORKDAY);
  const prescribedHolidayCount = countExactLabelElements(root, labels.PRESCRIBED_HOLIDAY);
  const statutoryHolidayCount = countExactLabelElements(root, labels.STATUTORY_HOLIDAY);
  const totalDays = workdayCount + prescribedHolidayCount + statutoryHolidayCount;

  if (
    workdayCount === 0 ||
    totalDays < MIN_DAYS_IN_PERIOD ||
    totalDays > MAX_DAYS_IN_PERIOD
  ) {
    return null;
  }

  // 表示用のヒントとして、画面に出ている勤務予定パターンの最頻値を拾う。
  const schedulePatternHint = mostFrequentSchedulePattern(root);

  const makeRows = (count, dayType) =>
    Array.from({ length: count }, () => ({
      dateLabel: '',
      dayType,
      scheduleText: '',
      breakText: '',
      workedText: '',
      attendanceTypeText: '',
    }));

  return {
    rows: [
      ...makeRows(workdayCount, labels.WORKDAY),
      ...makeRows(prescribedHolidayCount, labels.PRESCRIBED_HOLIDAY),
      ...makeRows(statutoryHolidayCount, labels.STATUTORY_HOLIDAY),
    ],
    workedMinutesOverride: summary.totalWorkedMinutes,
    schedulePatternHint,
  };
}

/**
 * 画面に出ている "09:00-18:00" 形式のテキストのうち最も多いものを返す。
 *
 * @param {Element} root
 * @returns {string} 見つからなければ空文字
 */
function mostFrequentSchedulePattern(root) {
  const counts = new Map();
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const text = extractTimeLib.normalizeText(ownText(element));
    if (SCHEDULE_TEXT_PATTERN.test(text)) {
      counts.set(text, (counts.get(text) || 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [text, count] of counts) {
    if (count > bestCount) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 勤怠編集画面から集計用データを取り出す。
 *
 * テーブル表示を優先し、取れなければカレンダー／リスト表示向けの概算に落とし、
 * それも無理なら unavailable を返す。
 *
 * @param {Document} doc
 * @returns {{viewMode: string, rows: object[], unknownRows: object[],
 *            workedMinutesOverride: number|null, schedulePatternHint: string,
 *            summary: object}}
 */
function extractAttendance(doc) {
  const summary = extractSummary(doc);

  const found = findAttendanceTable(doc);
  if (found) {
    const { rows, unknownRows } = extractRowsFromTable(found);
    if (rows.length > 0) {
      return {
        viewMode: VIEW_MODES.TABLE,
        rows,
        unknownRows,
        workedMinutesOverride: null,
        schedulePatternHint: '',
        summary,
      };
    }
  }

  const generic = extractGenericView(doc, summary);
  if (generic) {
    return {
      viewMode: VIEW_MODES.GENERIC,
      rows: generic.rows,
      unknownRows: [],
      workedMinutesOverride: generic.workedMinutesOverride,
      schedulePatternHint: generic.schedulePatternHint,
      summary,
    };
  }

  return {
    viewMode: VIEW_MODES.UNAVAILABLE,
    rows: [],
    unknownRows: [],
    workedMinutesOverride: null,
    schedulePatternHint: '',
    summary,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEW_MODES,
    COLUMN_KEYWORDS,
    SUMMARY_LABELS,
    SUMMARY_ANCHOR_LABEL,
    ownText,
    resolveColumnIndexes,
    findAttendanceTable,
    extractRowsFromTable,
    matchDurationInText,
    extractSummary,
    findSummaryContainer,
    countExactLabelElements,
    mostFrequentSchedulePattern,
    extractGenericView,
    extractAttendance,
  };
}
