/**
 * render.js — 集計結果をカードの表示モデルに変換する（純粋関数のみ）
 *
 * DOM は組み立てない。ここで返すのは「ラベルと値の配列」だけで、実際の要素生成は
 * content.js が document.createElement + textContent で行う（innerHTML は使わない）。
 * こうすることで、表示文言の組み立てをテストできる。
 */

'use strict';

const renderTimeLib =
  typeof require === 'function'
    ? require('./time.js')
    : { formatHoursMinutes, formatJapaneseDuration };

const renderAggregateLib =
  typeof require === 'function' ? require('./aggregate.js') : { WARNING_CODES };

const renderExtractLib =
  typeof require === 'function' ? require('./extract.js') : { VIEW_MODES };

/** カードのタイトル。 */
const CARD_TITLE = '所定労働時間と残り';

/**
 * 常に表示する注記。
 *
 * freee の「残業モニター」は 36 協定（法定労働時間）ベースの予測なので、
 * この拡張が出す所定ベースの残りとは基準が違う。混同を避けるために必ず出す。
 */
const BASIS_NOTE =
  '所定労働時間ベースの計算です。freee の「残業モニター」（36協定＝法定労働時間ベースの予測）とは基準が異なります。';

/** テーブル表示以外でデータが取れなかったときの案内。 */
const UNAVAILABLE_MESSAGE =
  '所定労働日数を読み取れませんでした。表示を「テーブル」に切り替えると計算できます。';

/**
 * 集計結果とページから読み取った情報をカードの表示モデルに変換する。
 *
 * @param {object} input
 * @param {string} input.viewMode - extract.js の VIEW_MODES
 * @param {object|null} input.aggregate - aggregate.js の集計結果
 * @param {object} [input.summary] - extract.js が読んだサマリー表示値
 * @param {string} [input.schedulePatternHint] - カレンダー表示で拾った勤務予定
 * @param {number} [input.unknownRowCount] - 集計対象外だった行数
 * @returns {{title: string, available: boolean, message: string,
 *            rows: Array<{label: string, value: string, tone: string}>,
 *            meta: string[], notes: string[]}}
 */
function buildCardModel(input) {
  const { formatHoursMinutes: hm, formatJapaneseDuration: ja } = renderTimeLib;
  const summary = input.summary || {};
  const aggregate = input.aggregate;

  if (input.viewMode === renderExtractLib.VIEW_MODES.UNAVAILABLE || !aggregate) {
    return {
      title: CARD_TITLE,
      available: false,
      message: UNAVAILABLE_MESSAGE,
      rows: [],
      meta: [],
      notes: [BASIS_NOTE],
    };
  }

  // 所定を分母、実績を分子にした 2 行にまとめる。実績と所定の差（残り／超過）は
  // 分数を見れば読み取れるので、独立した「所定まで残り」行は出さない。
  //   例) 労働日数    20 日 / 22 日
  //       総勤務時間  166:50 / 176:00
  const daysOverScheduled = aggregate.workedDays > aggregate.scheduledDays;
  const timeOverScheduled = aggregate.workedMinutes > aggregate.scheduledMinutes;
  const rows = [
    {
      label: '労働日数',
      value: `${aggregate.workedDays} 日 / ${aggregate.scheduledDays} 日`,
      tone: daysOverScheduled ? 'over' : 'remaining',
    },
    {
      label: '総勤務時間',
      value: `${hm(aggregate.workedMinutes)} / ${hm(aggregate.scheduledMinutes)}`,
      tone: timeOverScheduled ? 'over' : 'remaining',
    },
  ];

  const meta = [];
  if (summary.periodLabel) {
    // 画面の表示月と実際の勤務期間はずれることがあるので、対象期間を必ず出す。
    meta.push(`対象期間: ${summary.periodLabel}`);
  }
  // 分数だけだと残り時間が読み取りづらいので、日本語表記で補助的に出す。
  if (aggregate.scheduledMinutes > 0) {
    const label = aggregate.isOver ? '所定を超過' : '所定まで残り';
    meta.push(`${label}: ${ja(aggregate.remainingMinutes)}`);
  }
  for (const line of describeScheduleGroups(aggregate, input.schedulePatternHint)) {
    meta.push(line);
  }

  const notes = [];
  for (const code of aggregate.warnings) {
    const note = describeWarning(code, aggregate, input);
    if (note) {
      notes.push(note);
    }
  }
  if (input.unknownRowCount > 0) {
    notes.push(
      `勤務日種別が「所定労働日 / 所定休日 / 法定休日」以外の行が ${input.unknownRowCount} 行あり、集計に含めていません。`
    );
  }

  // freee 自身の表示との突き合わせ。超過している月は freee 側の不足時間が 0 になるため
  // 比較しない。また、所定が 0 の月（休日のみ）は比較する意味がない。
  if (
    typeof summary.shortageMinutes === 'number' &&
    !aggregate.isOver &&
    aggregate.scheduledMinutes > 0
  ) {
    if (summary.shortageMinutes === aggregate.remainingMinutes) {
      meta.push('freee 表示の「不足時間」と一致しています。');
    } else {
      notes.push(
        `freee 表示の「不足時間」（${ja(summary.shortageMinutes)}）と差があります。` +
          '所定の変更や月中入退社がある期間ではずれることがあります。'
      );
    }
  }

  notes.push(BASIS_NOTE);

  return { title: CARD_TITLE, available: true, message: '', rows, meta, notes };
}

