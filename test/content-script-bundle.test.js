'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseHtml } = require('../test-helpers/mini-dom.js');

/**
 * このテストが守っているもの
 * ------------------------------------------------------------------
 * src/lib/*.js は「Node では require、content script ではグローバル」という
 * dual-mode で相互参照している。Node のテストだけを回していると require 側の
 * 経路しか検証されず、拡張機能として読み込んだときにだけ ReferenceError で
 * 落ちる、という事故が起こりうる。
 *
 * そこで manifest.json に書かれた順序でファイルを連結し、`require` と `module`
 * が存在しない環境（= content script の isolated world）で評価して、
 * グローバル参照だけで一式が動くことを確認する。
 */

const ROOT = path.join(__dirname, '..');

/**
 * manifest.json の content_scripts に書かれた js の並びを取得する。
 *
 * @returns {string[]}
 */
function contentScriptFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  return manifest.content_scripts[0].js;
}

/**
 * content script と同じ順序・同じスコープ共有でライブラリ群を評価する。
 *
 * @returns {object} 公開された主要関数
 */
function loadAsContentScript() {
  const files = contentScriptFiles().filter((file) => file !== 'src/content.js');
  const source = files
    .map((file) => `// ===== ${file} =====\n${fs.readFileSync(path.join(ROOT, file), 'utf8')}`)
    .join('\n');

  // module / require を undefined にすることで module.exports ガードが実行されず、
  // dual-mode の「グローバルを参照する」側の分岐が評価される。
  const factory = new Function(
    'module',
    'require',
    `${source}
    return {
      normalizeSettings, STORAGE_KEY, DEFAULT_SETTINGS,
      aggregateAttendance, extractAttendance, buildCardModel,
      VIEW_MODES, formatHoursMinutes, findSummaryContainer,
    };`
  );

  return factory(undefined, undefined);
}

test('manifest の content_scripts に必要なファイルが順番どおり並んでいる', () => {
  assert.deepEqual(contentScriptFiles(), [
    'src/lib/time.js',
    'src/lib/config.js',
    'src/lib/aggregate.js',
    'src/lib/extract.js',
    'src/lib/render.js',
    'src/content.js',
  ]);
});

test('require が無い環境（content script）でもグローバル参照だけで読み込める', () => {
  const api = loadAsContentScript();

  for (const name of [
    'normalizeSettings',
    'aggregateAttendance',
    'extractAttendance',
    'buildCardModel',
    'formatHoursMinutes',
    'findSummaryContainer',
  ]) {
    assert.equal(typeof api[name], 'function', `${name} が参照できること`);
  }
  assert.equal(typeof api.STORAGE_KEY, 'string');
  assert.equal(api.DEFAULT_SETTINGS.fallbackDailyMinutes, 480);
});

test('content script 経路でもフィクスチャから同じ結果が出る（22日 / 176:00 / 9:10）', () => {
  const api = loadAsContentScript();
  const doc = parseHtml(
    fs.readFileSync(path.join(ROOT, 'test-helpers/fixtures/table-standard.html'), 'utf8')
  );

  const settings = api.normalizeSettings(null);
  const extracted = api.extractAttendance(doc);
  const aggregate = api.aggregateAttendance(extracted.rows, {
    fallbackDailyMinutes: settings.fallbackDailyMinutes,
    workedMinutesOverride: extracted.workedMinutesOverride,
  });
  const model = api.buildCardModel({
    viewMode: extracted.viewMode,
    aggregate,
    summary: extracted.summary,
    schedulePatternHint: extracted.schedulePatternHint,
    unknownRowCount: extracted.unknownRows.length,
  });

  assert.equal(extracted.viewMode, api.VIEW_MODES.TABLE);
  assert.equal(aggregate.scheduledDays, 22);
  assert.equal(api.formatHoursMinutes(aggregate.scheduledMinutes), '176:00');
  assert.equal(api.formatHoursMinutes(aggregate.remainingMinutes), '9:10');
  assert.equal(model.available, true);
  // 新しい表示形式：「労働日数 20 日 / 22 日」「総勤務時間 166:50 / 176:00」の 2 行
  assert.deepEqual(
    model.rows.map((row) => [row.label, row.value]),
    [
      ['労働日数', '20 日 / 22 日'],
      ['総勤務時間', '166:50 / 176:00'],
    ]
  );
});

test('設定ページが読み込むライブラリも require 無しで動く', () => {
  // options.html は lib/time.js → lib/config.js の順に読み込む。
  const source = ['src/lib/time.js', 'src/lib/config.js']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
    .join('\n');
  const factory = new Function(
    'module',
    'require',
    `${source}
    return { parseDailyMinutesInput, formatSettingsForInput, DEFAULT_SETTINGS };`
  );

  const api = factory(undefined, undefined);
  assert.deepEqual(api.parseDailyMinutesInput('7:45'), { ok: true, minutes: 465 });
  assert.equal(api.parseDailyMinutesInput('なにか').ok, false);
  assert.equal(api.formatSettingsForInput(api.DEFAULT_SETTINGS), '8:00');
});

test('外部通信の API を一切使っていない', () => {
  // README と SECURITY.md が約束している「外部送信ゼロ」を機械的に検証する。
  const forbidden = [
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'sendBeacon',
    'EventSource',
    'importScripts',
    'chrome.storage.sync',
  ];

  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|html|css)$/.test(entry.name)) {
        sources.push([path.relative(ROOT, full), fs.readFileSync(full, 'utf8')]);
      }
    }
  };
  walk(path.join(ROOT, 'src'));

  for (const [file, content] of sources) {
    for (const needle of forbidden) {
      assert.equal(
        content.includes(needle),
        false,
        `${file} が ${needle} を含んでいます（外部通信・同期ストレージは使わない方針です）`
      );
    }
  }
});
