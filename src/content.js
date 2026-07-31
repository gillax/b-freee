/**
 * content.js — 勤怠編集画面に「並べ替えたサマリー」を差し込む薄い層
 *
 * ここだけが DOM を書き換え、chrome.* を触る。計算とテキスト生成は
 * src/lib/*.js の純粋関数に任せている（そちらは単体テスト済み）。
 *
 * やることは 2 つだけ：
 *   1. freee のサマリーの直前に、表示順を組み替えたコピー行を差し込む
 *   2. freee の元のサマリーを折りたたむ（消さずに display で隠すだけ）
 *
 * 外部通信は一切しない。読み取った勤怠データはこのページの外に出ない。
 *
 * manifest.json の content_scripts で time.js → config.js → aggregate.js →
 * extract.js → render.js → content.js の順に読み込まれるため、それらの関数は
 * このファイルからグローバルとして参照できる。
 */

'use strict';

/** 並べ替えたサマリーのコピー行の要素 ID。冪等な差し替えのキーになる。 */
const FSH_SUMMARY_ID = 'fsh-summary';

/** 再計算のデバウンス幅（ms）。SPA の再描画が落ち着くのを待つ。 */
const FSH_DEBOUNCE_MS = 150;

/**
 * 勤怠編集画面かどうかの判定に使うハッシュの目印。
 * URL は #/work_records/<year>/<month>/employees/<employeeId> の形。
 */
const FSH_TARGET_HASH_PATTERN = /work_records/;

/** 現在の設定（chrome.storage.local 由来。読めなければ既定値）。 */
let fshSettings = normalizeSettings(null);

/** @type {MutationObserver | null} */
let fshObserver = null;

/** @type {number | null} */
let fshDebounceTimer = null;

/** 自分の DOM 操作による MutationObserver の再入を防ぐフラグ。 */
let fshIsRendering = false;

/** display を書き換えて隠している freee の元サマリー。元に戻すために覚えておく。 */
let fshCollapsedElement = null;

/** 直前に描画したコピー行の表示モデル（差分が無ければ DOM を触らない）。 */
let fshLastSummaryKey = '';

/**
 * 拡張が作った要素を生成する。
 *
 * すべての要素に extract.js の目印（data-fsh）を付ける。これが無いと、
 * コピー行に出したラベル（「労働日数」「不足時間」…）を freee の表示として
 * 読み直してしまう（コピー行は元サマリーより前に置くので、テキストの
 * 出現順でも先に来る）。
 *
 * @param {string} tagName
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function fshCreateElement(tagName, className) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  element.setAttribute(INJECTED_ATTRIBUTE, '');
  return element;
}

/**
 * ノードが自分の作った DOM の内側かどうか。
 *
 * @param {Node | null} node
 * @returns {boolean}
 */
function fshIsOwnNode(node) {
  if (!node) {
    return false;
  }
  return isInjected(node.nodeType === 1 ? node : node.parentElement);
}

/**
 * MutationObserver を止めてから DOM を操作し、必ず再開する。
 *
 * @param {() => void} mutate
 */
function fshWithObserverPaused(mutate) {
  fshIsRendering = true;
  if (fshObserver) {
    fshObserver.disconnect();
  }
  try {
    mutate();
  } finally {
    fshIsRendering = false;
    if (fshObserver) {
      fshObserver.observe(document.body, { childList: true, subtree: true });
    }
  }
}

/**
 * ラベルと値の 1 項目を作る。
 *
 * textContent だけを使い innerHTML は使わない（ページの CSP に依存せず、
 * 読み取ったテキストを HTML として解釈させないため）。
 *
 * @param {{label: string, value: string, tone: string}} item
 * @returns {HTMLElement}
 */
function fshCreateItem(item) {
  const wrapper = fshCreateElement('div', `fsh-item fsh-item--${item.tone}`);

  const label = fshCreateElement('span', 'fsh-item__label');
  label.textContent = item.label;

  const value = fshCreateElement('span', 'fsh-item__value');
  value.textContent = item.value;

  wrapper.append(label, value);
  return wrapper;
}