/**
 * 「09:00-18:00（休憩1:00）= 8:00 × 22日」のような内訳行を作る。
 *
 * @param {object} aggregate
 * @param {string} [schedulePatternHint]
 * @returns {string[]}
 */
function describeScheduleGroups(aggregate, schedulePatternHint) {
  const hm = renderTimeLib.formatHoursMinutes;
  return aggregate.scheduleGroups.map((group) => {
    if (group.usedFallback) {
      const hint = schedulePatternHint ? `勤務予定 ${schedulePatternHint}` : '勤務予定を取得できず';
      return `内訳: ${hint} / 1日 ${hm(group.dailyMinutes)}（設定値）× ${group.days}日`;
    }
    // 全角括弧のあとに半角スペースを重ねないよう、休憩が無い場合だけスペースを入れる。
    const breakLabel = group.breakMinutes > 0 ? `（休憩 ${hm(group.breakMinutes)}）` : ' ';
    return `内訳: ${group.scheduleText}${breakLabel}= 1日 ${hm(group.dailyMinutes)} × ${group.days}日`;
  });
}

/**
 * 警告コードを表示文言にする。
 *
 * @param {string} code
 * @param {object} aggregate
 * @param {object} input
 * @returns {string} 表示しないコードは空文字
 */
function describeWarning(code, aggregate, input) {
  const hm = renderTimeLib.formatHoursMinutes;
  const codes = renderAggregateLib.WARNING_CODES;

  switch (code) {
    case codes.NO_SCHEDULED_WORKDAYS:
      return 'この期間に所定労働日がありません。';
    case codes.FALLBACK_SCHEDULE_USED:
      return `勤務予定から 1 日の所定労働時間を算出できなかったため、1 日 ${hm(
        aggregate.fallbackDailyMinutes
      )} として計算しています（拡張機能の設定で変更できます）。`;
    case codes.MULTIPLE_SCHEDULES:
      return `勤務予定が ${aggregate.scheduleGroups.length} 種類あるため、勤務予定ごとに所定労働時間を合算しています。`;
    case codes.MISSING_WORKED_ENTRIES:
      return `勤怠が未入力の所定労働日が ${aggregate.missingWorkedDays} 日あります。`;
    case codes.HOLIDAY_WORK_INCLUDED:
      return `休日の勤務 ${hm(aggregate.holidayWorkMinutes)} も総勤務時間に含めています。`;
    case codes.WORKED_FROM_SUMMARY:
      return '総勤務時間はサマリーの表示値を使っています。表示を「テーブル」に切り替えるとより正確に計算できます。';
    default:
      return '';
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CARD_TITLE,
    BASIS_NOTE,
    UNAVAILABLE_MESSAGE,
    buildCardModel,
    describeScheduleGroups,
    describeWarning,
  };
}
