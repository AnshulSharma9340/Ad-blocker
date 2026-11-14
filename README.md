# Advanced Ad Blocker (Chrome / Edge, Manifest V3)

A from-scratch ad & tracker blocker in the style of **uBlock Origin Lite**. It
uses real community filter lists (EasyList + EasyPrivacy) converted into Chrome's
`declarativeNetRequest` rules, plus cosmetic (element-hiding) selectors.

## What it does

- **Network blocking** — ~29,000 rules block requests to ad/tracker servers
  before they load.
- **Cosmetic hiding** — ~30,000 selectors hide leftover ad boxes/banners.
- **Per-site allowlist** — turn blocking off for individual sites.
- **Global on/off** and a **blocked-request counter** on the toolbar icon.
- **YouTube ad blocking** (`youtube.js`) — best-effort, the way uBlock/Brave do
  it: it prunes the ad data out of YouTube's player API response and auto-skips
  any ad that still plays. Honors the global/per-site toggle.

## Honest limitations

No blocker stops 100% of ads, and neither does this one:

- **YouTube ads** are attempted (see `youtube.js`) but it's a cat-and-mouse
  fight — YouTube changes its code and adds "ad blocker detected" popups, so the
  module breaks periodically and needs updating. It is best-effort, not perfect.
- **First-party ads** (Facebook feed, promoted tweets, sponsored search results)
  look like normal page content and mostly get through.
- **Manifest V3** caps blockers at ~30,000 enabled static rules, so this carries
  a strong subset of the full lists — not the entire 100k+ EasyList universe.

It will, however, block the large majority of third-party ads and trackers.

### How the YouTube module works

`youtube.js` runs in the page's own JavaScript context (`"world": "MAIN"`) so it
can intercept YouTube's internal API:

1. It wraps `fetch`/`XHR` and, for `youtubei/v1/player` (and `next`) responses,
   deletes the `adPlacements` / `playerAds` / `adSlots` fields before the player
   reads them — so most ads never load.
2. A DOM fallback clicks "Skip", closes overlays, and fast-forwards any ad video
   that still plays, and dismisses the anti-adblock popup.

If YouTube ad blocking ever breaks, that file is where to look.

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`D:\ad-blocker`).
4. The shield-like icon appears in the toolbar. Click it for the controls.

> The live blocked-counter uses `onRuleMatchedDebug`, which only works for
> unpacked (developer-mode) extensions — exactly how you're loading it here.

## Update the filter lists

The rule files under `rules/` and `data/cosmetic.json` are generated. To refresh
them from the latest EasyList/EasyPrivacy:

```
node tools/build-filters.mjs
```

Then reload the extension on the extensions page. (In MV3, bundled static rules
can't auto-update at runtime — you re-run the build and reload, the same way
uBlock Origin Lite ships list updates via new versions.)

## Project layout

| File / folder            | Purpose                                                   |
|--------------------------|-----------------------------------------------------------|
| `manifest.json`          | Extension manifest (MV3).                                 |
| `rules/easylist.json`    | Generated network-block rules from EasyList.              |
| `rules/easyprivacy.json` | Generated network-block rules from EasyPrivacy.           |
| `data/cosmetic.json`     | Generated element-hiding selectors (generic + per-site).  |
| `background.js`          | Counter, global on/off, allowlist (dynamic rules).        |
| `content.js`             | Injects cosmetic-hiding CSS; flags YouTube blocker on/off.|
| `youtube.js`             | MAIN-world YouTube ad blocker (prune + auto-skip).        |
| `popup.html/.css/.js`    | Toolbar popup UI.                                          |
| `tools/build-filters.mjs`| Downloads + converts the filter lists.                    |
| `tools/make-icons.mjs`   | Generates the toolbar icons.                              |

## Tuning

- **More/fewer rules:** edit the `cap` values in `tools/build-filters.mjs`
  (keep the combined total under ~30,000).
- **Add lists:** add entries to the `LISTS` array (e.g. a regional EasyList).
- **Too aggressive on a site:** use the per-site toggle in the popup, or remove
  selectors from the generic set if a specific page breaks.
