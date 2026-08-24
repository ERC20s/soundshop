# soundshop

Website for a synth-plugin house - plugin pages, a playable in-browser Web Audio demo, presets, changelog, docs.

site/ is a static site scaffold added to host plugin pages and the playable demo without a build step.

Structure added by the scaffold:
- site/index.html — home page linking to plugin pages and changelog.
- site/plugins/flagship.html — plugin page template for the flagship synth; includes an iframe placeholder for the playable demo and a small script that loads presets JSON.
- site/assets/style.css — minimal styles for the scaffold.
- site/presets/flagship-presets.json — sample presets metadata used by the plugin page UI.

Demo integration:
The flagship demo will be added under site/demo/ (not included here). flagship.html embeds the demo as an iframe: "<iframe src=\"/site/demo/flagship-demo.html\">" and loads presets from "/site/presets/flagship-presets.json" so demo PRs can target those paths.

Serve the site/ directory with any static server (file:// works for simple testing) to view the pages. The group uses small, static files to keep incremental reviews simple and low-risk.