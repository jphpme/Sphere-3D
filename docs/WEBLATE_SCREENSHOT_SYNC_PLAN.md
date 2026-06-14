# Weblate Screenshot Sync — Planning Document

**Status:** draft for review
**Date:** 2026-06-14
**Owner:** Eric Hackathorn

## Context

Weblate lets a maintainer attach **screenshots** to source
strings. In the translator editor, a screenshot showing the
string *in situ* answers the questions a glossary entry can't:
How much space does this label have? Is "Load" a button or a
column header? Does this `{count}` sit next to a number or inside
a sentence? Good screenshots measurably cut mistranslations on
short, ambiguous UI strings — exactly the kind this app is full
of (`browse.card.load`, `browse.card.meta.added`,
`tools.toggle.labels`).

Today that field is empty, and the obvious way to fill it — a
human screenshotting each screen and hand-associating strings in
the Weblate UI — does not survive contact with development. We
ship UI continuously; a manually curated screenshot set is stale
the week after it's made, and nobody re-does it. The string
context that *is* automated, the per-string **Explanation** field
(`locales/_explanations.json` → Weblate via
[`scripts/sync-weblate-metadata.ts`](../scripts/sync-weblate-metadata.ts)
and [`.github/workflows/sync-weblate.yml`](../.github/workflows/sync-weblate.yml)),
stays fresh precisely *because* it's a CI job keyed off the repo.

This document plans a screenshot pipeline that follows that same
discipline: screenshots are **generated from the running app in
CI** and **pushed to Weblate via its REST API**, so they track
development instead of decaying away from it.

This plan pairs with [`I18N_PLAN.md`](I18N_PLAN.md) (the L1/L1.5
i18n foundation it builds on) and reuses the Weblate-token plumbing
already established for the Explanation sync.

---

## What Weblate gives us to work with

The Weblate REST API has a first-class screenshots surface:

| Endpoint | Use |
|---|---|
| `GET /api/screenshots/` | List existing screenshots (for idempotent reconcile). |
| `POST /api/screenshots/` | Create a screenshot: `name`, `image` (multipart file), `translation` (URL of the **source / `en`** translation). |
| `GET /api/screenshots/{id}/` | Read one (name, image hash, associated units). |
| `PUT/PATCH /api/screenshots/{id}/file/` | Replace the image of an existing screenshot. |
| `POST /api/screenshots/{id}/units/` | Associate a source **unit** (by id) with the screenshot. |
| `DELETE /api/screenshots/{id}/units/{unit_id}/` | Drop a stale association. |

Two facts shape the whole design:

1. **Association is by unit, and units are keyed by `context`.**
   The existing sync already relies on this: a Weblate unit's
   `context` field is our flat locale key (`browse.card.load`).
   We resolve `key → unit.id` exactly as
   `sync-weblate-metadata.ts` does today (`fetchSourceUnits()` →
   `Map<context, unit>`). The screenshot uploader can import the
   same helper rather than re-deriving it.

2. **Weblate offers OCR auto-association, but we won't rely on
   it.** Weblate can scan an uploaded image and guess which
   strings appear in it. That's lossy for short labels, icon
   buttons, and `aria-label`-only strings (which have *no* visible
   text at all). We have something far better than OCR: the app
   *knows* which keys it rendered. We associate explicitly from
   that ground truth.

---

## Design Goals

1. **Tracks development automatically.** The same property that
   keeps the Explanation field fresh: a maintainer changes the UI,
   CI regenerates and re-pushes. No human in the screenshot loop.
2. **Ground-truth association, not OCR.** Each screenshot is
   linked to the *exact* set of keys the app rendered while it was
   captured — including invisible `aria-*` strings, which are the
   ones translators most need help with.
3. **Idempotent and cheap to re-run.** Like the Explanation sync:
   skip screenshots whose image and associations are unchanged.
   Re-running on every push must be safe and mostly a no-op.
4. **Curate scenes, not strings.** A human maintains a short list
   of *scenes* ("Browse overlay, open, default filters"), never a
   string→image spreadsheet. String association falls out of the
   capture automatically.
5. **Zero impact on the shipped app.** All instrumentation is
   behind a build-time flag (the `VITE_TELEMETRY_*` precedent) and
   tree-shakes out of production bundles entirely.
