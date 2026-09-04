# SOUNDSHOP

*Instruments for the deep end.*

The website for a four-plugin synth house: product pages, a preset library, long-form
documentation, a release changelog, and a playable VANTA synthesiser that runs in the
browser on real Web Audio DSP.

It is a **zero-build static site**. There is no bundler, no package manager, no framework
and no external network asset of any kind. Every page is plain HTML, one shared stylesheet
and a handful of vanilla-JS files loaded with `<script src>`.

---

## Quick start

Serve **either** the repository root **or** `site/` over http — both layouts work:

```sh
# from the repository root  →  http://localhost:8000/site/index.html
python -m http.server 8000
npm run web

# from site/                →  http://localhost:8000/index.html
cd site
python -m http.server 8000
npm run web
```

## Checks

Every guard in `tools/` runs from one command:

```sh
npm test                      # Node 18+, no packages, exits non-zero if any check fails
```

`npm test` runs `tools/run-checks.js`, which discovers every `tools/check-*.js` and
`tools/test-*.js` file (the runner itself and the server `tools/serve.js` excluded), sorts
them by name and runs each in its own Node process from the repository root. It prints
`PASS`/`FAIL` per script, replays the stdout/stderr of anything that failed, and ends with a
line like `run-checks: 30 passed, 0 failed (30 script(s), 6.2s)`.

```sh
node tools/run-checks.js --list          # what would run, runs nothing (also: npm run test:list)
node tools/run-checks.js --only charset  # only scripts whose filename contains "charset"
node tools/check-links.js                # any single guard still runs on its own
```

Every guard follows the same shape and new ones are picked up with no wiring: zero
dependencies, no arguments, repository-root-relative paths, a one-line summary on success,
and exit 0 on pass / non-zero on failure. Name a new one `tools/check-*.js` (a static rule)
or `tools/test-*.js` (a behavioural test) and `npm test` will run it.

### Directory indexes and "clean URLs"

`serve.json` (one at the repository root, one in `site/`) sets `"cleanUrls": false`. It is
the only configuration file in the repository and it exists for one reason: `serve` will
otherwise rewrite `/presets/index.html` to `/presets`, which drops a directory level from
the URL. Every same-directory relative reference on that page then resolves one level too
high, so the preset gallery 404s on its own JSON and the catalogue's links to
`flagship.html` point at the wrong place. Any host is fine as long as it serves a
directory index at `/dir/` or `/dir/index.html` rather than collapsing it to `/dir`.

### The `file://` caveat

Opening a page directly off disk mostly works — layout, styling, navigation and the synth
engine are all self-contained. What does **not** work is anything that reads a JSON file,
because browsers block `fetch()` for `file://` URLs. That means the changelog list and the
preset gallery come up in their error/empty state. Serve over http and both fill in.

---

## The contract

Three rules the whole repository is built around. Breaking any of them breaks the site
somewhere it will not be noticed until deploy.

**1 — No build step.** Plain HTML, CSS and ES2020 JavaScript. No modules with
`import`/`export` across files, because those need a server with correct MIME types and
break under `file://`; shared code hangs off a global namespace object instead
(`window.SS`, `window.SSSynth`, `window.SSPlugin`). What is in the repository is what gets
served.

**2 — No external assets.** No CDN scripts, no web fonts, no remote images, no analytics.
Type is set in system stacks, every graphic is inline SVG, CSS or `<canvas>`, and the one
noise texture in the stylesheet is a `data:` URI. The site works completely offline, and
loads nothing that could disappear, get blocked, or watch a visitor.

**3 — Relative, root-agnostic links.** No `href` or `src` ever begins with `/`, and nothing
hard-codes a `/site/` prefix. A page at `site/index.html` links to `plugins/flagship.html`;
a page at `site/plugins/flagship.html` links to `../presets/index.html`. This is what lets
the same tree be served from the repository root *or* from `site/` as the web root without
a rewrite rule.

The one deliberate exception is *inside data files*: link values in `site/data/changelog.json`
use a leading `/` to mean "relative to `site/`". `site/assets/js/changelog.js` strips that
slash at render time to produce a page-relative URL, and `tools/check-links.js` resolves it
against `site/`. Nothing else in the repository uses absolute paths.

---

## File map

