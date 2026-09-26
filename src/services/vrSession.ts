// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * WebXR session lifecycle.
 *
 * Orchestrates the Three.js import, renderer creation, XR session
 * request, per-frame loop, and teardown. This is the only module
 * that `main.ts` talks to directly — everything else
 * (scene / hud / interaction) is built and torn down here.
 *
 * Three.js is lazy-imported on the first call to {@link enterVr} —
 * desktop web, Tauri, and mobile browsers (where
 * {@link isImmersiveVrSupported} returns false) never fetch the
 * chunk. Same pattern used for Tauri plugins elsewhere in the
 * codebase.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}.
 */

import type * as THREE from 'three'
import { createVrScene, type VrSceneHandle, type VrDatasetTexture } from './vrScene'
import { createVrHud, type VrHudHandle, type VrVoiceState } from './vrHud'
import type { MapLayerImages } from './earthTileLayer'
import { createVrBrowse, type VrBrowseHandle } from './vrBrowse'
import { createVrTourControls, type VrTourControlsHandle } from './vrTourControls'
import { createVrTourOverlay, type VrTourOverlayHandle } from './vrTourOverlay'
import { createVrTimeLabel, type VrTimeLabelHandle } from './vrTimeLabel'
import { createVrTimelineTrack, type VrTimelineTrackHandle } from './vrTimelineTrack'
import type { TimelineAvailabilitySpan } from './timelineTrackCanvas'
import { setVrTourOverlaySink } from '../ui/tourUI'
import { createVrInteraction, type VrInteractionHandle } from './vrInteraction'
import { createVrLoading, type VrLoadingHandle } from './vrLoading'
import {
  formatProbeReading,
  probeDatasetValue,
  sphereUvToLatLon,
  type ProbeSource,
} from './datasetProbe'
import { getSharedLumaSampler } from './glLumaSampler'
import { createVrZoomOverlay, type VrZoomOverlayHandle } from '../ui/vrZoomOverlay'
import { createVrPlacementTouch, type VrPlacementTouchHandle } from '../ui/vrPlacementTouch'
import { createVrRotateTouch, type VrRotateTouchHandle } from '../ui/vrRotateTouch'
import { createVrDebugPanel, type VrDebugPanelHandle } from './vrDebugPanel'
import { MAX_GLOBE_SCALE, MIN_GLOBE_SCALE } from './vrScene'
import { createVrPlacement, type VrPlacementHandle } from './vrPlacement'
import { computeGazeSpawnPosition } from './vrSpawn'
import {
  clearPersistedAnchorHandle,
  loadPersistedAnchorHandle,
  savePersistedAnchorHandle,
} from '../utils/vrPersistence'
import { getBordersVisible, getGazeFollowOverlays } from '../utils/viewPreferences'
import { logger } from '../utils/logger'
import { emit, emitCameraSettled } from '../analytics'
import type { VrExitReason } from '../types'
import {
  classifyXrDevice,
  getInputArchetype,
  isHandheldArUserAgent,
  type VrInputArchetype,
} from '../utils/vrCapability'

/**
 * Contract the hosting app must provide. Pull-based: the session
 * polls these getters once per frame and reflects the values in the
 * HUD / scene. Keeps the VR modules decoupled from the specifics of
 * MapLibre / HLSService / viewportManager.
 */
/** 1x1 scratch canvas for the in-VR readout. Module-scoped and reused
 *  so a per-frame probe allocates nothing. */

/**
 * How often the VR probe actually samples, in ms.
 *
 * The readout is a number a person reads off a HUD; 10 Hz is already
 * faster than anyone can follow it changing. What it replaces is not
 * free: a raycast plus a `drawImage` and a **synchronous**
 * `getImageData`, on a loop that has 11-14 ms to render two eyes. The
 * 1x1 copy keeps the transfer small but not the readback stall, and
 * that stall would otherwise land 72-90 times a second.
 */
const VR_PROBE_INTERVAL_MS = 100

/** -1, not 0: the XR clock legitimately reads 0 on the first frame. */
let vrProbeLastAt = -1
let vrProbeLastValue: string | null = null

/** Forget the cached reading so a new session starts clean. */
function resetVrProbe(): void {
  vrProbeLastAt = -1
  vrProbeLastValue = null
}

/**
 * Value under the controller's aim, for the HUD — sampled at most
 * every `VR_PROBE_INTERVAL_MS`, returning the previous reading in
 * between.
 *
 * Held to a fixed cadence rather than driven by the HUD's own
 * change-detection, because the HUD debounces the *redraw* and this
 * is the cost of producing the value it debounces on.
 */
function readVrProbe(
  interaction: VrInteractionHandle,
  ctx: VrSessionContext,
  now: number,
): string | null {
  if (vrProbeLastAt >= 0 && now - vrProbeLastAt < VR_PROBE_INTERVAL_MS) {
    return vrProbeLastValue
  }
  vrProbeLastAt = now
  vrProbeLastValue = sampleVrProbe(interaction, ctx)
  return vrProbeLastValue
}

/**
 * One probe sample.
 *
 * Returns null — and the HUD drops the line entirely — for a picture
 * dataset, a controller not aimed at a globe, a point outside a
 * regional dataset's box, or a frame that hasn't decoded. So every
 * dataset published before this feature keeps exactly the HUD it has
 * today.
 *
 * Copies a single texel rather than a frame: at 4096x2048 a full read
 * would be 32 MB.
 */
function sampleVrProbe(
  interaction: VrInteractionHandle,
  ctx: VrSessionContext,
): string | null {
  const spec = ctx.getDatasetTexture()
  if (!spec?.options?.colorScale) return null
  // AYNI: a value-encoded release (dashRelease.ts) crops its map out of
  // a taller frame and has its own no-data codes. The shared probe maps
  // the whole frame, so it would read the wrong row and call no-data a
  // value; say nothing rather than a wrong number.
  if (spec.options.dataRegion) return null
  const uv = interaction.globeHoverUv()
  if (!uv) return null
  const sampler = getSharedLumaSampler()
  if (!sampler) return null
  const source = spec.element
  // ImageBitmap is a valid THREE texture source but not one the
  // sampler's texImage2D overload accepts; skip rather than cast.
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return null
  const { lat, lon } = sphereUvToLatLon(uv)
  const reading = probeDatasetValue(
    lat,
    lon,
    source as ProbeSource,
    (src, texel) => sampler.sample(src, texel),
    spec.options,
  )
  return reading ? formatProbeReading(reading) : null
}

/**
 * The primary dataset's declared time axis, in the shape the date track
 * draws. The host answers it from the `.dsa` beside the stream
 * (`services/dsaTimeline.ts`) plus the video's own playhead; a dataset
 * that declares no axis — every catalog row, and any stream whose
 * annotation has not arrived — answers `null`, and the track hides.
 */
export interface VrDatasetTimeline {
  /** Instant of the first frame, ms since epoch. */
  readonly startMs: number
  /** Exclusive end of the axis — the instant after the final frame. */
  readonly endMs: number
  /** The instant the playhead represents now. */
  readonly currentMs: number
  readonly frameCount: number
  readonly cadenceMs: number
  /** Sparse provenance spans for the track to shade; a frame outside them is data.
   *  The renderer's own span shape — three fields it draws — rather than the
   *  DSA's full record, so a second reader of the annotation cannot make the
   *  drawing depend on a field it never paints. */
  readonly availabilitySpans: readonly TimelineAvailabilitySpan[]
}

export interface VrSessionContext {
  /**
   * The currently-loaded dataset's surface texture for the PRIMARY
   * panel. Backward-compatible convenience that equals
   * `getPanelTexture(getPrimaryIndex())`. Kept for single-globe
   * callers that don't care about the multi-panel model.
   */
  getDatasetTexture(): VrDatasetTexture | null
  /** Dataset title for the HUD (primary panel). null/empty → "No dataset loaded". */
  getDatasetTitle(): string | null
  /** Dataset id for the primary panel — used by analytics events
   * fired from inside VR (e.g. `vr_placement.layer_id`). Null when
   * no dataset is loaded. Telemetry-only: the HUD itself uses
   * `getDatasetTitle()` for human display. */
  getDatasetId(): string | null
  /**
   * Formatted time-label string for the current primary dataset —
   * mirrors the 2D `#time-label` overlay (e.g. `"2023-06-15"` or
   * `"2023-06-15 18:00"` for sub-daily). null when the dataset
   * lacks `startTime` metadata or no dataset is loaded.
   *
   * Polled per XR frame. The host MUST derive the string from the
   * current playback state (for video datasets, compute from
   * `video.currentTime`) rather than reusing a cached
   * `appState.timeLabel` — WebXR pauses `window.requestAnimationFrame`
   * for the duration of an immersive session, so the 2D
   * `startPlaybackLoop` that normally updates `appState.timeLabel`
   * is frozen and any consumer reading that cache sees the value
   * from the instant VR was entered and stays there forever. See
   * `main.ts`'s implementation for the expected pattern.
   */
  getDatasetTimeLabel(): string | null
  /**
   * The primary dataset's declared time axis, or null when it declares
   * none. Polled per XR frame like the label, and answered the same way:
   * the host reads the stream's `.dsa` (fetched once, cached, and null
   * when absent) and maps the video's `currentTime` through it. A null
   * answer is the normal case rather than a failure — every catalog
   * dataset answers null here, and shows no track.
   */
  getDatasetTimeline(): VrDatasetTimeline | null
  /**
   * Seek the primary playback to an instant on that axis. The host
   * converts through the same mapping, which lands the video **inside**
   * the frame representing that instant rather than on its boundary, so
   * a decode cannot resolve to the neighbouring date. No-op without an
   * axis or a video element.
   */
  seekToTimelineDate(epochMs: number): void
  /** True iff a video dataset is loaded on the primary — drives the HUD play/pause button visibility. */
  hasVideoDataset(): boolean
  /** Drives the HUD play/pause icon. Reflects the primary panel's state. */
  isPlaying(): boolean
  /** Called when the user taps play/pause in VR. Toggles the primary's video. */
  togglePlayPause(): void
  /** Drives the HUD mute icon variant (speaker vs speaker-slash). */
  isMuted(): boolean
  /** Called when the user taps the HUD mute button. Flips `video.muted`. */
  toggleMute(): void

  // --- Phase 2.5 multi-panel getters ---
  //
  // These let vrSession mirror the 2D app's viewport manager
  // inside VR. When the 2D app is in 2-globe layout, `getPanelCount`
  // returns 2, each panel has its own texture / title, and one
  // slot is designated primary (drives the HUD + playback
  // transport). The original Phase 2.5 plan also included a
  // `promotePanel` hook for tap-to-promote (trigger on a secondary
  // globe → that slot becomes primary), but the behaviour was
  // intentionally removed in favour of "grab any globe to rotate,
  // all spin in lockstep" — the original created a ping-pong loop
  // where promoting swapped textures underneath the user's ray,
  // which then promoted again on the next tap. A replacement UX
  // (long-press, HUD-dot taps, Phase 3 browse panel routing) is
  // future work; the context surface stays trimmed until then.