6. **Reuse, don't reinvent.** Token plumbing, the unit-resolution
   helper, the idempotent-reconcile shape, and the workflow
   skeleton all already exist for the Explanation sync. This is a
   sibling of that job, not a new philosophy.

---

## Non-Goals

- **100% string coverage.** Screenshots are best-effort context,
  not a gate. Strings that never appear in a captured scene (deep
  error states, desktop-only keychain dialogs, rarely-hit toasts)
  simply have no screenshot. We report coverage; we do not fail CI
  on it.
- **Per-locale screenshots.** Screenshots attach to the **source**
  unit and are shared across all target languages, matching how
  the Explanation field works. We capture the `en` UI only.
- **Pixel-diff visual regression.** This pipeline exists to inform
  translators, not to catch UI regressions. If we later want
  visual-regression testing, it can share the Playwright harness
  but is out of scope here.
- **Translating screenshot *content*** (e.g. dataset titles inside
  the globe view). Those are catalog data, not UI strings, and are
  L3 territory in [`I18N_PLAN.md`](I18N_PLAN.md).
- **Capturing the desktop (Tauri) or VR surfaces.** Web SPA only
  in this phase; the WebXR and native shells can be added later as
  additional scene sources if the value justifies the harness
  cost.

---

## Architecture

Four pieces, three of them new:

```
┌─────────────────────┐   build flag    ┌──────────────────────┐
│  i18n runtime t()   │───VITE_I18N_────▶│  key-trace recorder  │
│  (src/i18n/index.ts)│      TRACE       │  window.__i18nTrace  │
└─────────────────────┘                  └──────────┬───────────┘
                                                     │ read per scene
┌─────────────────────┐   drives         ┌──────────▼───────────┐
│  scenes manifest    │─────scenes──────▶│  Playwright capturer  │
│ scripts/screenshots/│                  │  (headless Chromium)  │
│   scenes.ts         │                  └──────────┬───────────┘
└─────────────────────┘                             │ {png, keys[]}
                                                     │ per scene
                                          ┌──────────▼───────────┐
                                          │  Weblate uploader     │
                                          │  (REST, idempotent)   │
                                          └───────────────────────┘
```

### 1. Key-trace instrumentation (`src/i18n/index.ts`)

The single choke point for *every* resolved string is already
`t()` ([`src/i18n/index.ts:95`](../src/i18n/index.ts)). All the
attribute-escaping variants (`tHtml`, `tAttr`) and the static-
markup walker (`applyI18nAttributes.ts`) funnel through it. So one
hook captures everything — visible text, `aria-label`s, button
labels set via `textContent`, the lot — with **zero call-site
changes**.

Behind a Vite flag (`import.meta.env.VITE_I18N_TRACE`), `t()`
records each resolved key into a module-level `Set` and mirrors it
to `window.__i18nTrace` so Playwright can read it from the page
context:

```ts
// Sketch — gated so it tree-shakes out of production.
export function t<K extends MessageKey>(key: K, params?: …): string {
  if (import.meta.env.VITE_I18N_TRACE) recordKey(key as string)
  // …existing body unchanged…
}
```

The recorder also exposes `window.__i18nTrace.reset()` so the
capturer can clear the set between scenes and attribute keys to
the scene that actually rendered them.

**Why a per-scene Set and not per-DOM-node mapping?** Viewport-
precise association (this key is *this* pixel) would need every
`t()` call site to stamp its key onto a DOM node — invasive and
incomplete (many strings are `aria` attributes with no element of
their own). The Set approach says "these keys appeared on the
Browse screen," which is exactly the context a translator wants
and costs nothing at the call sites. We can layer viewport
precision on later for static `data-i18n` markup, which *already*
carries its key in the DOM.

### 2. Scenes manifest (`scripts/screenshots/scenes.ts`)

The one artifact a human maintains. Each scene is a name plus an
async setup function that navigates the app to a state worth
screenshotting:

```ts
export const scenes: Scene[] = [
  {
    name: 'browse-overlay-default',
    description: 'Dataset browser, open, no filters applied',
    async setup(page) {
      await page.goto('/?catalog=true')
      await page.getByRole('button', { name: /browse/i }).click()
      await page.waitForSelector('#browse-overlay:not(.collapsed)')
    },
  },
  // tools popover, info panel, Orbit chat, playback transport, …
]
```

