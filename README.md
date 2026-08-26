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
npx serve .

# from site/                →  http://localhost:8000/index.html
cd site
python -m http.server 8000
npx serve .
```

Then check the internal links:

```sh
node tools/check-links.js     # Node 18+, no packages, exits non-zero on a missing target
```

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
  index.html                       home — hero scope canvas, the four instruments,
                                   inline playable mini-instrument, formats, bundle
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
                                   product pages
      demo.js                      page script for demo/flagship-demo.html (the rack)
      presets.js                   page script for presets/index.html (the gallery)
      changelog.js                 renderer for changelog.html
tools/
  check-links.js                   zero-dependency internal link checker
```

Every page loads `assets/style.css` in `<head>` and `assets/js/ui.js` before `</body>`;
pages that make sound load `assets/js/synth.js` before their own page script. Page-specific
CSS lives in a `<style>` block inside the page that needs it — `assets/style.css` is shared
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
  with a `params` key, applies only the keys it recognises, and leaves everything else
  where it was. Partial presets are legal.

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
- Every key in `params` must be a `name` from `PARAM_SPEC`. Unknown keys are ignored and
  out-of-range values are rejected rather than clamped, so a typo fails silently — check a
  new preset by auditioning it in the gallery.
- `params` may be partial. Keys you leave out keep whatever the engine currently has.

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
  The renderer rewrites them to page-relative URLs, and `tools/check-links.js` verifies that
  every one of them exists on disk. The object key is the visible link label.
- Everything is rendered with `createElement` and `textContent`, so nothing in this file can
  inject markup into the page. Write plain text; no HTML in `title` or `notes`.

`site/assets/js/changelog.js` looks for the data at `data/changelog.json` and then at
`../data/changelog.json`. Both are resolved against the *page* that loaded the script —
`site/changelog.html` — not against the script itself, so the first candidate is
`site/data/changelog.json`, which is where the file lives. That one path resolves under
either web root. Nothing outside the served tree can ever be reached: with `site/` as the
web root, `../` cannot climb above the server root, so a copy kept at the repository root
would be unreachable there. If neither candidate resolves, the page shows an honest error
naming both paths rather than an empty page.

If a copy also exists at the repository root (`data/changelog.json`), it is a legacy mirror
that no page loads. Edit `site/data/changelog.json`.

---

## The link checker

`tools/check-links.js` is the only tooling in the repository. Zero dependencies, Node 18+,
run it from anywhere in the tree:

```sh
node tools/check-links.js
```

It walks every `.html`, `.js` and `.css` file under `site/` and collects:

- `href="…"` and `src="…"` attributes,
- `fetch('…')` string literals,
- arrays of two or more quoted paths, treated as **fallback lists** — the check passes when
  at least one candidate exists (this is what `JSON_PATHS` in `changelog.js` relies on),
- `url(…)` references and `@import` targets, from `.css` files and from `<style>` blocks
  inside HTML.

It then walks every `.json` file under `site/data/` and under a repository-root `data/`
directory if one is present, finds any `"links": { … }` object at any depth, and checks
those values too.

Each target is resolved against the directory of the file it appears in — a leading `/`
resolves against `site/` — and a relative target inside a `.js` file is additionally tried
against every directory under `site/` that holds an HTML document, because a shared script
resolves its `fetch()` paths against the page that loaded it, not against itself. Anything
that does not exist on disk is printed as `file:line  target -> resolved` and the process
exits `1`.

**Deliberately skipped**, and relied on:

- `data-*` attributes. A path a page probes at runtime, or hands to a script, belongs in a
  `data-*` attribute (`data-src`, `data-demo-src`) — the checker ignores those, so a page may
  reference something optional without failing the build.
- `http(s):`, `mailto:`, `data:` and protocol-relative `//host` values, and bare `#fragment`
  values. That is why inline `data:` URIs and `url(#filter)` SVG references never trip it.
- Whether a `#fragment` on an otherwise-valid target actually exists in the target file.
  Only file existence is verified.

Consequences worth internalising before you write a line: **never write an `href`/`src` to a
file that is not in the repository**, and **never put a real relative path in a quoted string
in JS** — including inside a template literal that builds markup — unless the file exists.
Optional or runtime-built paths go in a `data-*` attribute.

---

## Products

| Instrument | What it is | Version | Price |
| --- | --- | --- | --- |
| VANTA | 8-voice virtual-analog polysynth | 1.4.0 | $149 |
| DRIFT | Tape-modelled delay & pitch-warping echo | 1.1.0 | $79 |
| PRISM | 4-band spectral filter / formant morpher | 0.9.0 public beta | $69 |
| ANVIL | Transient shaper + saturating bus compressor | 2.0.1 | $89 |

All four ship in **The Full Shop** bundle at $299. Formats: VST3, AU, AAX, CLAP —
macOS 11+ (Universal), Windows 10+ (x64), Linux (x64, VST3/CLAP). VANTA is the instrument
the in-browser demo actually implements.