  /** Current number of globe panels (1/2/4). Sourced from the 2D viewport manager. */
  getPanelCount(): number
  /** Which slot is currently primary — drives the HUD + singular playback transport. */
  getPrimaryIndex(): number
  /** Dataset texture for a specific slot, or null if no dataset loaded in that slot. */
  getPanelTexture(slot: number): VrDatasetTexture | null
  /** Dataset title for a specific slot, for per-panel labels; null if no dataset. */
  getPanelTitle(slot: number): string | null

  // --- Phase 3: in-VR browse ---
  /** Full dataset catalog for the browse panel. */
  getDatasets(): VrDatasetEntry[]
  /** Load a dataset by ID without leaving VR. */
  loadDataset(id: string): void

  // --- Phase 3.5: in-VR tour controls ---
  /**
   * Snapshot of the current tour state — the VR session polls this
   * each frame and updates the in-VR tour-control strip accordingly.
   * `active` is false when no tour is running; the other fields are
   * ignored in that case. Callers wire this to `TourEngine.state` /
   * `.currentIndex` / `.totalSteps` in main.ts.
   */
  getTourState(): VrTourState
  /** Resume or pause the running tour. No-op if no tour is active. */
  tourTogglePlayPause(): void
  /** Step the running tour backward one segment. No-op if no tour is active. */
  tourPrev(): void
  /** Skip the current task and move to the next. No-op if no tour is active. */
  tourNext(): void
  /** Stop the running tour entirely. No-op if no tour is active. */
  tourStop(): void

  // --- Phase 5: Orbit voice (docs/ORBIT_VOICE_PLAN.md §5.4) ---
  /**
   * Orbit's voice turn for the HUD mic + caption strip, polled per XR
   * frame. Null — or the member absent, for a host without Orbit —
   * hides the mic. main.ts wires it to chatUI's getImmersiveVoiceState.
   */
  getVoiceState?(): VrVoiceState | null
  /** The HUD mic was tapped: start listening, send, or stop speaking, depending on the turn. */
  toggleVoice?(): void

  // --- AYNI: layer stack ---
  /**
   * The basemap + overlays for the primary globe (mapLayers.ts), or null.
   * Polled per XR frame and applied only when the object changes, so the
   * host hands back the same object until the stack actually changes.
   */
  getMapLayerImages?(): MapLayerImages | null

  /** Optional — fired after the session ends + resources are torn down. */
  onSessionEnd?: () => void
}

/**
 * Snapshot consumed by the in-VR tour-control strip. `active` gates
 * every other field — when false, the strip is hidden and the other
 * values aren't rendered. A tour that is paused (after `pauseForInput`
 * or an explicit user pause) is still `active`, just not `isPlaying`.
 */
export interface VrTourState {
  active: boolean
  isPlaying: boolean
  step: number
  totalSteps: number
}

/**
 * Lightweight dataset descriptor for the VR browse panel. Avoids
 * importing the full `Dataset` type into the VR modules — they only
 * need what they render.
 */
export interface VrDatasetEntry {
  id: string
  title: string
  /**
   * Every category/tag this dataset belongs to — union of
   * `enriched.categories` keys and `Dataset.tags`, matching the 2D
   * browse UI's chip-building model. Empty when the dataset has
   * neither. Lets the VR browse panel surface chips like "Tours"
   * and "Real-Time" that live in `tags`, not just in enriched
   * categories.
   */
  categories: string[]
  /** Thumbnail URL from the SOS catalog, if available. */
  thumbnailUrl: string | null
}

/**
 * Lazy Three.js loader. First call triggers the dynamic import and
 * kicks off the bundle fetch; subsequent calls reuse the cached
 * promise. Safe to call from feature-detect warm-up paths too.
 */
let threePromise: Promise<typeof import('three')> | null = null
export function loadThree(): Promise<typeof import('three')> {
  return (threePromise ??= import('three'))
}

/**
 * Handles for the current session. Single-session design — we don't
 * support entering VR twice concurrently, so a module-level ref is
 * fine and simplifies `isActive()` / teardown.
 */
interface ActiveSession {
  session: XRSession
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  scene: VrSceneHandle
  hud: VrHudHandle
  /** Teardown hook for the DOM zoom slider — removes the
   *  `inputsourceschange` listener and disposes the overlay if one
   *  is currently mounted. Idempotent. Always present (a no-op for
   *  controller-only sessions that never mount the overlay). */
  disposeZoomOverlay: () => void
  interaction: VrInteractionHandle
  /** In-VR dataset browse panel. */
  browse: VrBrowseHandle
  /** In-VR tour control strip — visible only while a tour is active. */
  tourControls: VrTourControlsHandle
  /** In-VR tour overlay manager (text / popup / ... panels). Always present; hosts per-tour overlays. */
  tourOverlay: VrTourOverlayHandle
  /** Floating date readout above the globe for datasets with time metadata. */
  timeLabel: VrTimeLabelHandle
  /**
   * Date track under the HUD — the primary dataset's declared time axis,
   * hidden while the host reports none. Distinct from `timeLabel`: the
   * label answers "what date is this?", the track answers "what is the
   * span, and where in it am I?", and only the track is interactive.
   */
  timeline: VrTimelineTrackHandle
  /** Loading scene shown during entry; null after fade-out + dispose. */
  loading: VrLoadingHandle | null
  /** AR-only spatial placement (hit-test reticle + Place button). Null when hit-test unavailable. */
  placement: VrPlacementHandle | null
  /** Reference space passed to per-frame hit-test resolution. */
  refSpace: XRReferenceSpace | null
  /**
   * The viewer-space hit-test source used by placement. Stored
   * here so the session-end teardown can explicitly cancel it and
   * release platform-side tracking resources.
   */
  hitTestSource: XRHitTestSource | null
}

let active: ActiveSession | null = null
/** AYNI: the layer stack last handed to the scene; undefined = none yet this session. */
let appliedMapLayers: MapLayerImages | null | undefined = undefined

/**
 * Loading handover timings, in render-loop seconds. If texture readiness
 * has not arrived after LOADING_FALLBACK_S the splash is dismissed anyway
 * (an untextured globe beats an eternal splash); once it has arrived the
 * bar sits at 100% for LOADING_READY_PAUSE_S before the fade starts.
 */
const LOADING_FALLBACK_S = 10
const LOADING_READY_PAUSE_S = 0.25

/** True while a VR session is live. */
export function isVrActive(): boolean {
  return active !== null
}

/**
 * In-flight flyTo animation driven by the render loop. The tour
 * engine awaits the returned promise so the "next" task doesn't run
 * until the rotation settles. A new `flyToOnGlobe` call while one
 * is running resolves the previous one and replaces it — the last
 * call wins.
 */
interface PendingFlyTo {
  startQuat: THREE.Quaternion
  endQuat: THREE.Quaternion
  startTime: number
  durationMs: number
  resolve: () => void
}
let pendingFlyTo: PendingFlyTo | null = null

/**
 * Default flyTo animation length. Matches `MapRenderer.flyTo`'s
 * current 2.5 s pacing so tours that run `Promise.all([2D, VR])`
 * settle at roughly the same instant in both surfaces — the tour
 * engine awaits the longer of the two, and a mismatched default
 * would make VR-only sessions feel either abrupt (shorter) or
 * sluggish (longer) relative to the same tour in 2D.
 */
const FLY_TO_DEFAULT_DURATION_MS = 2500

/**
 * Rotate the VR globe so `(lat, lng)` faces the user's head. No-op
 * when no VR session is active.
 *
 * In 2D, `flyTo` moves the camera to look at a lat/lng. VR can't
 * move the user's head (WebXR owns the view transform — moving it
 * would induce motion sickness), so we rotate the globe instead:
 * the point on the sphere corresponding to `(lat, lng)` rotates to
 * the surface position closest to the user's current head position.
 *
 * Captured at animation start:
 * - `startQuat`: globe's current orientation.
 * - `endQuat`: orientation that maps the local unit vector of
 *   `(lat, lng)` onto the world-space direction from globe center
 *   to the camera. If the user walks to the other side of the
 *   globe in AR mode, re-calling `flyToOnGlobe` captures the new
 *   head position and rotates accordingly.
 *
 * Slerp + ease-in-out drives the interpolation each frame until the
 * duration elapses, at which point the returned promise resolves.
 * Tour engine's `execFlyTo` awaits both this and the 2D renderer's
 * `flyTo` via `Promise.all`, so the longer of the two paces the
 * next task.
 */
export async function flyToOnGlobe(
  lat: number,
  lng: number,
  durationMs: number = FLY_TO_DEFAULT_DURATION_MS,
): Promise<void> {
  if (!active) return
  const THREE_ = await loadThree()
  if (!active) return // session may have ended between await + resume

  // Target direction in world space = unit vector from globe center
  // to the user's head. `camera.getWorldPosition` accounts for the
  // XR view matrix, so this is the actual user position in
  // local-floor coords (not a fixed nominal spot).
  const camPos = new THREE_.Vector3()
  active.camera.getWorldPosition(camPos)
  const worldDir = camPos.clone().sub(active.scene.globe.position).normalize()

  // Local-space target point for (lat, lng). Matches the
  // convention `photorealEarth.sunDirectionFromLatLng` uses
  // internally so the orientation lines up with the dataset /
  // photoreal Earth texture's equirectangular wrap on the sphere
  // (including the negated Z that Three.js SphereGeometry's
  // default phiStart introduces).
  const latRad = (lat * Math.PI) / 180
  const lngRad = (lng * Math.PI) / 180
  const localTarget = new THREE_.Vector3(
    Math.cos(latRad) * Math.cos(lngRad),
    Math.sin(latRad),
    -Math.cos(latRad) * Math.sin(lngRad),
  )

  // Resolve any prior flyTo first so callers that awaited it don't
  // hang waiting on a superseded animation.
  if (pendingFlyTo) {
    const prior = pendingFlyTo
    pendingFlyTo = null
    prior.resolve()
  }

  return new Promise<void>((resolve) => {
    pendingFlyTo = {
      startQuat: active!.scene.globe.quaternion.clone(),
      endQuat: new THREE_.Quaternion().setFromUnitVectors(localTarget, worldDir),
      startTime: performance.now(),
      durationMs,
      resolve,
    }
  })
}

/** Cancel any in-flight flyTo animation — used by session teardown. */
function cancelFlyTo(): void {
  if (!pendingFlyTo) return
  const prior = pendingFlyTo
  pendingFlyTo = null
  prior.resolve()
}

/**
 * Push the non-primary panels' textures into scene slots 1..N-1.
 * Scene slot 0 holds the 2D app's primary panel (set via
 * `scene.setTexture`); the remaining scene slots are filled from the
 * 2D panel list in order, skipping the primary index. Separated so
 * the initial-setup path and the per-frame poll path stay in sync.
 */
function syncSecondaryTextures(
  scene: VrSceneHandle,
  ctx: VrSessionContext,
  panelCount: number,
): void {
  if (panelCount <= 1) return
  const primary = ctx.getPrimaryIndex()
  let sceneSlot = 1
  for (let panelSlot = 0; panelSlot < panelCount; panelSlot++) {
    if (panelSlot === primary) continue
    scene.setSlotTexture(sceneSlot, ctx.getPanelTexture(panelSlot))
    sceneSlot++
  }
}

