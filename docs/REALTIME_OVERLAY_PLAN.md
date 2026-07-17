# Realtime Dataset Overlay — Plan for VR AYNI

**Created:** 2026-06-27
**Status:** Planning (no code yet)
**Origin:** Deep-dive comparison between AYNI2 (the desktop product, `C:\Users\jphur\Documents\VS Code\AYNI2`) and VR AYNI (this repo). The goal is to bring AYNI2's "overlay real-time datasets (global and local)" capability into VR.

---

## 1. Objective

Bring the ability to **overlay multiple real-time datasets (global and local/regional) on the VR globe**, as AYNI2 already does on its desktop sphere. Concretely:

- Show a base dataset (e.g. Earth) with one or more realtime layers composited on top (e.g. aircraft traffic + vessel traffic + clouds).
- Support **global** overlays (full-equirect alpha) and **local/regional** overlays (clipped to a geographic bounding box).
- Optionally sync the layers to a shared real-world data time.
- Manage layers from inside VR (enable/visibility, opacity, order).

---

## 2. How AYNI2 does it (reference architecture)

AYNI2's realtime overlay subsystem rests on four pillars:

1. **DSA composition-role metadata** (`rt-dataset-classifier.ts`) — datasets declare `composition.roles` (`base`/`overlay`), `composition.overlay.type` (`alpha-overlay` = global, `regional-mask` = local), `requiresAlpha`, and `metadata.geo.bounds`. Admission is metadata-driven, not heuristic.
2. **Multi-layer compositing shader** (`overlay-layer-manager.ts`, `shaders.ts`) — up to 25 overlay layers, each with its own texture + opacity + optional geo bbox, composited in one pass. `sampleGeoLayer()` is the global-vs-local primitive (full equirect vs bbox-clipped with longitude wrap). Alpha `over` operator per layer.
3. **Shared-data-time sync controller** (`realtime-composition-controller.ts` ~1400 lines + `realtime/rt-time-math.ts`, `rt-base-pacer.ts`) — resolves a global data-time and maps each overlay's media time to it. Overlays free-run; the base rate is steered by a pacer to track the slowest overlay.
4. **Realtime alpha streaming** (`realtime-metadata-service.ts`, `webm-segment-player.ts`) — VP9-alpha DASH / webm-segments / HLS from `pachamama-studios.stream`, with per-manifest bandwidth / availabilityStartTime / duration metadata.

```
DSA roles ──▶ 25-layer shader composite ◀── Shared-data-time sync
                       ▲
              Alpha-DASH streams
```

---

## 3. What VR AYNI has today

| Capability | VR AYNI status |
|---|---|
| Realtime alpha-DASH streams | ✅ `public/assets/realtime-dash-datasets.json` (72 datasets, VP9-alpha, `coverage`, `dsa`, `mpd`, colorbar). `dash.js` is a dependency. |
| Single dataset on globe | ✅ `material.map = tex` swap in `photorealEarth.setTexture`. **One at a time.** |
| Regional clipping (bbox) | ✅ Exists but for a **single** dataset — `DatasetOverlayOptions` (`boundingBox {n,s,w,e}`, `lonOrigin`, `isFlippedInY`, `celestialBody`). `src/services/datasetOverlayOptions.ts`. Not multi-layer. |
| Translucent sphere shell precedent | ✅ Cloud overlay (`cloudMesh`, child sphere, luminance→alpha) and borders shell (`src/services/vrBorders.ts`). |
| Multi-globe / multi-mesh | ✅ `src/services/vrScene.ts` secondaries (lockstep rotation). Proves multiple textured spheres are handled. |
| Composition-role metadata (base/overlay) | ❌ Absent — `Dataset` type (`src/types/index.ts`) has no `composition` block. |
| Multi-layer compositing | ❌ One texture only. No overlay-layer list, no shader multi-texture composite. |
| Shared-data-time sync across layers | ❌ No concept; each load is independent. |
| In-VR layer management UI | ❌ Browse panel selects/loads one dataset; no opacity/order/visibility layer list. |

**Terminology trap:** in this codebase "overlay" already means something else — `DatasetOverlayOptions` is per-dataset bbox/flip render-hints, and "tour overlay"/"borders overlay"/"zoom overlay" are UI elements. None are dataset-layering. The new feature should use a distinct name (e.g. "dataset layers" / "rt layers") to avoid confusion.

---

## 4. Feasibility verdict

**Feasible.** The VR stack is Three.js sphere meshes, and the cloud/borders shells already demonstrate the exact rendering vehicle needed (a translucent, slightly-larger child sphere parented to the globe so it inherits rotation). The realtime stream pipeline (dash.js + VP9-alpha + `realtime-dash-datasets.json`) is already in place. No new external dependencies are required.

