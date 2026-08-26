# soundshop

Website for a synth-plugin house - plugin pages, a playable in-browser Web Audio demo, presets, changelog, docs.

site/ is a static site scaffold added to host plugin pages and the playable demo without a build step.

Structure added by the scaffold:
- site/index.html — home page linking to plugin pages, the presets gallery and changelog.
- site/plugins/flagship.html — plugin page template for the flagship synth; probes for the playable demo and embeds it only if it exists, and has a small script that loads a short presets list (name and author only) plus a link to the full gallery.
- site/presets/index.html — standalone presets gallery page; fetches flagship-presets.json from the same directory and renders every preset as a card with its full params object (not just name and author).
- tools/check-links.js — zero-dependency Node script that fails when a page points at an internal file that is not in the repository.
- site/assets/style.css — minimal styles for the scaffold, including the .preset-cards/.preset-card layout used by the gallery.
- site/presets/flagship-presets.json — sample presets metadata used by both the plugin page's short list and the full gallery page.

- site/changelog.html, site/changelog.css, site/changelog.js — changelog page; the JS renders data/changelog.json from the repository root.

Paths:
All pages use relative, root-agnostic links, so the site works whether the repository root or site/ is served as the web root. Nothing hard-codes a leading "/site/" prefix any more. If you deploy under a fixed path prefix, re-test the links rather than reintroducing absolute paths.

Demo integration:
The flagship demo will be added under site/demo/ (not included here). flagship.html does not hard-code an iframe to it any more: the section "<div id=\"demo-slot\" data-demo-src=\"../demo/flagship-demo.html\">" shows a plain "not published yet" message, and an inline script fetches that path and swaps in an iframe (title "Flagship demo", 360px tall) only when the response is ok. A demo PR only has to add site/demo/flagship-demo.html at that path and the page picks it up. Presets are still loaded from "../presets/flagship-presets.json".

Checking links:
Run "node tools/check-links.js" (Node 18+, no packages) from anywhere in the repository. It scans every .html and .js file under site/ for href/src attributes, fetch('...') literals and fallback lists such as JSON_PATHS in site/changelog.js, resolves each relative to the file it appears in, and exits non-zero listing anything that is not on disk. A fallback list passes when at least one of its candidates exists. Optional, runtime-probed targets belong in data-* attributes (like data-demo-src), which the checker deliberately ignores; bare "#" placeholders and external http(s)/mailto links are skipped too.

Serving:
Serve either the repository root or site/ over http with any static server, for example "python -m http.server" from one of those directories. Opening the pages with file:// shows the styling but leaves the presets and changelog empty, because browsers block fetch() for file:// URLs. Serving the repository root is the only layout where the changelog JSON at data/changelog.json is reachable; site/changelog.js tries "data/changelog.json" and then "../data/changelog.json" so both layouts are attempted before the error message is shown.

The group uses small, static files to keep incremental reviews simple and low-risk.