/**
 * config.js — 設定値の既定値と正規化（純粋関数のみ）
 *
 * chrome.storage へのアクセス自体は content.js / options.js が行う。
 * ここには「保存された値を安全な設定オブジェクトに変換する」純粋なロジックだけを置く。
 */

'use strict';

// lib 間の依存解決。Node（テスト）では require、拡張の content script /
// options ページでは先に読み込まれた time.js のグローバル関数を使う。
const configTimeLib =
  typeof require === 'function'
    ? require('./time.js')
    : { parseDurationToMinutes, formatHoursMinutes, MINUTES_PER_DAY };

/** chrome.storage.local のキー。sync は使わない（Google アカウントに同期させない）。 */
const STORAGE_KEY = 'settings';

/**
 * 既定値。
 *
 * fallbackDailyMinutes は「勤務予定セルから 1 日の所定労働時間を算出できなかった
 * 場合」にのみ使われる。通常は勤務予定（例 09:00-18:00 − 休憩 1:00）から算出されるため
 * 出番はない。
 */
const DEFAULT_SETTINGS = Object.freeze({
  fallbackDailyMinutes: 8 * 60,
});

/**
 * 保存済みの値（何が入っているか信用できない）を正規化して設定オブジェクトにする。
 *
 * @param {unknown} raw - chrome.storage.local から読み出した値
 * @returns {{fallbackDailyMinutes: number}}
 */
function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') {
    return settings;
  }

  const value = raw.fallbackDailyMinutes;
  if (typeof value === 'number' && Number.isFinite(value)) {
    settings.fallbackDailyMinutes = clampDailyMinutes(Math.round(value));
  } else if (typeof value === 'string') {
    const parsed = configTimeLib.parseDurationToMinutes(value);
    if (parsed !== null) {
      settings.fallbackDailyMinutes = clampDailyMinutes(parsed);
    }
  }

  return settings;
}

/**
 * 1 日の所定労働時間として妥当な範囲（0 〜 24 時間）に丸める。
 *
 * @param {number} minutes
 * @returns {number}
 */
function clampDailyMinutes(minutes) {
  if (minutes < 0) {
    return 0;
  }
  if (minutes > configTimeLib.MINUTES_PER_DAY) {
    return configTimeLib.MINUTES_PER_DAY;
  }
  return minutes;
}

/**
 * 設定画面の入力文字列を検証する。
 *
 * @param {string} text - "8:00" / "7時間45分" など
 * @returns {{ok: true, minutes: number} | {ok: false, error: string}}
 */
function parseDailyMinutesInput(text) {
  const minutes = configTimeLib.parseDurationToMinutes(text);
  if (minutes === null) {
    return { ok: false, error: '「8:00」または「8時間0分」の形式で入力してください。' };
  }
  if (minutes < 0) {
    return { ok: false, error: '0 以上の時間を入力してください。' };
  }
  if (minutes > configTimeLib.MINUTES_PER_DAY) {
    return { ok: false, error: '24:00 以下の時間を入力してください。' };
  }
  return { ok: true, minutes };
}

/**
 * 設定値を入力欄に表示する形（"8:00"）に整形する。
 *
 * @param {{fallbackDailyMinutes: number}} settings
 * @returns {string}
 */
function formatSettingsForInput(settings) {
  return configTimeLib.formatHoursMinutes(normalizeSettings(settings).fallbackDailyMinutes);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    normalizeSettings,
    clampDailyMinutes,
    parseDailyMinutesInput,
    formatSettingsForInput,
  };
}