```
README.md                          this file
site/
  data/
    changelog.json                 release history for all four products, newest first
  index.html                       home — hero with the playable mini-instrument
                                   above the fold, scope canvas, the four
                                   instruments, formats, bundle
  docs.html                        documentation: install, parameter reference,
                                   presets, MIDI/automation, troubleshooting, licence
  changelog.html                   changelog shell — filter bar + timeline container
  plugins/
    index.html                     all four instruments, compared
    flagship.html                  VANTA   — 8-voice virtual-analog polysynth, v1.4.0
    drift.html                     DRIFT   — tape delay / pitch-warping echo, v1.1.0
    prism.html                     PRISM   — 4-band spectral filter, v0.9.0 beta
    anvil.html                     ANVIL   — transient shaper + bus compressor, v2.0.1
  presets/
    index.html                     preset gallery — search, tag filter, audition
    flagship-presets.json          the VANTA preset library
  demo/
    flagship-demo.html             the full playable VANTA rack (chromeless page)
  assets/
    style.css                      the entire design system — tokens, layout, components,
                                   dark default plus a light theme and an OS-preference
                                   override. Nothing else styles anything.
    js/
      ui.js                        window.SS — chrome, theme, nav, scroll reveal,
                                   clipboard/toast, formatting helpers
      synth.js                     window.SSSynth — the VANTA browser audio engine
      home.js                      page script for index.html (hero canvas, mini-instrument)
      plugin.js                    window.SSPlugin — shared behaviour for the four
      demo.js                      page script for demo/flagship-demo.html (the rack)
      presets.js                   page script for presets/index.html (the gallery)
      changelog.js                 renderer for changelog.html
tools/
  run-checks.js                    runs every check-*.js and test-*.js below (npm test)
  serve.js                         zero-dependency static server (npm run web)
  check-links.js                   zero-dependency internal link checker
  check-store-prices.js            .d8a items:, site/data/items.json and the homepage
                                   card/bundle prices must agree; item descriptions
                                   shared by .d8a and items.json must match word for
                                   word; every items: line must be whole (no
                                   mid-sentence cut) and under 300 characters; the
                                   advertised bundle saving must equal the real
                                   difference
  check-*.js                       one static guard each — charset, JSON, JS syntax,
                                   external assets, root-relative URLs, presets,
                                   payments widget, store placeholder, and more
  test-voice-steal.js              runs the engine headless against a stub
                                   AudioContext: every noteon must be closed by
                                   exactly one noteoff, even when voices are stolen
  test-*.js                        behavioural tests — serve.js, the bought CTA,
                                   the verified-order shape, preset recall
```

Every page loads `assets/style.css` in `<head>` and `assets/js/ui.js` before `</body>`;
pages that make sound load `assets/js/synth.js` before their own page script. Page-specific
CSS lives in a `<style` block inside the page that needs it — `assets/style.css` is shared
and is never forked per page.

---

## How the audio engine and the demo UI fit together

`site/assets/js/synth.js` exposes exactly one global, `window.SSSynth`, and contains no
path, URL or DOM reference at all. It is the VANTA engine: eight voices, each with two
oscillators and a sub, a filter with its own envelope, an amp envelope, one LFO, a shared
drive → ping-pong delay → convolution reverb chain, a limiter, and an analyser tapped off
the master bus. Voices are built once and reused, so nothing is allocated per note.

The public contract is `SSSynth.PARAM_SPEC` — an array of 40 entries, one per parameter:

```js
{ name, label, group, type, min, max, step, default, unit, curve }
// enum entries also carry: options, optionLabels
```

**The UI is generated from that array, never hard-coded.** `demo.js` walks `PARAM_SPEC`,
groups the entries by `group` (`osc`, `filter`, `feg`, `amp`, `lfo`, `fx`, `arp`, `master`)
and builds a knob, fader or segmented switch for each one from its `type`, `min`, `max`,
`step` and `unit`. Three parameters carry `curve: 'log'` (`cutoff`, `lfoRate`,
`delayDamp`); a control for one of those maps its position exponentially, or the bottom
nine tenths of the range is unusable. Adding a parameter to the engine adds a control to
the rack with no markup change.

The rest of the loop:

- `SSSynth.start()` must be called inside a real user gesture — that is what the demo's
  power button is for. Everything is an inert no-op before that, and nothing ever throws.
- `SSSynth.setParam(name, value)` accepts and clamps; `SSSynth.on('param', …)` fires back so
  a preset load moves every control on screen.
- `getWaveform()`, `getSpectrum()`, `getLevel()` and `getVoiceStates()` feed the scope,
  the spectrum, the meter and the voice LEDs from one `requestAnimationFrame` loop.
