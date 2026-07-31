# freee Attendance Summary Reorder

*[日本語版はこちら](README.ja.md)*

A small, auditable Chrome extension (Manifest V3) that **reorders the summary bar
on the attendance edit screen of freee 人事労務 (freee HR)** — and adds the
**scheduled (contracted) figures as denominators**, so you can read
"actual / scheduled" at a glance.

Target URL:
`https://p.secure.freee.co.jp/attendances#/work_records/<year>/<month>/employees/<employeeId>`

> **Japanese UI only.** The extension recognises the screen by its Japanese
> labels. On an English freee UI it renders nothing and leaves the page
> untouched. See [Scope and limitations](#scope-and-limitations).

## Why it exists

- freee's summary bar has a **fixed order**, and the numbers people look at most
  (`不足時間` / shortage, `時間外労働` / overtime) sit far to the right.
- The summary shows `労働日数` (days *worked*) but never the **scheduled** number
  of working days, so "20 日" is easy to misread as "the month has 20 working
  days". In the month this was verified against, the scheduled figure was 22.
- `不足時間` ("shortage") is shown without saying what it is a shortage *of*.

## What it does

It inserts a **copy of the summary, in the order you want**, immediately before
freee's own summary bar, and **collapses the original** (it is hidden, never
removed — a button at the end of the row brings it back).

```
労働日数       総勤務時間         不足時間  時間外労働  法定休日労働  深夜労働  有休取得数
20 日 / 22 日  166:50 / 176:00   9:10     9:30       0:00         0:00     0.5日
                                                              [ freee の元の表示を開く ]
```

- The order and the set of items live in `SUMMARY_ROW_ITEMS`
  ([src/lib/render.js](src/lib/render.js)). Edit that one table to change either.
- **`労働日数` and `総勤務時間` are shown as "actual / scheduled" on a single
  line** (freee wraps them onto two lines).
- Every other item is freee's own displayed value, simply **reordered**. Items
  that cannot be read are dropped rather than shown as `0`.
- If **no** item can be read, the copy row is not inserted and the original bar
  is left visible — the extension never hides information it failed to replace.
- Items where the actual exceeds the scheduled figure change colour.
- Durations are normalised to `H:MM` (`175 時間 30 分` → `175:30`). Values that
  are not durations (`0.5日`) are passed through unchanged.

The denominator this extension computes is based on **scheduled working hours**
(所定労働時間). freee's own "残業モニター" is a forecast against the statutory
limit under a 36協定 agreement — a different baseline.

## Why you can trust it

There is **no build step**: what you see in this repository is exactly what
runs. The claims below are enforced by a unit test that greps the shipped
sources, so they cannot silently rot.

- **No network access of any kind.** No `fetch`, `XMLHttpRequest`, `WebSocket`,
  `sendBeacon`. No analytics. Everything is computed in the page.
- **No `host_permissions`.** A declarative content script only needs
  `content_scripts.matches`; the extension never makes cross-origin requests, so
  the permission is not requested at all.
- **The only permission is `storage`**, used for two settings (a fallback
  daily-hours value and whether the original bar is collapsed).
  **Attendance data is never stored** — it is read, rendered, and forgotten.
- **`chrome.storage.sync` is never used**, so nothing is synced to your Google
  account.
- **No `innerHTML`.** Everything the extension renders goes through
  `textContent`, so page text can never become markup.
- **No `web_accessible_resources`**, so no web page can load the extension's
  files.
- **Zero dependencies**, no service worker, no background page.

The extension writes to freee's DOM in exactly two ways: it inserts one sibling
element, and it sets `display` on one existing element. It never touches input
fields, and it never submits anything.

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this repository's folder (the one with
   `manifest.json`).
5. Reopen the freee attendance edit screen.

No build required (no bundler, no npm dependencies).

## Settings

Open them from the toolbar icon, or via "Extension options" on
`chrome://extensions`.

