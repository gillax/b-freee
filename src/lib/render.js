/**
 * render.js — 集計結果をコピー行の表示モデルに変換する（純粋関数のみ）
 *
 * DOM は組み立てない。ここで返すのは「ラベルと値の配列」だけで、実際の要素生成は
 * content.js が document.createElement + textContent で行う（innerHTML は使わない）。
 * こうすることで、表示文言の組み立てをテストできる。
 */

'use strict';

const renderTimeLib =
  typeof require === 'function'
    ? require('./time.js')
    : { formatHoursMinutes, parseDurationToMinutes };

/** コピー行（#fsh-summary）の aria-label。 */
const SUMMARY_ROW_TITLE = '勤怠サマリー（表示順を変更したもの）';

/**
 * コピー行に並べる項目と、その**並び順**。
 *
 * freee のサマリーは並び順を選べず、見たい項目（不足時間・時間外労働）が
 * 右の方に散っている。ここを書き換えれば表示順と項目を変えられる。
 *
 * label は freee の表示ラベルでもある（部分一致で探すので、freee 側が
 * 「時間外労働時間」でも「時間外労働」で拾える）。
 *
 * fraction を持つ項目だけ「実績 / 所定」の分数にする（分母はこの拡張の計算値）。
 * 分母を出せない期間は null を返し、freee の表示値をそのまま出す側に回る。
 * fraction が無い項目は、freee の表示値を並べ替えて出すだけ。
 */
const SUMMARY_ROW_ITEMS = Object.freeze([
  {
    label: '労働日数',
    fraction: (aggregate) =>
      aggregate.scheduledDays > 0
        ? {
            value: `${aggregate.workedDays} 日 / ${aggregate.scheduledDays} 日`,
            isOver: aggregate.workedDays > aggregate.scheduledDays,
          }
        : null,
  },
  {
    label: '総勤務時間',
    fraction: (aggregate) =>
      aggregate.scheduledMinutes > 0
        ? {
            value: `${renderTimeLib.formatHoursMinutes(
              aggregate.workedMinutes
            )} / ${renderTimeLib.formatHoursMinutes(aggregate.scheduledMinutes)}`,
            isOver: aggregate.workedMinutes > aggregate.scheduledMinutes,
          }
        : null,
  },
  { label: '不足時間' },
  { label: '時間外労働' },
  { label: '法定休日労働' },
  { label: '深夜労働' },
  { label: '有休取得数' },
]);

/** 折りたたみトグルの文言。 */
const SUMMARY_TOGGLE_LABELS = Object.freeze({
  collapsed: 'freee の元の表示を開く',
  expanded: 'freee の元の表示を閉じる',
});

/**
 * コピー行が freee から読み取るべきラベルの一覧を返す。
 *
 * @returns {string[]}
 */
function summaryRowLabels() {
  return SUMMARY_ROW_ITEMS.map((item) => item.label);
}

/**
 * freee の表示値を H:MM 表記に揃える。
 *
 * 「175時間30分」と「0時間」が混在すると横並びで読みにくいため。
 * 「0.5日」のように時間として読めない値はそのまま返す。
 *
 * @param {string} text
 * @returns {string}
 */
function formatSummaryValue(text) {
  const minutes = renderTimeLib.parseDurationToMinutes(text);
  return minutes === null ? text : renderTimeLib.formatHoursMinutes(minutes);
}

/**
 * freee サマリーのコピー行の表示モデルを作る。
 *
 * 並び順は SUMMARY_ROW_ITEMS が持つ。読み取れなかった項目は**落とす**
 * （0 として表示すると誤情報になるため）。項目が 1 つも無い場合は
 * items が空になり、content.js はコピー行を出さず元のサマリーも隠さない。
 *
 * @param {object} input
 * @param {object|null} input.aggregate - aggregate.js の集計結果（無ければ分数は出さない）
 * @param {Record<string, string>} [input.summaryItems] - extract.js の readSummaryItems の戻り値
 * @param {boolean} [input.collapsed] - freee の元サマリーを折りたたんでいるか
 * @returns {{title: string, collapsed: boolean, toggleLabel: string,
 *            items: Array<{label: string, value: string, tone: string}>}}
 */
function buildSummaryRowModel(input) {
  const summaryItems = input.summaryItems || {};
  const aggregate = input.aggregate;
  const collapsed = input.collapsed !== false;
  const items = [];

  for (const item of SUMMARY_ROW_ITEMS) {
    // 「実績 / 所定」を 1 行で出す。freee 側は折り返して 2 行になるが、
    // ここは自前の DOM なので値を nowrap のまま並べられる。
    const fraction = aggregate && item.fraction ? item.fraction(aggregate) : null;
    if (fraction) {
      items.push({
        label: item.label,
        value: fraction.value,
        tone: fraction.isOver ? 'over' : 'remaining',
      });
      continue;
    }

    // 所定が計算できない期間（休日のみなど）は freee の表示値だけ出す。
    const mirrored = summaryItems[item.label];
    if (mirrored !== undefined) {
      items.push({ label: item.label, value: formatSummaryValue(mirrored), tone: 'plain' });
    }
  }

  return {
    title: SUMMARY_ROW_TITLE,
    collapsed,
    toggleLabel: collapsed ? SUMMARY_TOGGLE_LABELS.collapsed : SUMMARY_TOGGLE_LABELS.expanded,
    items,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUMMARY_ROW_TITLE,
    SUMMARY_ROW_ITEMS,
    SUMMARY_TOGGLE_LABELS,
    summaryRowLabels,
    formatSummaryValue,
    buildSummaryRowModel,
  };
}
