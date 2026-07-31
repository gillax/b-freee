/**
 * extract.js — 勤怠編集画面の DOM から表示・集計用のデータを取り出すアダプタ層
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
 *
 * サマリー領域の読み取りは readSummaryItems の 1 系統だけ。コピー行に出す値も、
 * カレンダー表示の概算に使う値も、同じ結果から取る。
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
  dayType: ['勤務日種別', '勤務日区分', '日種別'],
  schedule: ['勤務予定', '予定勤務', 'シフト'],
  break: ['休憩'],
  worked: ['総勤務', '総労働'],
});

/**
 * 拡張が差し込んだ要素に付ける目印の属性。
 *
 * コピー行にも「労働日数」「不足時間」といった同じラベルが現れるため、
 * 目印を付けておかないと**自分の表示を freee の表示として読み直してしまう**
 * （コピー行は元のサマリーより前に置くので、テキストの出現順でも先に来る）。
 * この属性を持つ要素とその子孫は、テキストにも要素の探索にも含めない。
 */
const INJECTED_ATTRIBUTE = 'data-fsh';

/** サマリー領域から読み取るラベル。挿入位置のアンカーにも使う。 */
const SUMMARY_LABELS = Object.freeze({
  workedDays: '労働日数',
  totalWorked: '総勤務時間',
  shortage: '不足時間',
});

/** コピー行の挿入位置を決めるためのアンカー文字列（サマリー内のラベル）。 */
const SUMMARY_ANCHOR_LABEL = SUMMARY_LABELS.shortage;

/**
 * サマリー項目の値として認める表記。
 *
 * "21日" / "175時間30分" / "0時間" / "0.5日" / "176:00" のいずれにも当たる。
 */
const SUMMARY_VALUE_PATTERN = /-?\d+(?:\.\d+)?(?::\d{1,2}|時間(?:\d+分)?|分|日)/;

/**
 * ラベルの直後、何文字先までを値として見るか。
 * 離れた位置にある別項目の値を拾わないための上限。
 */
const SUMMARY_VALUE_WINDOW = 16;

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
 * 拡張が差し込んだ要素（またはその子孫）かどうか。
 *
 * @param {Element | null} element
 * @returns {boolean}
 */