| Setting | Default | When it is used | Where to change it |
| --- | --- | --- | --- |
| Scheduled hours per day | `8:00` | Only when the daily figure cannot be derived from the `勤務予定` (shift) column — e.g. the calendar/list views, or rows with no shift | Options page |
| Collapse freee's own summary | Collapsed | Applied only when the copy row could actually be rendered | The button on the copy row |

Settings are stored in `chrome.storage.local` only.

## How the numbers are calculated

Column positions are resolved from the table headers (`勤務日種別`, `勤務予定`,
`休憩`, `総勤務`), so column order can change without breaking anything.

1. **Scheduled working days** = rows whose `勤務日種別` is `所定労働日`
   (`所定休日` / `法定休日` are excluded).
2. **Scheduled hours per day** = shift end − shift start − break
   (e.g. `09:00-18:00` − `1:00` = `8:00`).
   - Rows are **grouped by shift**, and each group contributes
     `days × its own daily hours`. Shorter-hours contracts and mid-period
     changes therefore do not collapse into "days × one fixed number".
   - A missing break is filled with the modal break of rows sharing that shift.
   - If the shift itself cannot be read, the configured fallback is used.
3. **Scheduled hours** = the sum over those groups (the denominator).
4. **Total worked** = the sum of `総勤務` over all rows (holiday work included).
5. **Days worked** = rows where `総勤務` is greater than zero.

Half-day paid leave needs no special handling: freee already counts the leave
portion inside `総勤務`, so `scheduled − total worked` matches freee's `不足時間`.

### Views other than the table

The calendar and list views do not expose per-row `総勤務` / `休憩`, so the
extension approximates: day counts come from counting `所定労働日` /
`所定休日` / `法定休日` labels (**exact** matches only, so legends and prose are
not counted), while total worked and days worked are taken from the summary bar
values it already read. If the day count is not plausible for one month (28–31)
or the total cannot be read, it **omits the denominators** instead of printing a
number it cannot stand behind.

## How the code is organised (no bundler)