/**
 * freee の元サマリーの表示 / 非表示を切り替える。
 *
 * インラインの `display: none !important` で隠す。freee 側のクラスに勝たせるためと、
 * 元に戻すときにインラインスタイルを消すだけで済ませるため。
 * React が要素を作り直した場合は、前に隠した要素を先に戻してから新しい要素を隠す。
 *
 * @param {Element | null} summary
 * @param {boolean} collapsed
 */
function fshSetCollapsed(summary, collapsed) {
  if (fshCollapsedElement && fshCollapsedElement !== summary) {
    fshCollapsedElement.style.removeProperty('display');
    fshCollapsedElement = null;
  }
  if (!summary || !summary.style) {
    return;
  }
  if (collapsed) {
    summary.style.setProperty('display', 'none', 'important');
    fshCollapsedElement = summary;
  } else if (fshCollapsedElement === summary) {
    summary.style.removeProperty('display');
    fshCollapsedElement = null;
  }
}

/** 折りたたみ状態を反転して保存する（トグルボタンのクリック）。 */
function fshToggleCollapsed() {
  fshSettings = { ...fshSettings, collapseSummary: !fshSettings.collapseSummary };
  // 保存の完了を待たずに画面へ反映する（保存に失敗してもこのタブでは切り替わる）。
  fshSafeRecalculate();
  Promise.resolve(chrome.storage.local.set({ [STORAGE_KEY]: fshSettings })).catch((error) => {
    console.warn('[freee 所定労働時間] 折りたたみ状態を保存できませんでした:', error);
  });
}

/**
 * 並べ替えたコピー行を組み立てる。
 *
 * @param {object} model - render.js の buildSummaryRowModel の戻り値
 * @returns {HTMLElement}
 */
function fshCreateSummaryRow(model) {
  const row = fshCreateElement('section', 'fsh-summary');
  row.id = FSH_SUMMARY_ID;
  // freee 側のスクリプトから見て邪魔にならないよう、支援技術向けの情報だけ付ける。
  row.setAttribute('aria-label', model.title);

  for (const item of model.items) {
    row.append(fshCreateItem(item));
  }

  const toggle = fshCreateElement('button', 'fsh-summary__toggle');
  toggle.type = 'button';
  toggle.textContent = model.toggleLabel;
  toggle.setAttribute('aria-expanded', model.collapsed ? 'false' : 'true');
  toggle.addEventListener('click', fshToggleCollapsed);
  row.append(toggle);

  return row;
}

/** コピー行を取り除き、freee の元サマリーを元に戻す。 */
function fshRemoveSummaryRow() {
  const existing = document.getElementById(FSH_SUMMARY_ID);
  if (existing) {
    existing.remove();
  }
  fshSetCollapsed(null, false);
  fshLastSummaryKey = '';
}

/**
 * コピー行を描画し、freee の元サマリーを折りたたむ。
 *
 * 1 項目も読み取れなかった場合はコピー行を出さず、元サマリーも隠さない
 * （読めていないのに隠すと、画面から情報が消えるだけになるため）。
 *
 * 表示内容が前回と同じなら DOM を作り直さない。freee 側の再描画と自分の描画が
 * 交互に走り続けるのを避けるため。
 *
 * @param {Element|null} summary - freee の元サマリー（findSummaryContainer の戻り値）
 * @param {Record<string, string>} summaryItems - readSummaryItems の戻り値
 * @param {object} aggregate - aggregate.js の集計結果
 */
function fshRenderSummaryRow(summary, summaryItems, aggregate) {
  const model = buildSummaryRowModel({
    aggregate,
    summaryItems,
    collapsed: fshSettings.collapseSummary,
  });

  fshWithObserverPaused(() => {
    if (!summary || model.items.length === 0) {
      fshRemoveSummaryRow();
      return;
    }

    const modelKey = JSON.stringify(model);
    let row = document.getElementById(FSH_SUMMARY_ID);
    if (!row || modelKey !== fshLastSummaryKey) {
      const next = fshCreateSummaryRow(model);
      if (row) {
        row.replaceWith(next);
      }
      row = next;
      fshLastSummaryKey = modelKey;
    }

    // 元サマリーの直前に置く（サマリー領域が作り直されたら追随する）。
    if (summary.previousElementSibling !== row) {
      summary.before(row);
    }
    fshSetCollapsed(summary, model.collapsed);
  });
}