Scenes are deliberately coarse — one per meaningful UI surface,
~15–25 total to start, covering the high-traffic modules in the
[CLAUDE.md](../CLAUDE.md) module map (`browseUI`, `toolsMenuUI`,
`chatUI`, `playbackController`, `datasetLoader` info panel,
`helpUI`, `privacyUI`, the catalog Graph/Map/Timeline views). The
manifest is the thing reviewers eyeball in a PR; keeping it small
and declarative is the point.

### 3. Playwright capturer (`scripts/screenshots/capture.ts`)

Headless Chromium against a locally-served production-style build
(`vite preview`, or `vite dev` with the trace flag). For each
scene:

1. `await page.evaluate(() => window.__i18nTrace.reset())`
2. `await scene.setup(page)`
3. `const keys = await page.evaluate(() => [...window.__i18nTrace.seen])`
4. `await page.screenshot({ path: out/<scene.name>.png })`

Emits a manifest `out/screenshots.json`:
`[{ name, file, sha256, keys: [...] }]`. The SHA is what makes the
upload step idempotent (see below).

Playwright is the **one new dependency** of consequence. The repo
has no browser-automation tooling today (confirmed: no Playwright/
Puppeteer/Cypress in `package.json`), so this is a deliberate
addition — installed as a `devDependency`, with the browser
binary fetched in CI via `npx playwright install --with-deps
chromium` (Chromium only, to keep the cache small).

### 4. Weblate uploader (`scripts/sync-weblate-screenshots.ts`)

A sibling of `sync-weblate-metadata.ts`, reusing its token
handling and unit-resolution. Algorithm:

1. Resolve `key → unit.id` via the existing `fetchSourceUnits()`
   pattern (refactor that helper into a shared
   `scripts/weblate-client.ts` so both syncs import it — see
   *Refactor* below).
2. `GET /api/screenshots/` and index existing screenshots by
   `name` (we name each after its scene).
3. For each scene in `out/screenshots.json`:
   - **New scene** → `POST` the image, then `POST` each resolved
     unit to `…/units/`.
   - **Existing, image SHA changed** → replace via
     `…/file/`, then reconcile unit associations (add new keys,
     remove keys no longer present).
   - **Existing, image and key set unchanged** → skip (the common
     case on re-run; this is what makes the job cheap).
4. Warn-don't-fail on keys with no matching Weblate unit (same
   posture as the Explanation sync: usually means Weblate hasn't
   pulled latest `main` yet).

Idempotency state lives entirely in Weblate (image hash +
association set), so no extra state file in the repo — mirroring
how the Explanation sync derives everything from the live unit
list.

### Refactor: shared Weblate client

`fetchSourceUnits()`, `authHeaders()`, and the project/component/
URL config currently live inside `sync-weblate-metadata.ts`.
Extract them to `scripts/weblate-client.ts` so the screenshot sync
reuses identical auth, pagination, and `key → unit` resolution.
This is a small, behaviour-preserving lift done in its own commit
before the new script lands, so the existing Explanation sync's
diff stays reviewable.

---

## CI integration

A new workflow, `.github/workflows/sync-weblate-screenshots.yml`,
modelled on `sync-weblate.yml` but heavier (it builds the app and
runs a browser), so its triggers are more conservative:

| Trigger | Rationale |
|---|---|
| `workflow_dispatch` | Always available for one-off refreshes. |
| `schedule` (weekly) | Catches drift without taxing every push. |
| `push` to `main` paths: `src/ui/**`, `src/i18n/**`, `locales/en.json`, `scripts/screenshots/**` | Only when something that could change a screenshot actually moves. |

Deliberately **not** on every PR: capturing 20 scenes in a
browser is minutes, not seconds, and we don't want to push
screenshots from un-merged branches into Weblate. PRs can run the
*capture* step (producing artifacts for review) without the
*upload* step; only `main` uploads.

Permissions stay minimal (`contents: read`), token via the
existing `WEBLATE_TOKEN` secret, `concurrency: sync-weblate-
screenshots` with `cancel-in-progress: false` — all carried over
from the Explanation workflow's hardening.

Job shape:

```yaml
- npm ci
- npx playwright install --with-deps chromium
- npm run build                       # production-style bundle
- VITE_I18N_TRACE=true npm run preview &   # serve with trace hook
- npm run screenshots:capture         # → out/screenshots.json + PNGs
- npm run screenshots:sync            # upload (main only)
  env: { WEBLATE_TOKEN: ${{ secrets.WEBLATE_TOKEN }} }
```

New npm scripts (mirroring the `sync:weblate` naming):

| Script | What it does |
|---|---|
| `screenshots:capture` | `tsx scripts/screenshots/capture.ts` |
| `screenshots:sync` | `tsx scripts/sync-weblate-screenshots.ts` |

---

## Phasing

Each phase is independently shippable and committed on its own,
per the repo's one-logical-change-per-turn discipline.

| Phase | Deliverable | Gate |
|---|---|---|
| **S1** | Trace hook in `t()` behind `VITE_I18N_TRACE`; unit test that the flag is off in a normal build and on under the flag. No CI yet. | — |
| **S2** | `scripts/weblate-client.ts` refactor; `sync-weblate-metadata.ts` switched to it (pure refactor, sync behaviour unchanged). | S1 |
| **S3** | Playwright devDependency + capturer + a *starter* `scenes.ts` (3–4 scenes: Browse, Tools, Info panel, Orbit). Output reviewable locally as artifacts; no Weblate writes. | S2 |
| **S4** | `sync-weblate-screenshots.ts` uploader (idempotent reconcile). Run manually against Weblate once, by hand, to validate the association model end-to-end before automating. | S3 |
| **S5** | `sync-weblate-screenshots.yml` workflow (dispatch + schedule + scoped `main` push). Capture-only on PRs. | S4 |
| **S6** | Broaden `scenes.ts` to the full high-traffic surface (~15–25 scenes); add a coverage report (`keys-with-screenshot / total keys`) printed by the sync, non-failing. | S5 |

S1–S2 are safe to land immediately and carry no external side
effects. S4 is the first phase that writes to Weblate and should
be validated by hand before S5 automates it.

---

## Risks & tradeoffs

- **Playwright is a real new dependency and a CI cost.** It's the
  honest price of capturing the *running* app, which is the only
  way screenshots stay truthful. We contain it: Chromium-only,
  scheduled + path-scoped rather than per-push, capture-only on
  PRs. If the harness proves valuable it also unlocks future
  visual-regression and smoke testing — but we don't pre-build for
  that here.
- **Scene drift.** A renamed selector breaks a scene's `setup()`.
  Because capture runs in CI, a broken scene *fails loudly* (the
  step errors) rather than silently shipping a blank screenshot —
  better than the manual process, where staleness is invisible.
  Scenes use role/text selectors over brittle CSS where possible.
- **Coarse association.** "This key appeared on the Browse screen"
  is less precise than "this key is this button." We judge the
  coarse version clearly net-positive over today's *nothing*, and
  the `data-i18n` static-markup path leaves a clean upgrade to
  viewport precision later without redoing the pipeline.
- **`aria`-only strings have no visible anchor.** They'll be
  associated to the scene where they're rendered but won't be
  *visible* in the image. That's acceptable — the translator at
  least sees the surrounding UI, which is more than the bare key
  gives them. The Explanation field remains the right home for
  "this is a screen-reader label."
- **Weblate API shape drift.** The screenshots endpoints are less
  exercised than the units endpoints. S4's manual validation pass
  exists specifically to confirm the create/associate/replace
  calls against the live instance before we automate them.

---

## Open questions

1. **Viewport matrix.** Desktop only, or also a portrait-mobile
   pass (the app has real ≤600px portrait behaviour per
   CLAUDE.md)? Mobile screenshots help translators reason about
   tighter space, at ~2× the capture cost. *Lean: desktop in S3–S5,
   add a mobile viewport in S6 if cheap.*
2. **Schedule cadence.** Weekly vs. only-on-path-push. *Lean:
   both, with the schedule as a safety net.*
3. **Coverage visibility.** Print coverage in the job log only, or
   also write a badge/summary artifact? *Lean: job summary in S6;
   revisit a badge if anyone asks.*
4. **Dataset-dependent scenes.** Some surfaces (info panel,
   playback transport) only populate once a dataset loads, which
   pulls live catalog data into CI. Use a fixed fixture dataset or
   a recorded mock? *Lean: a small committed fixture so capture is
   deterministic and offline.*