Each file declares plain functions at the top level and ends with:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { /* … */ };
}
```

- **In the content script**, the libraries are listed in `manifest.json` before
  `src/content.js`, so they are simply globals in the same isolated world (the
  guard is skipped because `module` is undefined there).
- **In the options page**, they are loaded with `<script src="lib/…">`.
- **Under Node** (unit tests), `require()` triggers the guard.

All `chrome.*` and DOM-mutating code is a thin layer over pure functions, which
is what makes the logic testable.

### Files

```
manifest.json            MV3 manifest (permissions, matches, scripts)
src/content.js           The only DOM-mutating layer: observe, insert, collapse
src/options.html         Settings UI (toolbar popup and options page)
src/options.js           Settings read/write
src/styles.css           .fsh-* styles for the copy row + options page
src/lib/time.js          Pure: duration parsing and formatting ("166:50" ⇄ minutes)
src/lib/config.js        Pure: setting defaults and normalisation
src/lib/aggregate.js     Pure: scheduled days / scheduled hours / worked totals
src/lib/extract.js       DOM adapter (the document is always passed in)
src/lib/render.js        Pure: aggregate → copy-row view model (order lives here)
test/*.test.js           Unit tests (node:test)
test-helpers/mini-dom.js A dependency-free minimal HTML parser (instead of jsdom)
test-helpers/fixtures/   Synthetic HTML fixtures of the attendance screen
dev/preview.html         Local preview — inspect the UI without the real site
docs/design/             Design notes (Japanese)
icons/                   Icons (SVG source + generated PNGs)
scripts/make-icons.sh    Regenerate the PNGs from the SVG
scripts/make-preview.js  Regenerate dev/preview.html
```

## Running the unit tests

No dependencies to install:

```bash
node --test
```

The fixtures exist so the project can be developed without touching the real
site; **all of them are synthetic data**.

| Fixture | What it covers |
| --- | --- |
| `table-standard.html` | The verified case: 22 scheduled days / 176:00 / 166:50 worked (one half-day, two unfilled days, nine holidays, a totals row) |
| `table-holidays-only.html` | A period with holidays only (zero scheduled days) |
| `table-over-scheduled.html` | Fully filled in and over the scheduled hours (165:30 against 160:00) |
| `table-mixed-schedule.html` | Mixed shifts (15 regular days + 7 shorter days → 162:00) |
| `calendar-view.html` | Approximation when there is no table |
| `summary-full.html` | A full summary bar, including legend colour marks and help icons |

`test-helpers/mini-dom.js` **does not understand class selectors**. The fact
that the tests pass against fixtures full of class names is itself the proof
that `extract.js` does not depend on freee's class names.

## Local preview (no freee account needed)

```bash
open dev/preview.html    # macOS; on Windows/Linux just open it in a browser
```

`dev/preview.html` embeds the fixtures in a single page, loads the scripts from
`src/` in the same order as `manifest.json`, and stubs only `chrome.storage`.
Use the dropdown to switch fixtures, the **redraw** button to simulate the SPA
re-rendering (the counter in the corner must stay at one copy row), and the
toggle button to check the collapse behaviour.

Regenerate it with `node scripts/make-preview.js` after changing a fixture.

## If freee's DOM changes

Everything this extension depends on is **displayed text**. In order:

1. **Column keywords** — `COLUMN_KEYWORDS` in [src/lib/extract.js](src/lib/extract.js)
   (only four columns: `勤務日種別` / `勤務予定` / `休憩` / `総勤務`). Matching is
   substring-based, and column order does not matter.
2. **Day-type labels** — `DAY_TYPE_LABELS` in [src/lib/aggregate.js](src/lib/aggregate.js).
3. **Summary labels** — `SUMMARY_LABELS` in [src/lib/extract.js](src/lib/extract.js).
   `不足時間` doubles as the anchor that locates the summary bar, so if it
   changes the copy row stops appearing.
4. **Copy-row items and order** — `SUMMARY_ROW_ITEMS` in
   [src/lib/render.js](src/lib/render.js). Prefer the shorter label (freee's
   `時間外労働時間` is matched by `時間外労働`).

Everything the extension injects carries a `data-fsh` attribute, and
`extract.js` skips those subtrees for both text and element lookups — otherwise
it would read back its own `労働日数` / `不足時間` as if freee had printed them.
Always create injected nodes through `fshCreateElement()` in
[src/content.js](src/content.js).

When fixing a breakage, add a fixture that reproduces the new DOM first, watch
the tests fail, then fix. Never add selectors that depend on class names or DOM
nesting.

Debugging hint: if the copy row does not appear, look for console warnings
starting with `[freee 所定労働時間]`.

## Scope and limitations

- **Japanese UI only.** All matching is against Japanese labels; on an English
  freee UI nothing is rendered and the page is left as-is.
- Only the attendance edit screen (URLs whose hash contains `work_records`).
- The daily figure is derived from a **fixed start/end shift**. Under flexitime,
  discretionary-work systems, or a variable working-hours system, the shift
  column may be empty or meaningless, in which case the denominator falls back
  to `configured hours × scheduled days` and can disagree with freee.
- Which items the summary bar contains depends on the employer's freee settings.
  Missing items are dropped, so the row is shorter for some people.
- Mid-period joiners/leavers and mid-period contract changes can make the
  computed denominator disagree with freee's `不足時間`. **`不足時間` itself is
  always freee's own value**, so trust that one when they differ.
- Calendar/list views are approximations; switch to the table view for exact
  numbers.
- Verified against **one tenant and one month**. It is written to be generic,
  but it has not been proven generic.
- Not affiliated with freee K.K. — an unofficial tool.

## Security

No data ever leaves the page, and no attendance data is persisted. See
[SECURITY.md](.github/SECURITY.md) (Japanese) for the full threat model and how
to report a vulnerability privately.

## License

[MIT](LICENSE) © gillax
