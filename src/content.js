/**
 * content.js — 勤怠編集画面にカードを差し込む薄い層
 *
 * ここだけが DOM を書き換え、chrome.* を触る。計算とテキスト生成は
 * src/lib/*.js の純粋関数に任せている（そちらは単体テスト済み）。
 *
 * 外部通信は一切しない。読み取った勤怠データはこのページの外に出ない。
 *
 * manifest.json の content_scripts で time.js → config.js → aggregate.js →
 * extract.js → render.js → content.js の順に読み込まれるため、それらの関数は
 * このファイルからグローバルとして参照できる。
 */

'use strict';

/** カードの要素 ID。冪等な差し替えのキーになる。 */
const FSH_CARD_ID = 'fsh-card';

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

/**
 * 要素がカードの内側（＝自分が作った DOM）かどうか。
 *
 * @param {Node | null} node
 * @returns {boolean}
 */
function fshIsInsideCard(node) {
  let current = node;
  while (current) {
    if (current.nodeType === 1 && current.id === FSH_CARD_ID) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
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
 * @param {{label: string, value: string, tone: string}} item
 * @returns {HTMLElement}
 */
function fshCreateItem(item) {
  const wrapper = document.createElement('div');
  wrapper.className = `fsh-item fsh-item--${item.tone}`;

  const label = document.createElement('span');
  label.className = 'fsh-item__label';
  label.textContent = item.label;

  const value = document.createElement('span');
  value.className = 'fsh-item__value';
  value.textContent = item.value;

  wrapper.append(label, value);
  return wrapper;
}

/**
 * 文字列の配列を ul として作る。
 *
 * @param {string[]} lines
 * @param {string} className
 * @returns {HTMLElement | null} 空配列なら null
 */
function fshCreateList(lines, className) {
  if (lines.length === 0) {
    return null;
  }
  const list = document.createElement('ul');
  list.className = className;
  for (const line of lines) {
    const item = document.createElement('li');
    item.textContent = line;
    list.append(item);
  }
  return list;
}

/**
 * 表示モデルからカード要素を組み立てる。
 *
 * textContent だけを使い innerHTML は使わない（ページの CSP に依存せず、
 * 読み取ったテキストを HTML として解釈させないため）。
 *
 * @param {object} model - render.js の buildCardModel の戻り値
 * @returns {HTMLElement}
 */
function fshCreateCard(model) {
  const card = document.createElement('section');
  card.id = FSH_CARD_ID;
  card.className = 'fsh-card';
  // freee 側のスクリプトから見て邪魔にならないよう、支援技術向けの情報だけ付ける。
  card.setAttribute('aria-label', model.title);

  const title = document.createElement('h2');
  title.className = 'fsh-card__title';
  title.textContent = model.title;
  card.append(title);

  if (model.available) {
    const grid = document.createElement('div');
    grid.className = 'fsh-card__grid';
    for (const item of model.rows) {
      grid.append(fshCreateItem(item));
    }
    card.append(grid);
  } else {
    const message = document.createElement('p');
    message.className = 'fsh-card__message';
    message.textContent = model.message;
    card.append(message);
  }

  const meta = fshCreateList(model.meta, 'fsh-card__meta');
  if (meta) {
    card.append(meta);
  }
  const notes = fshCreateList(model.notes, 'fsh-card__notes');
  if (notes) {
    card.append(notes);
  }

  return card;
}

/**
 * カードを挿入すべき位置にカードを置く。
 *
 * 第一候補はサマリー領域（「不足時間」を含む領域）の直後。見つからない場合は
 * ページ先頭の見出しの直後、それも無ければ body の先頭。
 *
 * すでにカードがあれば中身を差し替え、位置がずれていれば移動するだけなので、
 * 何度呼ばれても増殖しない。
 *
 * @param {HTMLElement} card
 */
function fshPlaceCard(card) {
  const summary = findSummaryContainer(document);
  if (summary && summary.parentNode) {
    if (summary.nextElementSibling !== card) {
      summary.after(card);
    }
    return;
  }

  const heading = document.querySelector('h1, h2');
  if (heading && heading.parentNode) {
    if (heading.nextElementSibling !== card) {
      heading.after(card);
    }
    return;
  }

  if (card.parentNode !== document.body) {
    document.body.prepend(card);
  }
}

/** 直前に描画した表示モデル（同じ内容なら DOM を触らないための比較用）。 */
let fshLastModelKey = '';

/**
 * カードを描画（新規挿入 or 差し替え）する。
 *
 * 表示内容が前回と同じで、かつカードが正しい位置にあるなら何もしない。
 * freee 側の再描画と自分の描画が交互に走り続けるのを避けるため。
 *
 * @param {object} model
 */
function fshRenderCard(model) {
  const modelKey = JSON.stringify(model);
  const existing = document.getElementById(FSH_CARD_ID);
  if (existing && modelKey === fshLastModelKey) {
    // 位置だけ確認して終わり（サマリー領域が作り直された場合に追随する）。
    fshWithObserverPaused(() => fshPlaceCard(existing));
    return;
  }

  fshWithObserverPaused(() => {
    const card = fshCreateCard(model);
    if (existing) {
      existing.replaceWith(card);
    }
    fshPlaceCard(card);
  });
  fshLastModelKey = modelKey;
}

/** カードを取り除く（対象画面から離れたとき）。 */
function fshRemoveCard() {
  const existing = document.getElementById(FSH_CARD_ID);
  if (!existing) {
    return;
  }
  fshWithObserverPaused(() => {
    existing.remove();
  });
  fshLastModelKey = '';
}

/**
 * 画面を読み直して再計算し、カードを更新する。
 */
function fshRecalculate() {
  if (!FSH_TARGET_HASH_PATTERN.test(location.hash)) {
    // 勤怠編集以外の画面（同じ /attendances 配下の別ルート）ではカードを出さない。
    fshRemoveCard();
    return;
  }

  const extracted = extractAttendance(document);

  if (extracted.viewMode === VIEW_MODES.UNAVAILABLE) {
    // 画面がまだ描画されていないだけの可能性がある。サマリーすら無い場合は
    // 「計算できません」と言い切らずに黙って待つ（読み込み中のちらつき防止）。
    const pageIsRendered = findSummaryContainer(document) !== null;
    if (!pageIsRendered) {
      return;
    }
    fshRenderCard(
      buildCardModel({ viewMode: extracted.viewMode, aggregate: null, summary: extracted.summary })
    );
    return;
  }

  const aggregate = aggregateAttendance(extracted.rows, {
    fallbackDailyMinutes: fshSettings.fallbackDailyMinutes,
    workedMinutesOverride: extracted.workedMinutesOverride,
  });

  fshRenderCard(
    buildCardModel({
      viewMode: extracted.viewMode,
      aggregate,
      summary: extracted.summary,
      schedulePatternHint: extracted.schedulePatternHint,
      unknownRowCount: extracted.unknownRows.length,
    })
  );
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
    // 自分のカード内の変更しか無い場合は再計算しない（無限ループ防止）。
    const isRelevant = mutations.some((mutation) => !fshIsInsideCard(mutation.target));
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