/** 差し込んだものを取り除く（対象画面から離れたとき）。 */
function fshRemoveInjections() {
  if (!document.getElementById(FSH_SUMMARY_ID) && !fshCollapsedElement) {
    return;
  }
  fshWithObserverPaused(fshRemoveSummaryRow);
}

/**
 * 画面を読み直して再計算し、コピー行を更新する。
 */
function fshRecalculate() {
  if (!FSH_TARGET_HASH_PATTERN.test(location.hash)) {
    // 勤怠編集以外の画面（同じ /attendances 配下の別ルート）では何も出さない。
    fshRemoveInjections();
    return;
  }

  // サマリー領域の特定と値の読み取りは 1 回だけ。コピー行の描画にも、
  // カレンダー表示の概算（extractAttendance）にも同じ結果を使う。
  const summary = findSummaryContainer(document);
  const summaryItems = readSummaryItems(summary, summaryRowLabels());
  const extracted = extractAttendance(document, summaryItems);

  // 所定を計算できない画面では rows が空になり、分数は出ずに freee の表示値だけが並ぶ。
  const aggregate = aggregateAttendance(extracted.rows, {
    fallbackDailyMinutes: fshSettings.fallbackDailyMinutes,
    workedMinutesOverride: extracted.workedMinutesOverride,
    workedDaysOverride: extracted.workedDaysOverride,
  });

  fshRenderSummaryRow(summary, summaryItems, aggregate);
}

/**
 * 例外でページを壊さないよう包んだ再計算。
 */
function fshSafeRecalculate() {
  try {
    fshRecalculate();
  } catch (error) {
    // 画面は壊さず、原因は追えるように残す。
    console.warn('[freee 所定労働時間] 再計算に失敗しました:', error);
  }
}

/** デバウンス付きの再計算予約。 */
function fshScheduleRecalculate() {
  if (fshDebounceTimer !== null) {
    clearTimeout(fshDebounceTimer);
  }
  fshDebounceTimer = setTimeout(() => {
    fshDebounceTimer = null;
    fshSafeRecalculate();
  }, FSH_DEBOUNCE_MS);
}

/**
 * サマリー領域やテーブルの差し替えを検知するための監視を開始する。
 *
 * 月切替・従業員切替・表示切替（カレンダー / リスト / テーブル）はいずれも
 * SPA 内の再描画なので、hashchange だけでは足りず MutationObserver が必要。
 */
function fshStartObserver() {
  fshObserver = new MutationObserver((mutations) => {
    if (fshIsRendering) {
      return;
    }
    // 自分が差し込んだ DOM 内の変更しか無い場合は再計算しない（無限ループ防止）。
    const isRelevant = mutations.some((mutation) => !fshIsOwnNode(mutation.target));
    if (isRelevant) {
      fshScheduleRecalculate();
    }
  });
  fshObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * 設定を読み込む。読めなくても既定値で動作を続ける。
 */
async function fshLoadSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    fshSettings = normalizeSettings(stored[STORAGE_KEY]);
  } catch (error) {
    fshSettings = normalizeSettings(null);
    console.warn('[freee 所定労働時間] 設定を読めなかったので既定値を使います:', error);
  }
}

/** 設定変更（options ページでの保存）に追随する。 */
function fshWatchSettings() {
  if (!chrome.storage || !chrome.storage.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      fshSettings = normalizeSettings(changes[STORAGE_KEY].newValue);
      fshScheduleRecalculate();
    }
  });
}

async function fshInit() {
  await fshLoadSettings();
  fshWatchSettings();
  window.addEventListener('hashchange', fshScheduleRecalculate);
  fshStartObserver();
  fshSafeRecalculate();
}

fshInit();