- `SSSynth.loadPreset(obj)` takes either a flat `{param: value}` map or a wrapper object
  with a `params` key and performs a **total recall**: it starts from `getDefaults()`,
  overlays the keys it recognises (unknown or uncoercible ones are ignored) and returns
  every parameter the patch does *not* name to its factory default. Partial presets are
  legal and always sound the same, whatever was loaded — or turned — before them.
  `SSSynth.loadPreset(obj, { merge: true })` keeps the older additive behaviour and
  overlays the patch on the current state. `on('param', …)` fires only for parameters
  whose value actually changed; `on('preset', …)` fires once per load.
  `tools/test-preset-recall.js` guards this behaviour.
- **Note events are balanced.** `on('noteon', …)` / `on('noteoff', …)` listeners count
  events, not voices (the keybed in `demo.js` keeps a `soundingCount` per MIDI note), so
  the engine guarantees that every `noteon` it emits is closed by exactly one `noteoff`.
  The pool is eight voices: when a ninth note arrives, or a held note is re-triggered,
  the voice that is re-used first emits a `noteoff` for the note it was playing, tagged
  `source: 'steal'`. A note released before its scheduled `noteon` was reached emits its
  `noteoff` straight after it, never before it, and `panic()` emits one `noteoff` per note
  that is still owed one. `tools/test-voice-steal.js` guards this behaviour.

`site/index.html` uses the same engine for its inline mini-instrument, and
`site/presets/index.html` uses it to audition a preset from the gallery. There is one
engine and one parameter contract in the repository.

---

## Adding a preset

Presets live in `site/presets/flagship-presets.json`, a single array. Append an object in
this shape:

```json
{
  "id": "falling-apart-slowly",
  "name": "Falling Apart Slowly",
  "author": "Soundshop",
  "category": "Pad",
  "tags": ["pad", "wide", "drift"],
  "description": "Wide two-saw pad with the drift turned up.",
  "params": {
    "osc1wave": "sawtooth",
    "detune": 34,
    "cutoff": 900,
    "ampR": 2.4,
    "revMix": 0.44
  }
}
```

- `id` must be unique — the gallery uses it for the URL hash so a preset can be linked to.
- `category` and `tags` drive the gallery's filters. Reuse an existing category if one
  fits; a new one appears in the filter bar automatically.
- Every key in `params` must be a `name` from `PARAM_SPEC`. At runtime the engine hides
  mistakes: an unknown key is ignored, a number outside the spec is clamped to `min`/`max`,
  and an unknown enum string falls back to the factory default — so the card can list a
  value the synth never plays. `tools/check-presets.js` (run by `npm test`) now reads the
  `R(...)` and `E(...)` lines of `PARAM_SPEC` and fails the build on an out-of-range number
  or an enum value that is not in its option list.
- `params` may be partial, but loading a preset is total recall: any key you leave out
  snaps back to its `PARAM_SPEC` default rather than keeping the current value.

The quickest way to author one: open the demo, build the sound, and copy the parameter
snapshot out of it rather than hand-writing forty numbers.

---

## Adding a changelog entry

Add an object to the **top** of the array in `site/data/changelog.json` (the renderer sorts
defensively by date anyway, but the file reads newest-first):

```json
{
  "version": "1.4.1",
  "date": "2026-09-02",
  "product": "VANTA",
  "type": "fix",
  "title": "Short, specific, and about the change",
  "notes": [
    "One string per bullet. Say what moved in the DSP and why.",
    "If a fix is free to existing owners, say so here."
  ],
  "links": {
    "VANTA": "/plugins/flagship.html",
    "Documentation": "/docs.html"
  }
}
```

- `date` is `YYYY-MM-DD`. Entries sort newest-first; ties keep file order; an entry with a
  missing or unparseable date sinks to the bottom instead of breaking the page.
- `product` is one of `VANTA`, `DRIFT`, `PRISM`, `ANVIL`, or `Soundshop` for something that
  spans the whole shop. It drives the instrument filter chips and the per-chip counts.
- `type` is `release`, `feature`, `fix` or `beta`. It drives the type filter, the badge
  colour and the timeline dot.
- `links` is optional. **Values that point at a site page must start with `/`**, which means
  "relative to `site/`" — `/plugins/drift.html`, `/demo/flagship-demo.html`, `/docs.html`.
