/**
 * options.js — 設定ページのロジック
 *
 * 検証と整形は src/lib/config.js の純粋関数に任せ、ここは DOM と
 * chrome.storage.local の間をつなぐだけ。外部通信は一切しない。
 */

'use strict';

const input = document.getElementById('fsh-daily');
const status = document.getElementById('fsh-status');
const saveButton = document.getElementById('fsh-save');
const resetButton = document.getElementById('fsh-reset');

/**
 * @param {string} message
 * @param {'ok' | 'error' | ''} kind
 */
function showStatus(message, kind) {
  status.textContent = message;
  status.className = kind ? `fsh-options__status fsh-options__status--${kind}` : 'fsh-options__status';
}

/** 保存済みの設定を入力欄に反映する。 */
async function load() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    input.value = formatSettingsForInput(normalizeSettings(stored[STORAGE_KEY]));
  } catch (error) {
    input.value = formatSettingsForInput(DEFAULT_SETTINGS);
    showStatus(`設定を読み込めませんでした（既定値を表示しています）: ${error.message}`, 'error');
  }
}

/** 入力値を検証して保存する。 */
async function save() {
  const parsed = parseDailyMinutesInput(input.value);
  if (!parsed.ok) {
    showStatus(parsed.error, 'error');
    return;
  }

  try {
    // 勤怠画面のトグルで保存された折りたたみ状態を消さないよう、保存済みの設定に重ねる。
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const settings = { ...normalizeSettings(stored[STORAGE_KEY]), fallbackDailyMinutes: parsed.minutes };
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    input.value = formatSettingsForInput(settings);
    showStatus('保存しました。開いている勤怠画面にも自動で反映されます。', 'ok');
  } catch (error) {
    showStatus(`保存できませんでした: ${error.message}`, 'error');
  }
}

/** 既定値（8:00）に戻す。 */
async function reset() {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
    input.value = formatSettingsForInput(DEFAULT_SETTINGS);
    showStatus('既定値（8:00）に戻しました。', 'ok');
  } catch (error) {
    showStatus(`既定値に戻せませんでした: ${error.message}`, 'error');
  }
}

saveButton.addEventListener('click', save);
resetButton.addEventListener('click', reset);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    save();
  }
});

load();
