'use strict';

// dev/preview.html を再生成する。
//
// フィクスチャ（test-helpers/fixtures/*.html）を埋め込んだ 1 枚の HTML を作り、
// 実サイトにアクセスせずにコピー行の見た目と再描画時の挙動を確認できるようにする。
// file:// で開くため fetch が使えないので、フィクスチャは埋め込む方式にしている。
//
// フィクスチャを更新したら再実行する:
//   node scripts/make-preview.js

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'dev', 'preview.html');

const FIXTURES = [
  ['table-standard.html', 'テーブル表示・標準（22日 / 176:00 / 残り 9:10）'],
  ['table-over-scheduled.html', 'テーブル表示・超過（160:00 に対して 165:30）'],
  ['table-mixed-schedule.html', 'テーブル表示・勤務予定が混在（通常 15 日 + 時短 7 日）'],
  ['table-holidays-only.html', 'テーブル表示・休日のみ（所定 0 日）'],
  // ラベルにサマリーのラベル文字列（「総勤務時間」など）を入れないこと。
  // プルダウンのテキストも body のテキストなので、extract.js が freee の表示として
  // 拾ってしまい、プレビューでだけ値が読めなくなる。
  ['calendar-view.html', 'カレンダー表示（サマリーの合計から概算）'],
  ['summary-full.html', 'サマリー項目が一通り揃った画面（コピー行の並び替え）'],
];

/**
 * フィクスチャの <body> の中身だけを取り出す。
 *
 * @param {string} name
 * @returns {string}
 */
function bodyOf(name) {
  const html = fs.readFileSync(path.join(REPO, 'test-helpers/fixtures', name), 'utf8');
  const match = html.match(/<body>([\s\S]*)<\/body>/);
  return match ? match[1] : html;
}

const fixtures = Object.fromEntries(FIXTURES.map(([name]) => [name, bodyOf(name)]));

const options = FIXTURES.map(
  ([name, label], index) =>
    `        <option value="${name}"${index === 0 ? ' selected' : ''}>${label}</option>`
).join('\n');

const page = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>freee 勤怠サマリー並べ替え — ローカルプレビュー</title>
    <link rel="stylesheet" href="../src/styles.css" />
    <style>
      body {
        margin: 0;
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif;
        font-size: 13px;
        color: #1a2733;
        background: #f5f7f9;
      }
      .harness {
        max-width: 1100px;
        margin: 0 auto;
      }
      .harness__controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-bottom: 16px;
        padding: 12px 16px;
        border: 1px solid #d8dde3;
        border-radius: 8px;
        background: #fffbe6;
      }
      .harness__controls select,
      .harness__controls button {
        font: inherit;
        padding: 4px 8px;
      }
      .harness__count {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
      }
      #app {
        padding: 16px;
        border: 1px solid #d8dde3;
        border-radius: 8px;
        background: #ffffff;
      }
      /* フィクスチャ側のテーブルを見やすくするだけの装飾（拡張機能とは無関係） */
      #app table {
        border-collapse: collapse;
        font-size: 12px;
      }
      #app th,
      #app td {
        padding: 2px 8px;
        border: 1px solid #e6eaee;
        text-align: left;
        white-space: nowrap;
      }
      #app .vb-summary {
        display: flex;
        gap: 24px;
        margin: 12px 0;
      }
      #app .vb-summary__item {
        display: flex;
        flex-direction: column;
      }
      #app .vb-summary__label {
        font-size: 11px;
        color: #6b7a89;
      }
      #app .vb-summary__value {
        font-size: 16px;
        font-weight: 600;
      }
      #app .vb-calendar {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 4px;
      }
      #app .vb-calendar__cell {
        padding: 4px;
        border: 1px solid #e6eaee;
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    <div class="harness">
      <div class="harness__controls">
        <strong>ローカルプレビュー</strong>
        <label for="fixture">画面:</label>
        <select id="fixture">
${options}
        </select>
        <button id="rerender" type="button">再描画（SPA の再描画を模す）</button>
        <button id="hashchange" type="button">月を切り替える（hashchange）</button>
        <span class="harness__count" id="count"></span>
      </div>
      <div id="app"></div>
    </div>

    <script>
      // content.js が触る chrome.storage を最小限スタブする（拡張機能の外で動かすため）。
      // メモリ上に保持するだけなので、折りたたみの切り替えはページを開いている間だけ残る。
      const storage = {};
      window.chrome = {
        storage: {
          local: {
            get: () => Promise.resolve({ ...storage }),
            set: (items) => {
              Object.assign(storage, items);
              return Promise.resolve();
            },
            remove: (key) => {
              delete storage[key];
              return Promise.resolve();
            },
          },
          onChanged: { addListener: () => {} },
        },
      };

      const FIXTURES = ${JSON.stringify(fixtures)};

      const app = document.getElementById('app');
      const select = document.getElementById('fixture');
      const count = document.getElementById('count');

      function load() {
        app.innerHTML = FIXTURES[select.value];
      }

      function updateCount() {
        const rows = document.querySelectorAll('#fsh-summary').length;
        count.textContent =
          'コピー行: ' + rows + ' 行' + (rows === 1 ? '（冪等 OK）' : '（要確認）');
      }

      select.addEventListener('change', load);
      document.getElementById('rerender').addEventListener('click', load);
      document.getElementById('hashchange').addEventListener('click', () => {
        const month = 1 + Math.floor(Math.random() * 12);
        location.hash = '#/work_records/2026/' + month + '/employees/12345';
      });

      // 勤怠編集画面と同じハッシュにしておく（content.js がこれを見て動く）。
      if (!location.hash.includes('work_records')) {
        location.hash = '#/work_records/2026/8/employees/12345';
      }
      load();
      setInterval(updateCount, 300);
    </script>

    <!-- manifest.json の content_scripts と同じ順序で読み込む -->
    <script src="../src/lib/time.js"></script>
    <script src="../src/lib/config.js"></script>
    <script src="../src/lib/aggregate.js"></script>
    <script src="../src/lib/extract.js"></script>
    <script src="../src/lib/render.js"></script>
    <script src="../src/content.js"></script>
  </body>
</html>
`;

fs.writeFileSync(OUT, page);
console.log('wrote ' + OUT + ' (' + page.length + ' bytes)');