/** Which immersive mode to enter. `vr` = full immersive, `ar` = passthrough. */
export type VrMode = 'vr' | 'ar'

/**
 * Request an immersive WebXR session (VR or AR passthrough), build
 * the Three.js scene, attach controllers, and start the render loop.
 * Rejects if the browser refuses the session (user denied permission,
 * no device, etc.). On success, resolves once the session is fully
 * live — the user will be in the headset at that point.
 *
 * Calling while a session is already active is a no-op.
 *
 * AR mode (`mode === 'ar'`) requests `immersive-ar` and configures
 * the renderer + scene for transparent rendering, so the Quest
 * passthrough camera feed shows behind the floating globe and HUD.
 * Visually identical to VR mode for everything in the scene; only
 * the surrounding "void" changes from black to the user's room.
 */
export async function enterImmersive(mode: VrMode, ctx: VrSessionContext): Promise<void> {
  appliedMapLayers = undefined
  if (active) {
    logger.warn(`[VR] enterImmersive(${mode}) called while a session is already active`)
    return
  }
  if (!navigator.xr) {
    throw new Error('WebXR is not available in this browser')
  }

  // Wall-clock anchor for `vr_session_started.entry_load_ms` and the
  // matching `vr_session_ended.duration_ms`. Captured before the
  // Three.js chunk load so a slow first-time fetch shows up in the
  // entry-load metric.
  const entryStartedAtWall = Date.now()
  const sessionTelemetry: {
    sessionStartedAtWall: number
    frames: number
    exitReason: VrExitReason
    /** Coarse input archetype the device is using. Resolves lazily —
     * screen-tap (handheld AR) sessions report zero input sources
     * until the first tap, so this starts as `'unknown'` and is
     * updated by the `inputsourceschange` listener wired below.
     * Consumed by future PRs to gate alternative UX (DOM zoom
     * slider, HUD exit button) for non-controller devices. */
    inputClass: VrInputArchetype
  } = {
    sessionStartedAtWall: 0,
    frames: 0,
    exitReason: 'user',
    inputClass: 'unknown',
  }

  const THREE_ = await loadThree()
  const isAr = mode === 'ar'
  const sessionMode = isAr ? 'immersive-ar' : 'immersive-vr'

  // --- Renderer + canvas ---
  // The canvas doesn't display anything while the session is live
  // (the headset takes over), but Three.js still needs a DOM-
  // attached canvas for the WebGL context to behave correctly. We
  // inject a small offscreen-like host and remove it on teardown.
  const canvas = document.createElement('canvas')
  canvas.id = 'vr-canvas'
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.pointerEvents = 'none'
  // Hide under the existing 2D UI so it doesn't flash during the
  // transition. Display:none would prevent GL context creation, so
  // use zero opacity instead.
  canvas.style.opacity = '0'
  document.body.appendChild(canvas)

  const renderer = new THREE_.WebGLRenderer({
    canvas,
    antialias: true,
    // AR passthrough requires alpha so the framebuffer can clear to
    // transparent and reveal the camera feed; VR keeps it disabled
    // for a slight performance edge (one less blend pass per pixel).
    alpha: isAr,
    // State a preference for the discrete GPU on a hybrid-graphics
    // machine. Three.js leaves this at `'default'`, and MapLibre already
    // asks for `'high-performance'`, so absent this the 2D globe and the
    // immersive globe are asking for different things on one machine.
    //
    // **It is a hint, and it is not always honoured.** Measured on a
    // Windows box with an RTX 4090: an unhinted context came back as
    // `ANGLE (Intel, Intel(R) UHD Graphics …)`, and so did a context
    // that asked for `'high-performance'`. Chrome appears to pick one
    // GPU for its whole GPU process, so a per-context request cannot
    // move it; what moved it was the Windows per-app graphics
    // preference. So this option does not guarantee an adapter, and on
    // that platform it may do nothing at all.
    //
    // What it buys where it *is* honoured: `WebXRManager.setSession`
    // awaits `gl.makeXRCompatible()`, which migrates the context to the
    // adapter driving the headset. That migration can force a context
    // loss and restore — every texture, including the dataset video and
    // the whole photoreal Earth stack, destroyed and re-uploaded —
    // landing inside the session-start ordering this file documents as
    // already delicate (see the `XRControllerModelFactory` note above).
    // A context created on that adapter has nothing to migrate. Where
    // the hint is ignored, `makeXRCompatible` still handles correctness;
    // this only removes a cost, and only sometimes.
    //
    // Deliberately *not* applied to the Orbit character page: that scene
    // never enters XR, so it gains nothing here, and forcing a laptop
    // onto its discrete GPU for a decorative idle animation is a real
    // battery cost for no user-visible benefit.
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.xr.enabled = true

  // Camera: a default perspective is fine — Three.js' XR layer
  // overrides projection / view matrices from the XR views, so
  // these values are only used for inline rendering (which we skip).
  const camera = new THREE_.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100)

  // --- Request the session ---
  // hit-test is requested as OPTIONAL for AR sessions so the
  // session still starts on browsers/devices without the feature
  // — placement just won't be available in that case. Skipped
  // entirely for VR (no real-world geometry to hit-test against).
  const optionalFeatures: string[] = []
  if (isAr) {
    optionalFeatures.push('hit-test')
    // Anchors let us bolt the globe to a real-world surface and
    // have it stay there across tracking adjustments (within a
    // session) and across sessions (via Meta's persistent-handle
    // extension). Core to the "globe actually stays on my table"
    // UX. Optional because not all UAs implement anchors yet.
    optionalFeatures.push('anchors')
    // dom-overlay lets the browser render a DOM subtree on top of
    // the handheld-AR camera feed — without it the in-DOM zoom
    // slider / placement touch layer never becomes visible during
    // the session. Optional because Quest browsers don't implement
    // it and must not fail the request.
    optionalFeatures.push('dom-overlay')
  }
  // Root element handed to the dom-overlay module. Chrome on Android
  // renders this subtree over the camera feed; see index.html.
  const domOverlayRoot = isAr ? document.getElementById('xr-dom-overlay') : null
  /**
   * Build the session init for one request attempt. `domOverlay`
   * isn't in the TS DOM lib's XRSessionInit yet — same
   * `as unknown as` pattern as the hit-test / anchor requests below.
   */
  const buildSessionInit = (required: string[]): XRSessionInit =>
    ({
      requiredFeatures: required,
      ...(optionalFeatures.length > 0 ? { optionalFeatures } : {}),
      ...(domOverlayRoot ? { domOverlay: { root: domOverlayRoot } } : {}),
    }) as unknown as XRSessionInit
  // Reference-space contract for the rest of the session. `local-floor`
  // gives the globe a stable Y above the user's actual floor; `local`
  // anchors at the head pose at session start with no floor offset.
  // The session-features list, the default GLOBE_POSITION, and the
  // placement reference space all key off this — keep them consistent.
  let referenceSpaceType: 'local-floor' | 'local' = 'local-floor'
  let session: XRSession
  try {
    session = await navigator.xr.requestSession(sessionMode, buildSessionInit(['local-floor']))
  } catch (err) {
    // Only retry on a feature-unsupported failure (HoloLens 2 Edge in
    // early builds, certain WebXR polyfills). Permission denial,
    // transient hardware errors, and any other failure mode propagate
    // as-is — re-prompting the user a second time would be both
    // annoying and confusing, and would mask the original error. The
    // narrowed retry also keeps `vr_session_started.entry_load_ms`
    // honest on the user-denial path (otherwise a deny → retry →
    // deny would double the latency).
    const isFeatureUnsupported =
      err instanceof DOMException && err.name === 'NotSupportedError'
    if (!isFeatureUnsupported) {
      canvas.remove()
      renderer.dispose()
      throw err instanceof Error ? err : new Error(String(err))
    }
    logger.debug('[VR] local-floor unavailable, retrying with local:', err)
    try {
      session = await navigator.xr.requestSession(sessionMode, buildSessionInit(['local']))
      referenceSpaceType = 'local'
    } catch (retryErr) {
      canvas.remove()
      renderer.dispose()
      throw retryErr instanceof Error ? retryErr : new Error(String(retryErr))
    }
  }

  // Bind the session to the renderer. Three.js handles
  // makeXRCompatible + baseLayer setup internally.
  try {
    await renderer.xr.setSession(session as unknown as XRSession)
  } catch (err) {
    sessionTelemetry.exitReason = 'error'
    await session.end().catch(() => { /* already gone */ })
    canvas.remove()
    renderer.dispose()
    throw err instanceof Error ? err : new Error(String(err))
  }

  // The session is bound; emit `vr_session_started` now so
  // entry_load_ms reflects the user-perceived "tap → in-VR" latency
  // including the Three.js chunk load + setSession round-trip. The
  // layer_id snapshot is the dataset loaded at entry time; if the
  // user loads a different dataset mid-session the
  // `vr_session_ended` event captures the post-change value.
  sessionTelemetry.sessionStartedAtWall = Date.now()
  emit({
    event_type: 'vr_session_started',
    mode,
    device_class: classifyXrDevice(
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
      mode,
    ),
    entry_load_ms: Math.max(0, sessionTelemetry.sessionStartedAtWall - entryStartedAtWall),
    layer_id: ctx.getDatasetId() ?? '',
  })

  // Resolve the input archetype lazily. Handheld-AR sessions (Android
  // + ARCore) report zero input sources at session start — a
  // transient `screen` source only appears on the user's first tap —
  // so an at-start snapshot would always read `'unknown'` and the
  // dependent UX (DOM zoom slider, HUD exit button) would never
  // mount. Re-resolving on every `inputsourceschange` lets the
  // archetype settle as inputs come and go (controllers wake on
  // pickup, hand-tracking toggles in/out on Quest, transient pointers
  // fire per pinch on Vision Pro).
  const updateInputClass = (): void => {
    let next = getInputArchetype(session)
    // Latch the `screen` archetype for the session lifetime: the
    // transient screen input source only exists for the duration of
    // a tap, so every tap release fires `inputsourceschange` back to
    // zero sources (`unknown`). Without the latch, dependent UI
    // (the DOM zoom overlay) would unmount/remount on every tap.
    // Controller / transient archetypes still recompute freely — a
    // real controller appearing later still wins over the latch.
    if (sessionTelemetry.inputClass === 'screen' && next === 'unknown') {
      next = 'screen'
    }
    if (next !== sessionTelemetry.inputClass) {
      logger.debug(
        `[VR] inputClass: ${sessionTelemetry.inputClass} -> ${next}`,
      )
      sessionTelemetry.inputClass = next
    }
  }
  updateInputClass()
  session.addEventListener('inputsourceschange', updateInputClass)

  /**
   * Handheld or headset? Decided ONCE for the session, from the user
   * agent, and never recomputed — see `isHandheldArUserAgent` for why
   * the gamepad-presence test it replaces flapped on every phone tap.
   *
   *   - handheld (Android phone / tablet, Chrome + ARCore): the DOM
   *     placement chrome, the zoom slider, a one-finger rotate, and
   *     NOTHING else from touch. The XR pinch, grab and thumbstick
   *     paths in vrInteraction all stand down for the whole session.
   *   - headset (Quest 3 / 3S / Pro, Pico, …): the controller model
   *     exactly as before — grab-and-rotate, two-hand pinch,
   *     thumbstick zoom, trigger-to-confirm placement.
   */
  const handheldAr = isAr && isHandheldArUserAgent(navigator.userAgent)
  /** Debug readout only — no gate keys off this any more. */
  const hasGamepadInput = (): boolean => {
    for (const source of session.inputSources) {
      if (source?.gamepad) return true
    }
    return false
  }
  /**
   * True once the handheld rotate layer is mounted and owns the globe's
   * rotation. vrInteraction declines its own globe grab while this is
   * set, so one drag cannot rotate through both paths.
   */
  let rotateTouchMounted = false

  // Whether the session actually granted the DOM overlay. Requested
  // as optional above, so Quest browsers (which don't implement the
  // dom-overlays module) silently skip it and this reads false —
  // every DOM-dependent affordance below must gate on it, not on
  // the request alone. `domOverlayState` isn't in the TS DOM lib
  // yet — same cast pattern as the other optional-feature reads.
  const domOverlayActive =
    isAr &&
    domOverlayRoot !== null &&
    (session as unknown as { domOverlayState?: { type?: string } })
      .domOverlayState?.type === 'screen'

  // One line that answers "why did the AR gestures not engage?" without
  // a device attached: the resolved archetype, how many input sources the
  // session reports, whether any of them carries a gamepad (on a phone
  // it does — that is the touch position, not a controller), whether
  // the browser granted the DOM overlay, and the handheld/headset
  // decision every gate downstream keys off.
  logger.info(
    `[VR] input at start: class=${sessionTelemetry.inputClass} ` +
      `sources=${session.inputSources.length} gamepad=${hasGamepadInput()} ` +
      `domOverlay=${domOverlayActive} handheld=${handheldAr}`,
  )

  // Lazy-load the controller-model addon alongside Three.js. The
  // factory fetches per-controller glTF models from a CDN at runtime
  // (e.g. Quest Touch), so the addon itself is small but enables a
  // big polish win: users see their actual controllers in VR.
  //
  // IMPORTANT: this import must complete before `setTexture`'s
  // synchronous onReady callback can schedule the loading-scene
  // fade-out. Historically the fade ran on a 250 ms setTimeout, so a cold-cache
  // download that outran it left `active` null when it fired and the
  // loading scene stuck visible. The handover is loop-driven now, but the
  // ordering is kept: the import resolves before `active` is needed and
  // before the first frame can run the handover.
  const { XRControllerModelFactory } = await import(
    'three/examples/jsm/webxr/XRControllerModelFactory.js'
  )

  // --- Build the scene ---
  // AR mode → transparent background so the passthrough camera feed
  // shows behind everything we render.
  const scene = createVrScene(THREE_, isAr, referenceSpaceType)
  const hud = createVrHud(THREE_)
  scene.scene.add(hud.mesh)

  const browse = createVrBrowse(THREE_)
  browse.setDatasets(ctx.getDatasets())
  scene.scene.add(browse.mesh)

  // Tour control strip — added to the scene now, hidden until the
  // per-frame poll sees an active tour. Starts with an "inactive"
  // state so the mesh is invisible on session start; polling below
  // flips it on when main.ts reports a running tour.
  const tourControls = createVrTourControls(THREE_)
  scene.scene.add(tourControls.mesh)

  // Date track — the timeline of the primary dataset's declared time
  // axis. Added now and hidden until the host reports one, because most
  // datasets declare none and a session that never loads a real-time
  // stream should pay nothing for it beyond one invisible mesh.
  const timeline = createVrTimelineTrack(THREE_)
  scene.scene.add(timeline.mesh)

  // Tour overlay manager — the parent Group is always in the scene;
  // individual overlay meshes are added / removed by its show/hide
  // methods. The sink registered below forwards every DOM overlay
  // op from `tourUI` into this manager.
  const tourOverlay = createVrTourOverlay(THREE_)
  scene.scene.add(tourOverlay.group)

  // Floating date readout above the globe. Hidden by default;
  // per-frame setText(ctx.getDatasetTimeLabel()) flips it on when
  // a time-metadata-bearing dataset is loaded and drives it
  // forward each XR frame (2D's playback loop is paused during
  // the session so we can't rely on appState.timeLabel — we
  // recompute from video.currentTime directly instead).
  const timeLabel = createVrTimeLabel(THREE_)
  scene.scene.add(timeLabel.mesh)
  setVrTourOverlaySink({
    showText: (params) => tourOverlay.showText(params),
    hideText: (id) => tourOverlay.hideOverlay(id),
    hideAllText: () => tourOverlay.hideAllText(),
    showPopup: (params) => tourOverlay.showPopup(params),
    hidePopup: (id) => tourOverlay.hideOverlay(id),
    hideAllPopups: () => tourOverlay.hideAllPopups(),
    showImage: (params) => tourOverlay.showImage(params),
    hideImage: (id) => tourOverlay.hideOverlay(id),
    hideAllImages: () => tourOverlay.hideAllImages(),
    showVideo: (params, video, videoID) => tourOverlay.showVideo({
      id: videoID,
      video,
      anchor: params.anchor,
    }),
    hideVideo: (id) => tourOverlay.hideOverlay(id),
    hideAllVideos: () => tourOverlay.hideAllVideos(),
    showQuestion: (params) => tourOverlay.showQuestion({
      id: params.id,
      questionImageUrl: params.questionImageUrl,
      answerImageUrl: params.answerImageUrl,
      numberOfAnswers: params.numberOfAnswers,
      correctAnswerIndex: params.correctAnswerIndex,
      anchor: params.anchor,
      // `onComplete` was already wrapped by tourUI.showTourQuestion
      // to call hideAllTourQuestions before resolving the engine
      // promise — we just pass it through as the VR overlay's
      // "Continue tap" handler.
      onContinue: params.onComplete,
    }),
    hideAllQuestions: () => tourOverlay.hideAllQuestions(),
  })

  // --- Spatial placement (AR-only) + local-floor ref space ---
  // Two separable capabilities:
  //
  //   (a) local-floor reference space — used for resolving ANCHOR
  //       poses each frame (`frame.getPose(anchor.anchorSpace,
  //       refSpace)`). An anchor restored from a persistent handle
  //       needs this even if the user never enters Place mode in
  //       the current session. Requesting it independently means
  //       anchor-based placement keeps working on devices that
  //       expose anchors but not hit-test.
  //
  //   (b) hit-test source — used by Place mode to project a
  //       reticle onto real-world geometry. Optional; older
  //       browsers may not support it. When unavailable, the
  //       Place button stays hidden but restored anchors still
  //       track via (a).
  //
  // Both are AR-only; VR sessions have no real-world geometry.
  let hitTestSource: XRHitTestSource | null = null
  let placementRefSpace: XRReferenceSpace | null = null
  if (isAr) {
    try {
      // Use the same reference space the session was actually
      // granted. Requesting `local-floor` here when the session was
      // granted only `local` would fail every time on the fallback
      // path and leave anchor restoration silently broken.
      placementRefSpace = await session.requestReferenceSpace(referenceSpaceType)
    } catch (err) {
      logger.debug(`[VR] ${referenceSpaceType} reference space unavailable:`, err)
    }

    if ('requestHitTestSource' in session) {
      try {
        const viewerSpace = await session.requestReferenceSpace('viewer')
        // requestHitTestSource is on the session interface but not
        // in all type defs; cast to get a typed handle.
        const reqHts = (session as unknown as {
          requestHitTestSource?: (init: { space: XRReferenceSpace }) => Promise<XRHitTestSource>
        }).requestHitTestSource
        if (reqHts) {
          hitTestSource = await reqHts.call(session, { space: viewerSpace })
        }
      } catch (err) {
        logger.debug('[VR] hit-test setup failed; spatial placement disabled:', err)
      }
    }
  }
  const placement = createVrPlacement(THREE_, isAr ? 'ar' : 'vr', hitTestSource)
  // AR offers the Place button only when a hit-test source backs it; VR
  // always has a gaze ray to project, so the button always shows. It
  // stays hidden until the loading handover reveals the scene — see
  // `syncPlacementChrome` — because a live Place affordance over a
  // hidden globe invites a phone to anchor something nobody can see.
  const placementAvailable = isAr ? !!hitTestSource : true
  if (placement) {
    scene.scene.add(placement.reticleGroup)
    scene.scene.add(placement.railGroup)
    scene.scene.add(placement.placeButtonMesh)
  }

  // --- Restore persisted placement via WebXR Anchor (AR only) ---
  // See src/utils/vrPersistence.ts for why we use anchors instead of
  // saved coordinates: Quest's local-floor space is re-based every
  // session, so a saved (x, y, z) corresponds to a different
  // physical location each time. Anchors are system-tracked and
  // stable across sessions.
  //
  // Kept as a mutable session-level handle because the anchor is
  // created/restored asynchronously (may land after the first
  // render frame) and then drives the globe position per-frame.
  let currentAnchor: XRAnchor | null = null
  /**
   * Height the user chose during placement, expressed as a vertical
   * offset ABOVE the anchored surface point (metres). Stored at
   * confirm time and applied each frame in the anchor-sync block so
   * the globe respects the chosen height instead of being re-pinned
   * to the surface. Relative to the surface (not the floor) so it
   * survives local-floor coord-system re-bases just like the anchor.
   * Unchanged from 0 (surface level) until the first height-step
   * finalise; restored anchors fall back to surface-level until the
   * user re-places.
   */
  let placementHeightOffset = 0
  if (isAr) {
    const savedHandle = loadPersistedAnchorHandle()
    if (savedHandle) {
      const restoreFn = (session as unknown as {
        restorePersistentAnchor?: (uuid: string) => Promise<XRAnchor>
      }).restorePersistentAnchor
      if (restoreFn) {
        try {
          currentAnchor = await restoreFn.call(session, savedHandle)
          logger.info('[VR] Restored persistent placement anchor')
        } catch (err) {
          logger.warn('[VR] Failed to restore persistent anchor; clearing handle:', err)
          clearPersistedAnchorHandle()
        }
      }
    }
  }

  // --- Loading scene ---
  // Visible from the moment the session starts until the dataset
  // texture has a decoded frame on the globe. Hides the real globe
  // + HUD initially so the user sees a clean transition.
  const loading = createVrLoading(THREE_)
  scene.scene.add(loading.group)
  scene.setEarthVisible(false)
  hud.mesh.visible = false
  // Most of the slow part (Three.js download, session request) is
  // already done by the time we reach this point — most of the visible
  // loading time is the texture-decode wait. Start at a meaningful
  // baseline so the user sees motion not "stuck at 0%".
  loading.setProgress(0.6, 'Building scene\u2026')

  // Initial HUD state + texture. The loading scene stays up until the
  // texture reports readiness (for video this can take several hundred
  // ms — the forced seek decode); for images / no dataset the callback
  // fires synchronously during setTexture, BEFORE `active` is assigned
  // below. Readiness therefore only records a mark; every later step of
  // the handover runs from the render loop, where `active` exists.
  loading.setProgress(0.8, 'Loading dataset\u2026')
  let loadingFinalized = false
  /**
   * True once the loading scene has been removed + disposed — by
   * either the fade-out path or the session-end teardown path.
   * Guards against double-disposal if both fire (session ends
   * during fade-out).
   */
  let loadingDisposed = false
  /**
   * True once the splash has handed over and the real scene is on
   * screen. Gates the placement chrome: the 3D Place button and the DOM
   * Re-place button used to be live from the first frame while
   * `setEarthVisible(false)` had the globe hidden, so a phone could
   * enter Place mode and anchor a globe that was not there yet.
   */
  let sceneRevealed = false
  /**
   * Loading handover state, all driven from the render loop's own clock
   * rather than from timers or a promise chain. `loopElapsed` counts
   * XR-frame seconds since the first frame; readiness marks
   * `loadingReadyAt`; after LOADING_READY_PAUSE_S the fade starts; once
   * `loading.isFadedOut()` reads true the real scene is revealed. The
   * previous version chained two setTimeouts and a promise, and on a
   * phone the splash stayed up for the whole session — the user placed
   * and resized the atmosphere shell of a hidden globe behind it. A
   * timer-free path cannot stall that way, and the fallback makes an
   * untextured globe the worst case.
   */
  let loopElapsed = 0
  let loadingReadyAt: number | null = null
  let fadeStarted = false
  // Mirror the 2D app's viewport layout inside VR. Count=1 is the
  // backward-compatible single-globe path; count=2/4 builds the arc
  // with secondary globes. Scene slot 0 always reflects the 2D app's
  // *current* primary panel (drives the photoreal stack + HUD +
  // loading fade-out); scene slots 1..N hold the non-primary panels
  // in 2D order. VR follows the 2D app's layout in lockstep —
  // tapping a globe in VR does not, by itself, reorder panels here;
  // grab-rotate acts on every globe uniformly (see cead66d for why
  // the original tap-to-promote path was ripped out).
  const initialPanelCount = ctx.getPanelCount()
  logger.info(`[VR] Entering with ${initialPanelCount} panel(s), primary: ${ctx.getPrimaryIndex()}`)
  scene.setPanelCount(initialPanelCount)
  syncSecondaryTextures(scene, ctx, initialPanelCount)
  /** Readiness arrived (texture path) or was forced (fallback). Idempotent. */
  const finishLoading = (): void => {
    if (loadingFinalized) return
    loadingFinalized = true
    loadingReadyAt = loopElapsed
    try {
      loading.setProgress(1.0, 'Ready')
    } catch (err) {
      logger.warn('[VR] loading.setProgress failed:', err)
    }
  }
  /** Remove the loading scene and reveal the globe + HUD. Idempotent. */
  const revealScene = (): void => {
    if (loadingDisposed) return
    loadingDisposed = true
    scene.scene.remove(loading.group)
    loading.dispose()
    if (active) active.loading = null
    scene.setEarthVisible(true)
    hud.mesh.visible = true
    sceneRevealed = true
    syncPlacementChrome()
  }
  scene.setTexture(ctx.getDatasetTexture(), finishLoading)
  hud.setState({
    datasetTitle: ctx.getDatasetTitle(),
    isPlaying: ctx.isPlaying(),
    hasVideo: ctx.hasVideoDataset(),
    isMuted: ctx.isMuted(),
    panelCount: ctx.getPanelCount(),
    primaryIndex: ctx.getPrimaryIndex(),
    browseOpen: browse.isVisible(),
    voice: ctx.getVoiceState?.() ?? null,
  })

  // --- Optional in-view diagnostic (`?vrDebug=1`) ---
  // The phone this AR mode runs on has no devtools, so a bug report has
  // to be readable off the screen itself. Inert unless the URL asks.
  // See vrDebugPanel.ts for what each field answers.
  const debugEnabled =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('vrDebug') === '1'
  let debugPanel: VrDebugPanelHandle | null = null
  if (debugEnabled) {
    debugPanel = createVrDebugPanel(THREE_)
    scene.scene.add(debugPanel.mesh)
    logger.info('[VR] debug panel enabled (?vrDebug=1)')
  }
  let lastDebugRefreshMs = 0

  // XRControllerModelFactory was imported earlier (before scene
  // construction) so the loading-scene fade-out timing stays
  // predictable — see the comment at that import.
  const vrProjection: 'vr' | 'ar' = isAr ? 'ar' : 'vr'

  /** Compute the lat/lon under the camera's central forward ray
   * where it hits the globe, along with the current scale-derived
   * zoom and head-to-globe orientation. Returns null when the ray
   * misses the sphere (e.g. user looking away from the globe).
   * Kept inline so `scene.globe`, `camera`, and `THREE_` stay in
   * scope without threading them through another helper file. */
  function captureVrCameraState(): {
    center_lat: number
    center_lon: number
    zoom: number
    bearing: number
    pitch: number
  } | null {
    const headOrigin = new THREE_.Vector3()
    const headDir = new THREE_.Vector3(0, 0, -1)
    camera.getWorldPosition(headOrigin)
    camera.getWorldDirection(headDir)
    const ray = new THREE_.Ray(headOrigin, headDir)
    const sphereCenter = new THREE_.Vector3()
    scene.globe.getWorldPosition(sphereCenter)
    const radius = scene.globe.scale.x
    const sphere = new THREE_.Sphere(sphereCenter, radius)
    const hit = new THREE_.Vector3()
    if (!ray.intersectSphere(sphere, hit)) return null
    // Translate the hit into the globe's local frame, then undo
    // the globe's rotation so the vector represents the Earth-
    // fixed point under the user's gaze.
    const local = hit.clone().sub(sphereCenter).divideScalar(radius)
    const inverse = scene.globe.quaternion.clone().invert()
    local.applyQuaternion(inverse)
    // Spherical coords on a unit sphere. lat = asin(y), lon =
    // atan2(x, -z) — matches MapLibre's +X east, +Y up, +Z south
    // convention used by photorealEarth.ts.
    const lat = (Math.asin(local.y) * 180) / Math.PI
    const lon = (Math.atan2(local.x, -local.z) * 180) / Math.PI
    // Derive a MapLibre-comparable zoom from the head-to-globe
    // distance. A neutral view (scale 1, viewing distance ≈ 3m)
    // maps to zoom 2 to echo the photo-realistic default. Clamped
    // to MapLibre's typical 0-20 range for dashboard parity.
    const viewDistance = headOrigin.distanceTo(sphereCenter)
    const approxZoom = Math.log2(Math.max(0.1, radius / Math.max(0.1, viewDistance))) + 4
    const zoom = Math.max(0, Math.min(20, approxZoom))
    // Decompose globe rotation into bearing (yaw) + pitch. Y-axis
    // euler in world space represents how far the user has spun
    // the globe; X-axis represents tilt.
    const euler = new THREE_.Euler().setFromQuaternion(scene.globe.quaternion, 'YXZ')
    const bearing = (euler.y * 180) / Math.PI
    const pitch = (euler.x * 180) / Math.PI
    return {
      center_lat: lat,
      center_lon: lon,
      zoom,
      bearing: ((bearing % 360) + 360) % 360,
      pitch,
    }
  }

  // --- Place-mode handlers, shared by XR selects and the DOM touch
  // layer. Named closures (rather than inline in the interaction
  // context below) so the XR select path (vrInteraction) and the
  // handheld-AR touch layer (vrPlacementTouch) funnel through the
  // same confirm / cancel logic.
  let placementTouch: VrPlacementTouchHandle | null = null
  /**
   * Handheld-AR rotate layer: one finger spins the globe on its own
   * axis. Mounted only on a handheld with a granted DOM overlay, and
   * armed only OUTSIDE Place mode — the placement flow owns the globe
   * while it is active.
   */
  let rotateTouch: VrRotateTouchHandle | null = null
  /**
   * Single entry point for Place-mode transitions — keeps the
   * placement state machine and the DOM touch layer (cancel button
   * visibility, tap/drag interception) in lockstep.
   */
  const setPlacing = (placingNow: boolean): void => {
    if (!placement) return
    placement.setPlacing(placingNow)
    placementTouch?.setPlacing(placingNow)
  }
  const onPlaceButton = (): void => {
    // Toggle Place mode. Re-tap exits without placing.
    setPlacing(!(placement?.isPlacing() ?? false))
  }
  const onPlaceConfirm = (): void => {
    if (!placement) return
    // Subtle touch feedback on handhelds. Guarded feature detect —
    // returns false / is absent on headsets and desktops.
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(15)
    }
    // Position step → advance to the height step. No globe move
    // yet; the rail appears and the user picks a height.
    if (placement.getStep() === 'position') {
      placement.advanceStep()
      return
    }
    // Height step → finalise. Read the combined base XZ + chosen
    // height. Fall back to the live reticle if the height step
    // somehow has no value (defensive).
    const target = placement.getPlacementPosition()
      ?? placement.getReticlePosition()
    if (!target) return
    // Capture the chosen height as an offset above the surface so
    // the per-frame anchor sync keeps it. basePosition.y is the
    // surface reticle Y frozen in the position step; target.y is
    // the elevation-driven height. Their difference is portable
    // across local-floor re-bases (both are in the same space at
    // confirm time). VR has no anchor, so the offset is unused
    // there but harmless to compute.
    const base = placement.getBasePosition()
    placementHeightOffset = base ? target.y - base.y : 0
    // Move the globe right away so the visual response is
    // immediate. The anchor creation (below) is async; the anchor
    // sync applies placementHeightOffset so there's no jump when
    // tracking takes over.
    scene.globe.position.copy(target)
    setPlacing(false)

    // Create a system-tracked anchor from the raw hit-test
    // result. The anchor stays bolted to the real surface even
    // when the local-floor coord frame shifts (which happens
    // every new session). Replaces any previous anchor. VR has
    // no hit-test result (no real geometry), so it skips
    // anchoring entirely and keeps the placed world position.
    const hitResult = placement.getLastHitTestResult()
    const createFn = hitResult?.createAnchor
    if (!hitResult || !createFn) {
      emit({
        event_type: 'vr_placement',
        layer_id: ctx.getDatasetId() ?? '',
        persisted: false,
      })
      return
    }

    void createFn.call(hitResult).then(async anchor => {
      // Swap out any prior anchor. Only one active at a time —
      // the previous placement's anchor is no longer needed.
      if (currentAnchor) {
        try { currentAnchor.delete() } catch { /* already gone */ }
      }
      currentAnchor = anchor

      // Persistent handle for cross-session restore. Meta Quest
      // exposes this via the Anchors module extension; other
      // browsers may not. Non-fatal if it throws — the anchor
      // still tracks within this session.
      const requestFn = anchor.requestPersistentHandle
      let persisted = false
      if (requestFn) {
        try {
          const handle = await requestFn.call(anchor)
          savePersistedAnchorHandle(handle)
          persisted = true
          logger.info('[VR] Saved persistent placement anchor')
        } catch (err) {
          logger.debug('[VR] Anchor persistent handle not available:', err)
        }
      }
      emit({
        event_type: 'vr_placement',
        layer_id: ctx.getDatasetId() ?? '',
        persisted,
      })
    }).catch(err => {
      logger.warn('[VR] Failed to create placement anchor:', err)
      emit({
        event_type: 'vr_placement',
        layer_id: ctx.getDatasetId() ?? '',
        persisted: false,
      })
    })
  }

  /**
   * Axis progress a scrub is holding the playhead at, or null when none
   * is in flight. The drawer prefers it over the host's snapshot so the
   * strip follows the finger between the rationed seeks.
   */
  let timelineScrubProgress: number | null = null

  const interaction = createVrInteraction(THREE_, XRControllerModelFactory, {
    scene: scene.scene,
    globe: scene.globe,
    // Raycast target list: primary + every secondary. vrInteraction
    // treats them uniformly (grab any globe → rotate primary →
    // scene.update copies the quaternion to all secondaries).
    getAllGlobes: () => scene.allGlobes,
    hud,
    browse,
    tourControls,
    tourOverlay,
    timeline,
    placement,
    renderer,
    // Handheld session: every XR path that can write the globe's scale
    // (two-hand pinch, thumbstick zoom) stands down for the whole
    // session. A constant — it does not flap with the input sources.
    isScreenInput: () => handheldAr,
    // The rotate layer owning the globe's rotation is the narrower
    // fact, and it is what stops vrInteraction grabbing the globe.
    domTouchActive: () => rotateTouchMounted,
    onCameraSettled: () => {
      const state = captureVrCameraState()
      if (!state) return
      emitCameraSettled({
        slot_index: '0',
        projection: vrProjection,
        layer_id: ctx.getDatasetId() ?? '',
        ...state,
      })
    },
    onBrowseAction: (action) => {
      if (action.kind === 'close') {
        browse.setVisible(false)
      } else if (action.kind === 'select') {
        ctx.loadDataset(action.datasetId)
        browse.setVisible(false)
      } else if (action.kind === 'category') {
        // null = user tapped the dedicated "All" chip → clear filter.
        // non-null = filter to that category (re-tapping the
        // already-active chip re-applies the same filter; no toggle-
        // off, see VrBrowseAction docstring).
        browse.setCategoryFilter(action.category)
      }
    },
    onTourAction: (action) => {
      // Thin pass-through: the strip's button layout and the tour-
      // engine's control surface are 1:1, so the VR session doesn't
      // need to interpret anything here. main.ts owns the engine and
      // fans these out to TourEngine.play/pause/next/prev/stop.
      switch (action) {
        case 'tour-play-pause':
          ctx.tourTogglePlayPause()
          break
        case 'tour-prev':
          ctx.tourPrev()
          break
        case 'tour-next':
          ctx.tourNext()
          break
        case 'tour-stop':
          ctx.tourStop()
          break
      }
    },
    onHudAction: (action) => {
      if (action === 'play-pause') {
        ctx.togglePlayPause()
      } else if (action === 'mute') {
        // Flip the primary video's muted flag. The per-frame
        // hud.setState pipes ctx.isMuted() back through so the
        // icon updates on the next redraw.
        ctx.toggleMute()
      } else if (action === 'browse') {
        // Toggle the in-VR dataset browse panel. Its `isVisible`
        // feeds `hud.setState({ browseOpen })` each frame, so the
        // next render shows the button in its active-state color.
        browse.setVisible(!browse.isVisible())
      } else if (action === 'voice') {
        // Orbit's mic. Called straight from the select handler rather
        // than deferred, so the tap is as close to a user gesture as
        // the session allows — starting capture and unlocking speech
        // output can both depend on one.
        ctx.toggleVoice?.()
      } else if (action === 'exit-vr') {
        // Programmatic exit — fires the 'end' event, which routes
        // through the same teardown path as headset-initiated exits.
        void session.end().catch(err =>
          logger.warn('[VR] session.end() from exit-vr button failed:', err),
        )
      }
    },
    onPlaceButton,
    onPlaceConfirm,
    onTimelineSeek: (progress, phase) => {
      const snapshot = ctx.getDatasetTimeline()
      if (!snapshot) return
      // The strip follows the finger immediately; the decoder is steered
      // through the host, which maps progress to the frame's midpoint.
      timelineScrubProgress = phase === 'preview' ? progress : null
      ctx.seekToTimelineDate(
        snapshot.startMs + progress * (snapshot.endMs - snapshot.startMs),
      )
    },
    onExit: () => {
      void session.end().catch(err =>
        logger.warn('[VR] session.end() from grip failed:', err),
      )
    },
  })

  // --- Handheld-AR placement chrome ---
  // Mounted only when the session actually granted the DOM overlay
  // (Android `screen` input) AND the session is a handheld: touches on
  // empty screen then arrive as DOM touch events, which buys the
  // explicit Place / Cancel buttons, the Re-place corner button, and the
  // `beforexrselect` dedup that swallows stray taps during placement so
  // they never reach the XR confirm short-circuit. Controller sessions
  // keep trigger-to-confirm + the raycast Place button. See
  // vrPlacementTouch.ts for the full rationale.
  //
  // Idempotent and deferred: both affordances appear only once the
  // loading handover has revealed the globe (see `sceneRevealed`), so
  // this is called from `revealScene()` and no-ops if it runs earlier.
  function syncPlacementChrome(): void {
    if (!placement || !sceneRevealed) return
    if (placementAvailable) placement.placeButtonMesh.visible = true
    if (placementTouch || !handheldAr || !domOverlayActive || !domOverlayRoot) return
    placementTouch = createVrPlacementTouch({
      onConfirm: onPlaceConfirm,
      onCancel: () => setPlacing(false),
      onRePlace: onPlaceButton,
      isHeightStep: () => placement.getStep() === 'height',
    })
    placementTouch.mount(domOverlayRoot)
  }
  syncPlacementChrome()

  // --- Handheld-AR zoom slider ---
  // The one sizing control a phone has: an explicit DOM slider, never a
  // touch gesture. Mounted once, INTO the overlay root so the browser
  // renders it over the camera feed; headsets keep the thumbstick.
  let zoomOverlay: VrZoomOverlayHandle | null = null
  const syncZoomOverlay = (): void => {
    const wantOverlay = handheldAr && domOverlayActive
    if (wantOverlay && !zoomOverlay) {
      zoomOverlay = createVrZoomOverlay({
        onZoom: (raw) => {
          const clamped = Math.max(MIN_GLOBE_SCALE, Math.min(MAX_GLOBE_SCALE, raw))
          scene.globe.scale.setScalar(clamped)
        },
        initialScale: scene.globe.scale.x,
        minScale: MIN_GLOBE_SCALE,
        maxScale: MAX_GLOBE_SCALE,
      })
      zoomOverlay.mount(domOverlayRoot ?? document.body)
    } else if (!wantOverlay && zoomOverlay) {
      zoomOverlay.dispose()
      zoomOverlay = null
    }
  }
  syncZoomOverlay()

  // --- Handheld-AR rotate (one finger, nothing else) ---
  // The whole of what touch does to a placed globe on a phone: a
  // sideways drag spins it about its own axis. No move, no pinch, no
  // twist — a second finger is ignored, and no touch here can write the
  // scale or the position. See src/ui/vrRotateTouch.ts, and
  // vrInteraction's isScreenInput / domTouchActive guards for how the
  // XR grab, pinch and thumbstick paths stand down on this device.
  if (handheldAr && domOverlayActive) {
    logger.info('[VR] handheld rotate layer mounted — one finger spins the globe')
    rotateTouch = createVrRotateTouch({
      onRotate: (delta) => {
        // Object3D.rotateY is about the globe's LOCAL Y — its own
        // axis, whatever orientation it currently has. scene.update
        // copies the quaternion to any secondary globes.
        scene.globe.rotateY(delta)
      },
    })
    rotateTouchMounted = true
  }

  active = {
    session,
    renderer,
    camera,
    scene,
    hud,
    disposeZoomOverlay: () => {
      zoomOverlay?.dispose()
      zoomOverlay = null
      rotateTouch?.dispose()
      rotateTouch = null
      rotateTouchMounted = false
      placementTouch?.dispose()
      placementTouch = null
    },
    browse,
    tourControls,
    tourOverlay,
    timeline,
    timeLabel,
    interaction,
    loading,
    placement,
    refSpace: placementRefSpace,
    hitTestSource,
  }

  // --- Render loop ---
  //
  // HUD + Place button follow the globe via these offsets — so when
  // the user places the globe on a real surface (AR mode), the
  // controls track underneath it rather than staying at some fixed
  // spot in mid-air. Large -y offset (more negative than globe
  // radius) ensures they're clearly BELOW the globe's visible
  // silhouette even when looking straight at the globe. Small +z
  // offset pulls them slightly closer to the user than the globe
  // for comfortable reading.
  /**
   * Minimal fingerprint to detect "catalog has changed in a way the
   * browse panel cares about" — the array length plus the number of
   * entries that carry a category. Captures both the initial
   * populate (length goes from 0 to N) and the enriched-metadata
   * arrival (length stable, category-count goes from 0 to N). main.ts
   * returns a fresh array every call to `getDatasets()`, so we don't
   * bother with an identity check.
   */
  let lastBrowseDatasetsLen = -1
  let lastBrowseCategoryCount = -1
  /**
   * Last wall-clock ms we polled `ctx.getDatasets()`. main.ts rebuilds
   * the catalog array (filter + map + Set + Array.from) every call,
   * so we don't want to hit it at XR frame rate. Poll at 1 Hz while
   * the browse panel is open; skip entirely while it's closed.
   */
  let lastBrowseDatasetsPollMs = -Infinity
  /** True last frame — forces a poll on the frame the panel opens. */
  let lastBrowseVisible = false
  const BROWSE_POLL_INTERVAL_MS = 1000

  const hudOffset = new THREE_.Vector3(0, -0.65, 0.15)
  const placeOffset = new THREE_.Vector3(0, -0.5, 0.15)
  const browseOffset = new THREE_.Vector3(0.7, 0, 0.3)
  /**
   * Tour-control strip sits just below the dataset HUD, close
   * enough to feel like part of the same control cluster. The
   * HUD itself is at globe + (0, -0.65, 0.15); this offset keeps
   * the same x/z and adds another ~12 cm of y-drop so the two
   * panels don't overlap even when the user has zoomed the globe.
   */
  /**
   * Date track sits where the tour strip used to: directly under the HUD,
   * because the two answer the same question ("what am I looking at, and
   * how do I move it?"). The tour strip drops a further 15 cm so an
   * active tour and a real-time stream can both be on screen without one
   * covering the other.
   */
  const timelineOffset = new THREE_.Vector3(0, -0.80, 0.15)
  const tourControlsOffset = new THREE_.Vector3(0, -0.95, 0.15)
  /** Scratch reused per-frame for position math; avoids GC churn. */
  const scratchPos = new THREE_.Vector3()
  /** Scratch vector reused every frame by the billboard-lookAt block below. */
  const scratchCamPos = new THREE_.Vector3()
  /** Headset forward direction, reused by the VR gaze + height placement path. */
  const scratchGazeDir = new THREE_.Vector3()
  // `lastTime` starts null so the very first frame uses its own
  // timestamp as "previous" and computes a 0-duration delta —
  // rather than mixing XR's frame timestamp (first callback arg)
  // with performance.now() from pre-loop init, which can be on a
  // different clock and produce a huge first delta.
  let lastTime: number | null = null
  /**
   * One-shot gaze-based spawn (both modes). The hardcoded GLOBE_POSITION
   * assumes the user faces -Z at session start; instead, on the first
   * frame with a valid viewer pose we place the globe in front of
   * wherever they're actually looking (see vrSpawn.ts). In AR the
   * globe floats mid-air at eye height until placed — same as today's
   * hardcoded spawn — and a restored placement anchor still wins: the
   * per-frame anchor sync below overwrites this position as soon as
   * the anchor pose resolves. The HUD / Place button re-anchor to the
   * globe every frame below, and secondary globes follow the primary
   * in scene.update(), so no other object needs an explicit respawn.
   */
  let pendingGazeSpawn = true
  renderer.setAnimationLoop((time, frame) => {
    // `??` instead of `||` — some XR implementations emit a valid
    // timestamp of 0 on the very first frame, which `||` would
    // falsely treat as "no time" and fall back to performance.now(),
    // mixing clocks.
    const now = time ?? performance.now()
    const previousTime = lastTime ?? now
    const delta = Math.min(0.1, (now - previousTime) / 1000)
    lastTime = now

    if (!active) return
    sessionTelemetry.frames++

    // Gaze-based spawn — runs once, on the first frame where the
    // viewer pose is available. `renderer.xr.getReferenceSpace()` is
    // the space Three.js resolves all camera/scene coords in, so the
    // pose and globe.position share a frame regardless of whether the
    // session got local-floor or the local fallback.
    if (pendingGazeSpawn && frame) {
      const refSpace = renderer.xr.getReferenceSpace()
      const pose = refSpace ? frame.getViewerPose(refSpace) : null
      if (pose) {
        pendingGazeSpawn = false
        const spawn = computeGazeSpawnPosition(
          pose.transform.position,
          pose.transform.orientation,
        )
        active.scene.globe.position.set(spawn.x, spawn.y, spawn.z)
      }
    }

    // Spatial placement — per-frame work, but only while in Place mode.
    // Two position sources, one height step:
    //   - AR + hit-test  → update() projects the controller reticle.
    //   - VR (no geometry) → updateGaze() projects the headset ray
    //     onto a virtual floor.
    //   - height step (either mode) → updateHeight() maps headset
    //     pitch to a vertical position along the rail.
    if (active.placement) {
      if (active.refSpace && frame && active.placement.getStep() === 'position') {
        active.placement.update(frame, active.refSpace)
      }
      // VR gaze position step — no XR frame/refSpace needed, the
      // Three.js camera already carries the headset world pose.
      if (!isAr && active.placement.getStep() === 'position') {
        active.camera.getWorldPosition(scratchCamPos)
        active.camera.getWorldDirection(scratchGazeDir)
        active.placement.updateGaze(scratchCamPos, scratchGazeDir)
      }
      // Height step — every device, one input: the pose's own pitch.
      // On a headset that is the user's head; on a phone it is the phone
      // being aimed with, which is the same gesture the position step's
      // reticle already follows. (The handheld layer used to own a touch
      // drag here too; touch is rotate-only now.) Drive the globe LIVE
      // along the chosen height so the user sees it slide as they tilt,
      // instead of a frozen globe that only jumps on confirm — which
      // read as "nothing locked". The chosen XZ is frozen from the
      // position step; only Y moves.
      if (active.placement.getStep() === 'height') {
        active.camera.getWorldDirection(scratchGazeDir)
        const elevation = Math.asin(
          Math.max(-1, Math.min(1, scratchGazeDir.y)),
        )
        active.placement.updateHeight(elevation)
        const preview = active.placement.getPlacementPosition()
        if (preview) {
          active.scene.globe.position.copy(preview)
        }
      }
    }

    // Arm the rotate layer only when nothing else owns the touch: the
    // placement flow owns the globe while it is active, and an open
    // browse panel owns a drag as a list scroll (that scroll runs
    // through the XR ray, so without this a drag across the panel would
    // scroll the list AND spin the globe). It also waits for the splash
    // to hand over — there is nothing placed, or even visible, to spin
    // before that. `setEnabled` is a no-op when the state has not
    // changed.
    rotateTouch?.setEnabled(
      sceneRevealed &&
        !active.placement?.isPlacing() &&
        !active.browse.isVisible(),
    )

    // Sync globe position from the system-tracked anchor, if any.
    // The anchor's anchorSpace is resolved in local-floor coords
    // each frame — but critically, the system adjusts what
    // "(anchor.x, anchor.y, anchor.z)" means as local-floor gets
    // re-based, so the globe stays bolted to the real surface. The
    // vertical offset is the height the user chose during placement
    // (placementHeightOffset), NOT a fixed lift — applying it here
    // is what makes the height step actually stick in AR. Writing
    // directly into globe.position avoids per-frame allocation.
    if (currentAnchor && frame && active.refSpace) {
      const anchorPose = frame.getPose(currentAnchor.anchorSpace, active.refSpace)
      if (anchorPose) {
        const ap = anchorPose.transform.position
        active.scene.globe.position.set(
          ap.x,
          ap.y + placementHeightOffset,
          ap.z,
        )
      }
    }

    // Swap the dataset texture if the app loaded/changed something
    // while we're in VR. The scene's setTexture is internally
    // debounced (compares against its own active key) so polling
    // every frame is cheap in the steady state. Also mirror the
    // 2D viewport's panel count + per-slot textures — setPanelCount
    // is idempotent when the count hasn't changed, and per-slot
    // setSlotTexture shares the same debounce path as the primary.
    const panelCount = ctx.getPanelCount()
    active.scene.setPanelCount(panelCount)
    active.scene.setTexture(ctx.getDatasetTexture())
    syncSecondaryTextures(active.scene, ctx, panelCount)
    // AYNI: the layer stack follows the 2D app's, applied on change only.
    const mapLayers = ctx.getMapLayerImages?.() ?? null
    if (mapLayers !== appliedMapLayers) {
      appliedMapLayers = mapLayers
      active.scene.setMapLayers(mapLayers)
    }

    // Poll the 2D catalog only while the browse panel is open, and
    // only at 1 Hz once open — main.ts rebuilds the catalog array
    // (filter + map + Set + Array.from) on every getDatasets() call,
    // and at XR frame rate (72–90 Hz) that adds up to pointless
    // per-frame allocation. A 1-second refresh is fast enough for
    // the user to notice new chips when enriched metadata lands or
    // the 2D app updates the catalog. Always poll the moment the
    // panel becomes visible so the first render has fresh data.
    const browseVisibleNow = active.browse.isVisible()
    if (browseVisibleNow) {
      const becameVisible = !lastBrowseVisible
      const sinceLastPoll = now - lastBrowseDatasetsPollMs
      if (becameVisible || sinceLastPoll >= BROWSE_POLL_INTERVAL_MS) {
        lastBrowseDatasetsPollMs = now
        const currentDatasets = ctx.getDatasets()
        let categoryCount = 0
        for (let i = 0; i < currentDatasets.length; i++) {
          categoryCount += currentDatasets[i].categories.length
        }
        if (
          becameVisible ||
          currentDatasets.length !== lastBrowseDatasetsLen ||
          categoryCount !== lastBrowseCategoryCount
        ) {
          lastBrowseDatasetsLen = currentDatasets.length
          lastBrowseCategoryCount = categoryCount
          active.browse.setDatasets(currentDatasets)
        }
      }
    }
    lastBrowseVisible = browseVisibleNow

    // HUD reflects the latest app state every frame. setState is
    // internally debounced — it only redraws when a field changes.
    active.hud.setState({
      datasetTitle: ctx.getDatasetTitle(),
      isPlaying: ctx.isPlaying(),
      hasVideo: ctx.hasVideoDataset(),
      isMuted: ctx.isMuted(),
      panelCount,
      primaryIndex: ctx.getPrimaryIndex(),
      browseOpen: active.browse.isVisible(),
      probeReadout: readVrProbe(active.interaction, ctx, now),
      voice: ctx.getVoiceState?.() ?? null,
    })

    // Tour strip mirrors the engine state. Always poll; the strip's
    // setState is internally debounced, so a per-frame call with an
    // unchanged state is a cheap equality check. `active` toggling
    // to false hides the mesh without further work.
    active.tourControls.setState(ctx.getTourState())

    // Time label — recompute from video.currentTime every XR frame
    // (the 2D playback loop that normally drives appState.timeLabel
    // is paused while WebXR is active, so we can't read a cached
    // value). setText is idempotent when the string is unchanged,
    // so this is cheap in the steady state. Pause behaviour falls
    // out naturally — a paused video's currentTime doesn't advance.
    active.timeLabel.setText(ctx.getDatasetTimeLabel())
    active.timeLabel.update(active.camera, active.scene.globe.position)

    // Borders overlay mirrors the shared view preference. 2D toggles
    // (Tools menu / tour envShowWorldBorder) write to the same
    // preference, so the VR globe stays in sync without a dedicated
    // callback. `scene.setBordersVisible` is internally idempotent.
    active.scene.setBordersVisible(getBordersVisible())

    active.interaction.update(delta)

    // flyTo animation — drives the globe quaternion toward the
    // captured target each frame. Must run AFTER interaction.update
    // (which writes user-grab rotations) and BEFORE scene.update
    // (which propagates the primary's quaternion to secondaries).
    // A fresh user grab mid-animation will overwrite globe.quaternion,
    // but the very next frame slerp reads `startQuat` not the current
    // quat — so flyTo "wins" until the duration elapses. Good enough
    // for v1; a user-grab interrupt is cheap follow-up if requested.
    if (pendingFlyTo) {
      const elapsed = now - pendingFlyTo.startTime
      // Guard the instant-jump case: durationMs = 0 (from
      // `animated: false` tour tasks) would divide by zero and on
      // the first frame where elapsed === 0 produce NaN, leaving
      // the slerp in an undefined state. Collapse to t=1 so the
      // snap completes on the first tick.
      const t = pendingFlyTo.durationMs > 0
        ? Math.min(1, elapsed / pendingFlyTo.durationMs)
        : 1
      // Ease-in-out cubic — matches MapLibre flyTo's perceived pacing.
      const eased = t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2
      active.scene.globe.quaternion.slerpQuaternions(
        pendingFlyTo.startQuat,
        pendingFlyTo.endQuat,
        eased,
      )
      if (t >= 1) {
        const done = pendingFlyTo
        pendingFlyTo = null
        done.resolve()
      }
    }

    // Scene-level per-frame sync (e.g. ground shadow scale matching
    // globe zoom). Cheap and always runs even when the loading
    // scene is still up so the shadow is correct the moment the
    // globe becomes visible.
    active.scene.update()

    // Tour overlay pose resolution — world-anchored overlays track
    // the globe, gaze-follow overlays lerp toward a camera-local
    // target. No-op when no overlays exist, which is the common
    // case (most users aren't on a tour).
    //
    // Multi-globe hint shifts NEW overlay default placement above
    // the primary when an arc is visible — keeps wide popup /
    // image / question panels from landing between globes and
    // occluding the sibling data. Idempotent; cheap to call every
    // frame. Existing overlays keep their stored offset.
    active.tourOverlay.setMultiGlobeHint(panelCount > 1)
    // Global default anchor mode — per-overlay `anchor` hints in
    // the tour JSON still win over this. No runtime UI toggles
    // this yet; the preference is settable programmatically (or
    // via a future Tools-menu checkbox) so power users can flip
    // their default without losing the tour-author's specific
    // overrides.
    active.tourOverlay.setGazeFollowDefault(getGazeFollowOverlays())
    active.tourOverlay.update(active.camera, active.scene.globe.position, delta)

    // Track HUD + Place button to the globe's current position so
    // when the user places the globe on a real surface in AR, the
    // controls go with it rather than floating in mid-air at their
    // initial spot. Deliberately NOT parented to the globe (would
    // inherit rotation + wobble with user grab); manual sync via
    // offset vectors lets us keep position while leaving orientation
    // globe-independent.
    //
    // Each panel also billboards toward the camera via lookAt — if
    // the user walks around a placed globe in AR (or starts from a
    // non-default standing position), the panel would otherwise
    // stay facing -z world and end up edge-on to the viewer. Same
    // pattern as vrTimeLabel above and the tour-overlay's
    // world-anchor billboard — user always sees panels face-on.
    active.camera.getWorldPosition(scratchCamPos)

    scratchPos.copy(active.scene.globe.position).add(hudOffset)
    active.hud.mesh.position.copy(scratchPos)
    active.hud.mesh.lookAt(scratchCamPos)
    if (active.browse.isVisible()) {
      scratchPos.copy(active.scene.globe.position).add(browseOffset)
      active.browse.mesh.position.copy(scratchPos)
      active.browse.mesh.lookAt(scratchCamPos)
    }
    if (active.tourControls.isVisible()) {
      scratchPos.copy(active.scene.globe.position).add(tourControlsOffset)
      active.tourControls.mesh.position.copy(scratchPos)
      active.tourControls.mesh.lookAt(scratchCamPos)
    }
    // Date track: asked for every frame, which is what makes the host's
    // answer a cheap map read rather than a request. While a scrub is in
    // flight the drawn playhead follows the finger rather than the video
    // — the decoder is steered in steps (see vrInteraction's
    // SCRUB_SEEK_INTERVAL_MS) and the strip should not stutter with it.
    {
      // Gated on the handover like the placement chrome: the axis is a
      // description of the globe, and floating it over the splash would
      // describe a globe that is not on screen yet.
      const snapshot = sceneRevealed ? ctx.getDatasetTimeline() : null
      if (snapshot) {
        const currentMs =
          timelineScrubProgress === null
            ? snapshot.currentMs
            : snapshot.startMs +
              timelineScrubProgress * (snapshot.endMs - snapshot.startMs)
        active.timeline.setState({
          ...snapshot,
          currentMs,
          scrubbing: timelineScrubProgress !== null,
        })
        scratchPos.copy(active.scene.globe.position).add(timelineOffset)
        active.timeline.mesh.position.copy(scratchPos)
        active.timeline.mesh.lookAt(scratchCamPos)
      } else {
        active.timeline.setState(null)
      }
    }
    if (active.placement) {
      scratchPos.copy(active.scene.globe.position).add(placeOffset)
      active.placement.placeButtonMesh.position.copy(scratchPos)
      active.placement.placeButtonMesh.lookAt(scratchCamPos)
    }

    // Loading handover, on the loop's own clock (see the state block
    // above finishLoading for why no timers are involved):
    //   1. readiness never arrives → force it after LOADING_FALLBACK_S
    //   2. readiness + a short pause at 100% → start the fade
    //   3. fade complete → reveal the globe + HUD, drop the splash
    // A clock that stalls (a non-finite or zero delta from the XR frame
    // timestamp) must not stall the handover with it: advance by a
    // nominal frame instead, so the fallback and the fade still land.
    const handoverDelta = Number.isFinite(delta) && delta > 0 ? delta : 1 / 60
    loopElapsed += handoverDelta
    const splash = active.loading
    if (splash && !loadingDisposed) {
      if (!loadingFinalized && loopElapsed >= LOADING_FALLBACK_S) {
        logger.warn(
          `[VR] no texture readiness after ${LOADING_FALLBACK_S}s — dismissing the loading scene anyway`,
        )
        finishLoading()
      }
      if (
        loadingFinalized &&
        !fadeStarted &&
        loopElapsed - (loadingReadyAt ?? 0) >= LOADING_READY_PAUSE_S
      ) {
        fadeStarted = true
        void splash.fadeOut()
      }
      // Drive the loading scene's animation (rings spin, sphere pulses,
      // fade-out tween, progress bar ease).
      splash.update(handoverDelta)
      if (fadeStarted && splash.isFadedOut()) revealScene()
    }

    // Diagnostic readout: position every frame (it is camera-locked),
    // re-text it at 1 Hz — `getDatasets()` builds a fresh array each
    // call, which is why the browse poll is 1 Hz too.
    if (debugPanel) {
      debugPanel.update(active.camera)
      if (now - lastDebugRefreshMs > 1000) {
        lastDebugRefreshMs = now
        debugPanel.setLines([
          `${isAr ? 'AR' : 'VR'} class=${sessionTelemetry.inputClass} src=${session.inputSources.length} ` +
            `pad=${hasGamepadInput() ? 'y' : 'n'} domOv=${domOverlayActive ? 'y' : 'n'}`,
          `hand=${handheldAr ? 'y' : 'n'} rotate=${rotateTouchMounted ? 'y' : 'n'} ` +
            `tl=${timeline.isVisible() ? 'y' : 'n'} ` +
            `zoomUi=${zoomOverlay !== null ? 'y' : 'n'}`,
          `img=${ctx.getDatasetTexture() ? 'y' : 'n'} load=${active.loading ? 'y' : 'n'} ` +
            `anchor=${currentAnchor ? 'y' : 'n'} place=${placement ? placement.getStep() : '-'}`,
          `cat=${ctx.getDatasets().length} panels=${ctx.getPanelCount()} ` +
            `scale=${active.scene.globe.scale.x.toFixed(2)}`,
          `loadT=${loopElapsed.toFixed(1)} ready=${loadingFinalized ? 'y' : 'n'} ` +
            `fade=${fadeStarted ? 'y' : 'n'} shown=${loadingDisposed ? 'y' : 'n'}`,
        ])
      }
    }

    active.renderer.render(active.scene.scene, active.camera)
  })

  // --- Teardown ---
  session.addEventListener('end', () => {
    logger.info('[VR] Session ended, disposing resources')

    // Telemetry: emit `vr_session_ended` once per session, before
    // any disposal happens so frame counters / timestamps still
    // exist. mean_fps = total frames / wall-clock duration (a true
    // arithmetic mean, not a median — the name reflects what we
    // compute). 0 when the session was too short for a meaningful
    // sample; dashboards filter `mean_fps > 0` to exclude these.
    // For per-window medians, the perf_sampler emits
    // fps_median_10s during the session.
    if (sessionTelemetry.sessionStartedAtWall > 0) {
      const durationMs = Math.max(0, Date.now() - sessionTelemetry.sessionStartedAtWall)
      const meanFps = durationMs >= 1000
        ? Math.round((sessionTelemetry.frames * 1000) / durationMs)
        : 0
      emit({
        event_type: 'vr_session_ended',
        mode,
        exit_reason: sessionTelemetry.exitReason,
        duration_ms: durationMs,
        mean_fps: meanFps,
        // Snapshot of the loaded dataset at end-of-session. May
        // differ from `vr_session_started.layer_id` when the user
        // loaded something different while in VR.
        layer_id: ctx.getDatasetId() ?? '',
      })
    }

    if (!active) return
    const a = active
    active = null
    a.renderer.setAnimationLoop(null)
    // The probe cache is module-scoped (like its scratch canvas), so
    // clear it or the next session opens showing the last session's
    // number until the first sample lands.
    resetVrProbe()
    // Resolve any in-flight flyTo so awaiting callers don't hang
    // after the session ends (tour engine's execFlyTo, chat's
    // onFlyTo handler).
    cancelFlyTo()
    a.interaction.dispose()
    a.disposeZoomOverlay()
    if (debugPanel) {
      a.scene.scene.remove(debugPanel.mesh)
      debugPanel.dispose()
      debugPanel = null
    }
    a.hud.dispose()
    a.browse.dispose()
    a.scene.scene.remove(a.tourControls.mesh)
    a.tourControls.dispose()
    a.scene.scene.remove(a.timeline.mesh)
    a.timeline.dispose()
    a.scene.scene.remove(a.timeLabel.mesh)
    a.timeLabel.dispose()
    // Clear the tourUI sink first so any in-flight `hideAll*` calls
    // from the tour engine (e.g. tour cleanup fired by stopTour()
    // during exit) don't land on the about-to-be-disposed manager.
    setVrTourOverlaySink(null)
    a.scene.scene.remove(a.tourOverlay.group)
    a.tourOverlay.dispose()
    // Loading scene may still be present if the user exited before
    // dataset finished loading. Dispose it explicitly so we don't
    // leak the canvases + textures. Flag handshake with the fade-out
    // path ensures we never double-dispose.
    if (a.loading && !loadingDisposed) {
      loadingDisposed = true
      a.scene.scene.remove(a.loading.group)
      a.loading.dispose()
    }
    if (a.placement) {
      a.scene.scene.remove(a.placement.reticleGroup)
      a.scene.scene.remove(a.placement.railGroup)
      a.scene.scene.remove(a.placement.placeButtonMesh)
      a.placement.dispose()
    }
    // Anchors are bound to the XR session; deleting is optional
    // (they're implicitly cleaned up when the session ends) but
    // explicit disposal avoids a brief "still tracked" state if
    // anything else held a reference.
    if (currentAnchor) {
      try { currentAnchor.delete() } catch { /* already gone */ }
      currentAnchor = null
    }
    // Cancel the hit-test source so the platform releases the
    // viewer-space tracking subscription. The subscription
    // otherwise lives until session-end garbage-collects it
    // implicitly, which wastes work during the teardown window.
    if (a.hitTestSource) {
      try { a.hitTestSource.cancel() } catch { /* already cancelled */ }
    }
    a.scene.dispose()
    a.renderer.dispose()
    a.renderer.domElement.remove()
    ctx.onSessionEnd?.()
  })

  logger.info(`[VR] ${isAr ? 'AR passthrough' : 'VR'} session started`)
}

/** Convenience wrapper — request `immersive-vr` (full virtual environment). */
export const enterVr = (ctx: VrSessionContext): Promise<void> =>
  enterImmersive('vr', ctx)

/** Convenience wrapper — request `immersive-ar` (passthrough mixed reality). */
export const enterAr = (ctx: VrSessionContext): Promise<void> =>
  enterImmersive('ar', ctx)

/**
 * End the current VR session if one is active. Safe to call
 * unconditionally. Resource cleanup happens inside the 'end' handler
 * registered in `enterVr`, so this is just a thin wrapper.
 */
export async function exitVr(): Promise<void> {
  if (!active) return
  try {
    await active.session.end()
  } catch (err) {
    logger.warn('[VR] exitVr: session.end() failed:', err)
  }
}
