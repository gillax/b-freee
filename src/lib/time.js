/**
 * time.js — 時間文字列のパースと整形（純粋関数のみ）
 *
 * DOM も chrome.* も参照しない。すべて純粋関数なので Node の組み込み
 * テストランナーから直接テストできる（README「テストの実行」参照）。
 *
 * manifest.json の content_scripts.js で content.js より前に読み込まれるため、
 * 拡張内ではこれらの関数は content script の isolated world における
 * グローバル関数になる。Node ではファイル末尾の module.exports ガードで
 * require できる。
 */

'use strict';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * 勤務予定セルで使われうる開始-終了の区切り文字。
 * freee は半角ハイフンだが、全角ダッシュや波ダッシュにも耐えるようにしておく。
 * 全角ハイフン（U+FF0D）は normalizeText で半角化されるためここには不要。
 */
const RANGE_SEPARATORS = ['-', '–', '—', '〜', '~', '−'];

/**
 * セルのテキストを比較・パース可能な形に正規化する。
 *
 * - 全角英数字・全角記号を半角に変換（全角コロン「：」もここで半角化）
 * - 空白をすべて除去（"09:00 - 18:00" → "09:00-18:00"）
 *
 * @param {unknown} value
 * @returns {string} 正規化済み文字列。文字列以外は空文字。
 */
function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return (
    value
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      // JS の \s は全角空白（U+3000）と NBSP（U+00A0）も含むので一括で落ちる。
      .replace(/\s+/g, '')
  );
}

/**
 * 値が「未入力」を意味するプレースホルダかどうか。
 *
 * freee は未入力セルを空文字・"-"・"--:--" などで描画する。数字を含まない
 * 文字列はすべて未入力扱いにする。
 *
 * @param {string} normalized - normalizeText を通した文字列
 * @returns {boolean}
 */
function isBlankValue(normalized) {
  return normalized.length === 0 || !/\d/.test(normalized);
}

/**
 * 期間（duration）を分に変換する。
 *
 * 受け付ける形式：
 *   - "166:50" / "8:00" / "-1:30"  … テーブルの時間セル（60進、時は 24 を超えてよい）
 *   - "9時間10分" / "9時間" / "10分" … サマリーの表示形式
 *
 * @param {string} text
 * @returns {number | null} 分。パースできない・未入力なら null。
 */
function parseDurationToMinutes(text) {
  const normalized = normalizeText(text);
  if (isBlankValue(normalized)) {
    return null;
  }

  // "H:MM" 形式（時は桁数無制限、分は 0-59）
  const colon = normalized.match(/^([+-]?)(\d+):(\d{1,2})$/);
  if (colon) {
    const minutes = Number(colon[3]);
    if (minutes >= MINUTES_PER_HOUR) {
      return null;
    }
    const total = Number(colon[2]) * MINUTES_PER_HOUR + minutes;
    return colon[1] === '-' ? -total : total;
  }

  // "N時間M分" 形式（どちらか一方だけでもよい）
  const japanese = normalized.match(/^([+-]?)(?:(\d+)時間)?(?:(\d+)分)?$/);
  if (japanese && (japanese[2] !== undefined || japanese[3] !== undefined)) {
    const hours = japanese[2] === undefined ? 0 : Number(japanese[2]);
    const minutes = japanese[3] === undefined ? 0 : Number(japanese[3]);
    const total = hours * MINUTES_PER_HOUR + minutes;
    return japanese[1] === '-' ? -total : total;
  }

  return null;
}

/**
 * 時刻（clock time）を 0:00 起点の分に変換する。
 *
 * @param {string} text - "09:00" / "9:00"
 * @returns {number | null} 0 以上 1440 未満の分。パースできなければ null。
 */
function parseClockToMinutes(text) {
  const normalized = normalizeText(text);
  if (isBlankValue(normalized)) {
    return null;
  }
  const match = normalized.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes >= MINUTES_PER_HOUR) {
    return null;
  }
  return hours * MINUTES_PER_HOUR + minutes;
}

/**
 * 勤務予定セル（"09:00-18:00"）を開始・終了・拘束時間に分解する。
 *
 * 終了が開始より小さい場合は日跨ぎ勤務とみなして終了に 24 時間を足す。
 * 開始と終了が同じ場合は 0 分（24 時間勤務は現実的にありえないため）。
 *
 * @param {string} text
 * @returns {{startMinutes: number, endMinutes: number, spanMinutes: number} | null}
 */
function parseScheduleRange(text) {
  const normalized = normalizeText(text);
  if (isBlankValue(normalized)) {
    return null;
  }

  // 区切り文字の位置を探す。勤務予定に先頭符号は現れないので単純に走査する。
  let separatorIndex = -1;
  for (let i = 1; i < normalized.length; i += 1) {
    if (RANGE_SEPARATORS.includes(normalized[i])) {
      separatorIndex = i;
      break;
    }
  }
  if (separatorIndex === -1) {
    return null;
  }

  const startMinutes = parseClockToMinutes(normalized.slice(0, separatorIndex));
  const rawEndMinutes = parseClockToMinutes(normalized.slice(separatorIndex + 1));
  if (startMinutes === null || rawEndMinutes === null) {
    return null;
  }

  const endMinutes = rawEndMinutes < startMinutes ? rawEndMinutes + MINUTES_PER_DAY : rawEndMinutes;
  return {
    startMinutes,
    endMinutes,
    spanMinutes: endMinutes - startMinutes,
  };
}

/**
 * 分を "H:MM" 形式に整形する（freee のテーブル表記に合わせた 60 進表記）。
 *
 * @param {number} minutes
 * @returns {string} 例: 10560 → "176:00"、-70 → "-1:10"
 */
function formatHoursMinutes(minutes) {
  if (!Number.isFinite(minutes)) {
    return '';
  }
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / MINUTES_PER_HOUR);
  const rest = abs % MINUTES_PER_HOUR;
  return `${sign}${hours}:${String(rest).padStart(2, '0')}`;
}

// Node のテストから require するためのエクスポートガード。
// 拡張の content script では module が undefined なのでこのブロックは実行されず、
// 上記の関数は同一 isolated world 内のグローバルとして共有される。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MINUTES_PER_HOUR,
    MINUTES_PER_DAY,
    RANGE_SEPARATORS,
    normalizeText,
    isBlankValue,
    parseDurationToMinutes,
    parseClockToMinutes,
    parseScheduleRange,
    formatHoursMinutes,
  };
}