function isInjected(element) {
  let current = element;
  while (current && current.nodeType === 1) {
    if (
      typeof current.getAttribute === 'function' &&
      current.getAttribute(INJECTED_ATTRIBUTE) !== null
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * textContent の「freee の画面だけ」版。拡張が差し込んだ要素の中身は含めない。
 *
 * @param {Node | null} node
 * @returns {string}
 */
function pageText(node) {
  if (!node) {
    return '';
  }
  if (node.nodeType === 3) {
    return node.nodeValue || '';
  }
  if (node.nodeType !== 1) {
    return '';
  }
  if (typeof node.getAttribute === 'function' && node.getAttribute(INJECTED_ATTRIBUTE) !== null) {
    return '';
  }
  let text = '';
  for (const child of node.childNodes || []) {
    text += pageText(child);
  }
  return text;
}

/**
 * 探索対象の子孫要素を文書順で返す。拡張が差し込んだ要素は除く。
 *
 * @param {Element} root
 * @returns {Element[]}
 */
function pageElements(root) {
  return Array.from(root.querySelectorAll('*')).filter((element) => !isInjected(element));
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
 * 見出しの繰り返し、未知の種別）は**落とす**。集計に混ぜると誤った数字が出るため。
 *
 * @param {{rows: Element[], headerRowIndex: number, columns: Record<string, number>}} found
 * @returns {object[]} RowData の配列
 */
function extractRowsFromTable(found) {
  const rows = [];

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
      dayType: cellText(found.columns.dayType),
      scheduleText: cellText(found.columns.schedule),
      breakText: cellText(found.columns.break),
      workedText: cellText(found.columns.worked),
    };

    if (
      extractAggregateLib.isScheduledWorkday(row.dayType) ||
      extractAggregateLib.isHoliday(row.dayType)
    ) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * コピー行の挿入位置を決めるためのアンカー要素を探す。
 *
 * 「不足時間」というラベルそのものを持つ要素から親を辿り、サマリーの主要ラベルを
 * すべて含む最小の祖先（= サマリー領域）を返す。コピー行はその直前に挿入し、
 * この要素自体を折りたたむ（隠す）対象にする。
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
function findSummaryContainer(doc) {
  const root = rootOf(doc);
  const labelElement = pageElements(root).find((element) =>
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
    const text = extractTimeLib.normalizeText(pageText(parent));
    if (text.includes(SUMMARY_LABELS.totalWorked) && text.includes(SUMMARY_LABELS.shortage)) {
      return parent;
    }
    current = parent;
  }
  return labelElement.parentElement || labelElement;
}

/**
 * ラベルを持つ要素から、その項目の値テキストを読む。
 *
 * 祖先を辿り、「ラベルの直後に値らしい表記が現れる」最初の祖先を項目コンテナとみなす。
 * ラベルと値が別要素・別階層にあっても読めるが、離れた別項目の値は
 * SUMMARY_VALUE_WINDOW で弾く。
 *
 * @param {Element} labelElement - ラベル文字列を直接持つ要素
 * @param {string} label
 * @returns {string | null} 正規化済みの値（"175時間30分" など）。読めなければ null
 */
function readValueNearLabel(labelElement, label) {
  let ancestor = labelElement.parentElement;
  for (let depth = 0; depth < 6 && ancestor; depth += 1) {
    const text = extractTimeLib.normalizeText(pageText(ancestor));
    const index = text.indexOf(label);
    if (index >= 0) {
      const after = text.slice(index + label.length, index + label.length + SUMMARY_VALUE_WINDOW);
      const match = after.match(SUMMARY_VALUE_PATTERN);
      if (match) {
        return match[0];
      }
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

/**
 * サマリー領域から、指定したラベルの表示値をまとめて読み取る。
 *
 * 画面から値を読む窓口はこの関数だけ。コピー行に並べる値も、カレンダー表示の
 * 概算に使う「総勤務時間」「労働日数」も、同じ戻り値から取る。
 * 見つからない項目はキーごと落とすので、freee 側に無い項目を勝手に「0」として
 * 扱うことはない。
 *
 * @param {Element | null} root - サマリー領域（findSummaryContainer の戻り値）
 * @param {string[]} labels - 読み取りたいラベル（部分一致で判定する）
 * @returns {Record<string, string>} ラベル → 正規化済みの値テキスト
 */
function readSummaryItems(root, labels) {
  const values = {};
  if (!root || typeof root.querySelectorAll !== 'function' || !Array.isArray(labels)) {
    return values;
  }

  // サマリー領域の走査は 1 回だけにして、その中で全ラベルを判定する。
  for (const element of pageElements(root)) {
    const own = extractTimeLib.normalizeText(ownText(element));
    if (own.length === 0) {
      continue;
    }
    for (const label of labels) {
      if (values[label] !== undefined || !own.includes(label)) {
        continue;
      }
      const value = readValueNearLabel(element, label);
      if (value !== null) {
        values[label] = value;
      }
    }
  }
  return values;
}

/**
 * "20日" / "0.5日" のような日数表記を数値にする。
 *
 * @param {string} [text]
 * @returns {number | null}
 */
function parseDayCount(text) {
  const match = extractTimeLib.normalizeText(text).match(/^(\d+(?:\.\d+)?)日/);
  return match ? Number(match[1]) : null;
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
  for (const element of pageElements(root)) {
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
 * @param {Record<string, string>} summaryItems - readSummaryItems の戻り値
 * @returns {{rows: object[], workedMinutesOverride: number} | null}
 */
function extractGenericView(doc, summaryItems) {
  const totalWorkedMinutes = extractTimeLib.parseDurationToMinutes(
    summaryItems[SUMMARY_LABELS.totalWorked]
  );
  if (totalWorkedMinutes === null) {
    return null;
  }

  const root = rootOf(doc);
  const labels = extractAggregateLib.DAY_TYPE_LABELS;
  const workdayCount = countExactLabelElements(root, labels.WORKDAY);
  const prescribedHolidayCount = countExactLabelElements(root, labels.PRESCRIBED_HOLIDAY);
  const statutoryHolidayCount = countExactLabelElements(root, labels.STATUTORY_HOLIDAY);
  const totalDays = workdayCount + prescribedHolidayCount + statutoryHolidayCount;

  if (workdayCount === 0 || totalDays < MIN_DAYS_IN_PERIOD || totalDays > MAX_DAYS_IN_PERIOD) {
    return null;
  }

  const makeRows = (count, dayType) =>
    Array.from({ length: count }, () => ({
      dayType,
      scheduleText: '',
      breakText: '',
      workedText: '',
    }));

  return {
    rows: [
      ...makeRows(workdayCount, labels.WORKDAY),
      ...makeRows(prescribedHolidayCount, labels.PRESCRIBED_HOLIDAY),
      ...makeRows(statutoryHolidayCount, labels.STATUTORY_HOLIDAY),
    ],
    workedMinutesOverride: totalWorkedMinutes,
  };
}

/**
 * 勤怠編集画面から集計用データを取り出す。
 *
 * テーブル表示を優先し、取れなければカレンダー／リスト表示向けの概算に落とし、
 * それも無理なら unavailable を返す。
 *
 * サマリーの表示値は呼び出し側が readSummaryItems で読んだものを渡す
 * （コピー行の描画と同じ結果を使い回し、走査を 1 回で済ませるため）。
 *
 * @param {Document} doc
 * @param {Record<string, string>} [summaryItems] - readSummaryItems の戻り値
 * @returns {{viewMode: string, rows: object[],
 *            workedMinutesOverride: number|null, workedDaysOverride: number|null}}
 */
function extractAttendance(doc, summaryItems = {}) {
  const found = findAttendanceTable(doc);
  if (found) {
    const rows = extractRowsFromTable(found);
    if (rows.length > 0) {
      return {
        viewMode: VIEW_MODES.TABLE,
        rows,
        workedMinutesOverride: null,
        workedDaysOverride: null,
      };
    }
  }

  const generic = extractGenericView(doc, summaryItems);
  if (generic) {
    return {
      viewMode: VIEW_MODES.GENERIC,
      rows: generic.rows,
      workedMinutesOverride: generic.workedMinutesOverride,
      // 行ごとの「総勤務」が取れないので労働日数もサマリーから取る。読めない場合は null
      // で、そのとき aggregate は 0 を返す（合成行の workedText が空のため）。
      workedDaysOverride: parseDayCount(summaryItems[SUMMARY_LABELS.workedDays]),
    };
  }

  return {
    viewMode: VIEW_MODES.UNAVAILABLE,
    rows: [],
    workedMinutesOverride: null,
    workedDaysOverride: null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VIEW_MODES,
    COLUMN_KEYWORDS,
    INJECTED_ATTRIBUTE,
    SUMMARY_LABELS,
    SUMMARY_ANCHOR_LABEL,
    SUMMARY_VALUE_PATTERN,
    isInjected,
    pageText,
    pageElements,
    ownText,
    resolveColumnIndexes,
    findAttendanceTable,
    extractRowsFromTable,
    findSummaryContainer,
    readValueNearLabel,
    readSummaryItems,
    parseDayCount,
    countExactLabelElements,
    extractGenericView,
    extractAttendance,
  };
}