### The one hard constraint — Quest decoder budget
Meta Quest has **1–2 hardware H.264/VP9 decoders** (the VR repo's own `src/services/vrScene.ts:71-74` comment flags this for multi-globe). AYNI2 runs on a desktop with many decoders and stacks video layers freely; VR cannot. The VR design must be **decoder-budget-aware**: a small fixed cap of simultaneous *video* layers (likely 1 base video + 1 video overlay, or base video + image overlays), with image overlays (no decoder) effectively unlimited. This is the single most important architectural difference from AYNI2.

---

## 5. Phased plan

### Phase 0 — Metadata model (foundation, no rendering)
Add a `composition` block to the VR `Dataset` type, porting AYNI2's role/type/requiresAlpha/geo schema. Port the pure classifier functions so admission is metadata-driven. Extend catalog entries (or `.dsa` companions) with roles. Cheapest, highest-leverage step; unblocks everything else.

### Phase 1 — Single overlay shell (global alpha)
Generalize the existing `cloudMesh` pattern in `photorealEarth.ts` into a small `VrOverlayLayerManager` (mirror of AYNI2's `OverlayLayerManager`, using Three.js `Mesh` shells). Start with **one** translucent alpha shell over the base, opacity-controlled. Reuses the existing dash.js → `THREE.VideoTexture` path. Base + 1 overlay.

### Phase 2 — Regional (local) overlays
Add per-shell bbox clipping. Add a per-shell material patch implementing `sampleGeoLayer` (port AYNI2's GLSL — it's pure UV/bbox math) or a UV-discard route. This is where "local datasets" land. The existing `DatasetOverlayOptions.boundingBox` machinery can drive per-layer clipping.

### Phase 3 — Sync controller (simplified)
Port a **slimmed** `RealtimeCompositionController`. For VR, deliberately do *not* replicate the full frame-clock/base-pacer machinery on day one: VR's use case tolerates loose sync. Start with free-running streams sharing only play/pause + coarse global time; add drift correction only if needed. Keep AYNI2's `rt-time-math.ts` (pure, portable) as the alignment core.

### Phase 4 — VR layer UI
A layers panel mirroring `src/services/vrBrowse.ts` (CanvasTexture panel + UV hit-test + the touch drag-scroll already added). Per-layer: enable/visibility, opacity slider, order. Plus remote/state publish for telemetry.

---

## 6. Comprehensive checklist

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

### Phase 0 — Metadata model
- [ ] 0.1 Inspect AYNI2 `AssetDataset` + `composition` shape and the shared DSA schema; document the exact fields to port.
- [ ] 0.2 Design VR `composition` types (`roles`, `overlay.type`, `overlay.requiresAlpha`, `geo.bounds`, `geo.wrapLongitude`, `dataProductType`/product group) in `src/types/index.ts`.
- [ ] 0.3 Decide where roles are sourced for VR: extend `realtime-dash-datasets.json` entries vs. parse remote `.dsa` files via the Cloudflare catalog backend.
- [ ] 0.4 Port pure classifier functions from AYNI2 `rt-dataset-classifier.ts` (`isCompositionBase`, `isCompositionOverlay`, `isRegionalMaskOverlay`, `isSelectableRtOverlay`, `resolveOverlayCompositionType`, `resolveDataProductGroup`, `requiresOverlayAlpha`).
- [ ] 0.5 Add unit tests for the ported classifiers (co-locate `*.test.ts` per repo convention).
- [ ] 0.6 Register any new module in the CLAUDE.md module map (the repo's `check:doc-coverage` gate requires it — see prior CI failure).
- [ ] 0.7 Verify `npm run type-check` and `npm run test` pass.

### Phase 1 — Single overlay shell (global alpha)
- [ ] 1.1 Audit the existing base dataset load path (`photorealEarth.setTexture`, `datasetLoader.ts`) to find the seam where overlay layers attach.
- [ ] 1.2 Generalize the `cloudMesh` shell pattern into a reusable overlay-shell factory (radius slightly > globe, parented to globe for rotation inheritance).
- [ ] 1.3 Create `VrOverlayLayerManager` (add/remove layers, opacity, visibility, dispose) mirroring AYNI2's `OverlayLayerManager` API but with Three.js meshes.
- [ ] 1.4 Wire a single global alpha overlay: dash.js → `<video>` → `THREE.VideoTexture` → shell material (transparent, depth-write off).
- [ ] 1.5 Handle `<video>`/texture lifecycle + disposal inside the VR session (extend the existing base-video lifecycle pattern).
- [ ] 1.6 Decide + enforce the **decoder budget** constant (e.g. `MAX_VIDEO_OVERLAY_LAYERS`) and graceful refusal when exceeded.
- [ ] 1.7 Unit tests for the manager (pure state logic) and a happy-path integration check.
- [ ] 1.8 Type-check + doc-coverage + tests pass.

### Phase 2 — Regional (local) overlays
- [ ] 2.1 Port AYNI2's `sampleGeoLayer` GLSL (bbox clip + UV remap + longitude wrap) into a per-shell material `onBeforeCompile` patch.
- [ ] 2.2 Plumb per-layer `geo.bounds` from the dataset metadata into the shell uniforms.
- [ ] 2.3 Reuse/extend `DatasetOverlayOptions.boundingBox` to drive per-layer clipping (avoid duplicating bbox logic).
- [ ] 2.4 Verify longitude-wrap regional overlays render correctly across the antimeridian.
- [ ] 2.5 Back-to-front alpha-sort across all active shells.
- [ ] 2.6 Unit tests for the bbox/UV math (extract to a pure helper).
- [ ] 2.7 Type-check + tests pass.

### Phase 3 — Sync controller (simplified)
- [ ] 3.1 Port AYNI2 `rt-time-math.ts` (pure: timeRange/frameMapping/explicitTimeMapping ↔ data-time/media-time) with tests.
- [ ] 3.2 Define a minimal VR sync model: shared play/pause + coarse global data-time (no pacer on day one).
- [ ] 3.3 Map global time → each overlay's media time; apply initial seek only (no chase-seek while playing, per AYNI2's "no mid-stream jump" invariant).
- [ ] 3.4 Layer status surfacing (Active / Waiting / Out of range) — decide whether to show in VR UI or just log.
- [ ] 3.5 If drift proves unacceptable on-device, scope a slim `RtBasePacer` port for the base rate only.
- [ ] 3.6 Telemetry events for layer activation/sync (extend the existing analytics schema in `src/types`).
- [ ] 3.7 Type-check + tests pass.

### Phase 4 — VR layer UI
- [ ] 4.1 Design the in-VR layers panel (CanvasTexture, mirrors `vrBrowse.ts`): layer rows with enable toggle, opacity slider, up/down order.
- [ ] 4.2 Reuse the browse panel's UV hit-test + touch drag-scroll (the `BrowseDragState` pattern just added).
- [ ] 4.3 Wire panel actions to `VrOverlayLayerManager` (setLayerEnabled / setLayerOpacity / moveLayer).
- [ ] 4.4 Add a HUD entry to open the layers panel alongside browse.
- [ ] 4.5 Respect the decoder budget in the UI (disable enabling a video layer when at cap; explain why).
- [ ] 4.6 i18n strings (repo runs `check:i18n-strings`; add keys to locale JSONs and run `npm run locales`).
- [ ] 4.7 Remote/state publish for multi-client scenarios (mirror AYNI2 `getRemoteStatePayload`/`applyRemoteState`) — scope whether VR needs it.
- [ ] 4.8 Type-check + doc-coverage + i18n + tests pass.

### Cross-cutting
- [ ] C.1 Performance budget on-device: measure fill-rate/overdraw with N shells at 72–90 FPS on Quest; record a ceiling.
- [ ] C.2 Decide the simultaneous-layer cap (video vs image) and encode it as a single config constant.
- [ ] C.3 Graceful degradation when the decoder is exhausted (drop lowest-priority video layer).
- [ ] C.4 Disposal correctness across session end (`vrSession` teardown) for all shell textures/videos.
- [ ] C.5 On-device validation plan (AR phone + Quest) and remote-debug steps (per README's WebXR debugging section).
- [ ] C.6 Update `CLAUDE.md` / docs with the new subsystem and naming (avoid clashing with existing "overlay" terms).

---

## 7. Risks

1. **Decoder budget (Quest)** — dominant constraint. Cap simultaneous video layers (1 base video + 1 video overlay; prefer image overlays); degrade gracefully on exhaustion. AYNI2 does not face this.
2. **VR fill-rate / overdraw** — multiple full-screen translucent spheres at 72–90 FPS on mobile GPU is costly. Regional shells should be bbox-tight; alpha must be sorted back-to-front.
3. **WebXR + `<video>` element limits** — each video overlay needs a live off-screen `<video>` decoded then uploaded as a `VideoTexture`. The VR session must own lifecycle/disposal carefully (extend the existing base-video pattern).
4. **Don't over-port** — AYNI2's controller is ~1400 lines of desktop-grade sync nuance (rate ceilings, frame clocks, pacer). Adopt the *math* (`rt-time-math`, `sampleGeoLayer`, classifier) but don't blindly copy the controller's complexity until the simpler free-running approach proves insufficient.
5. **Metadata sourcing** — AYNI2 repairs metadata via an Electron main-process service hitting Pachamama. VR is web/Tauri with a different backend (Cloudflare D1 catalog). Composition roles must flow through VR's catalog pipeline, not be re-derived.
6. **Naming collision** — "overlay" is overloaded in this repo. Use a distinct term ("dataset layers" / "rt layers") for the new subsystem.

---

## 8. Bottom line

AYNI2's realtime overlay system is portable in its **ideas and pure math**, and VR AYNI already holds the rendering vehicle (translucent shells), the stream pipeline (alpha-DASH), and the regional-clip concept (bbox). The work is a new overlay-layer manager + composition metadata + (optionally) a sync controller — scoped small because the decoder budget forces a small simultaneous-layer count anyway. Recommended entry point: **Phase 0 + Phase 1** (base + one global alpha overlay) as a proof, then expand to regional + sync.
