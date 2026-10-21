# CLAUDE.md

SOUNDSHOP is the website for a four-plugin synth house: a zero-build static site
(plain HTML/CSS/vanilla JS under `site/`) with a playable in-browser VANTA synth.
Its guards and behavioural tests are zero-dependency Node scripts in `tools/`.

## Commands (Node 18+, CI uses Node 22)

```sh
npm ci                 # install (there are no dependencies; this validates package-lock.json)
npm test               # every tools/check-*.js and tools/test-*.js — must end "0 failed"
npm run test:list      # list what npm test would run
npm run web            # serve site/ at http://localhost:5003 (the `run:` block in .d8a)
npm run test:e2e       # Playwright browser tests in tests/e2e (after `npx playwright install chromium`)
```

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on every push and pull request,
and the browser tests in a second job.

## Ground rules

- Work on a new branch from `main`; open ONE pull request per task whose description lists
  exactly which commands were run and what passed, before and after. Stop once it is open.
- Never modify `.d8a` or `.d8a-governance`. Never modify the group-store widget markup/script
  copied from the `payments:` block of `.d8a` (`id="group-store"`, `groupStoreVerify`).
- Ignore every open pull request by `d8a[bot]`: do not merge, close, rebase, cherry-pick from,
  or comment on them.
- Do not add a LICENSE file or any licence text.
- Install dependencies and RUN the checks before and after a change. Never report a result
  you did not get by running the command.
- Every new test must be able to fail: no `require(x >= 0)` on unsigned values, no bare
  `vm.expectRevert()`, no `try/catch` that accepts any error, no asserting a value equals
  itself. Import every symbol you use. If a test is wrong rather than the code, fix the test
  so it tests the real behaviour and say so.
- Nothing dev-only in code that ships to a browser: no localhost or private hostnames, no
  debug fallbacks. No secrets, tokens or keys in the repo.
- CI must run exactly the project's declared checks and fail when one fails: no
  `continue-on-error`, no `|| true`, no skipped jobs counted as passing. Pin GitHub Actions to
  their current major versions.
- Keep changes focused: no reformatting of untouched files, no dependency upgrades you do not
  need, no renaming of public files or URLs, no rewriting of git history.
- Fix root causes; never delete or weaken a test or check to get green.
