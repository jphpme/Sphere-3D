/**
 * Spatial placement — anchor the globe to a real-world surface in
 * AR mode via WebXR `hit-test`.
 *
 * UX flow (Phase 2.1, Option 1 from the plan — explicit Place mode):
 *   1. User taps the floating Place button (small target icon
 *      near the HUD).
 *   2. Place mode activates: reticle appears wherever the
 *      controller ray intersects a real-world surface.
 *   3. User taps trigger anywhere → globe snaps to the reticle
 *      position (lifted a few cm so it visually rests on top of
 *      the surface rather than intersecting it).
 *   4. Place mode exits automatically; Place button returns.
 *
 * Falls back gracefully when `hit-test` is unavailable (VR mode,
 * older browsers, devices without scene understanding) — the Place
 * button stays hidden and the globe keeps its default position.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 2.1 — spatial placement design.
 */

import type * as THREE from 'three'
import {
  HEIGHT_MAX,
  HEIGHT_MIN,
  elevationToHeight,
  rayPlaneXZ,
} from './vrHeightControl'

// --- Reticle dimensions ---
/** Outer radius of the reticle ring. ~7 cm reads well at floor distance. */
const RETICLE_OUTER_RADIUS = 0.07
const RETICLE_TUBE = 0.004
/** Small filled centre dot so the reticle has a visible target point. */
const RETICLE_CENTER_RADIUS = 0.008

// --- Place button dimensions (a small floating disc near the HUD) ---
const PLACE_BUTTON_WIDTH = 0.06
const PLACE_BUTTON_HEIGHT = 0.06
const PLACE_BUTTON_CANVAS_SIZE = 256

/**
 * Base vertical offset added to the reticle position when placing
 * the globe at unit scale. The hit-test point is on the surface
 * itself; lifting by GLOBE_RADIUS (0.5 m) puts the globe's centre
 * half a metre above the surface so the visible bottom rests on
 * the table. The actual lift is scaled by the globe's current
 * uniform scale at placement time — see `liftedPlacementPosition`.
 *
 * Only applied in AR once placement is finalised; the height step
 * owns the Y during interactive placement.
 */
const PLACE_LIFT_Y = 0.5

/**
 * Y coordinate of the virtual floor plane used by VR gaze placement.
 * In the `local-floor` reference space y=0 is the real floor, so
 * gaze projects onto the ground just like an AR hit-test would. In
 * the `local` (no floor) space y=0 is the head origin; we still
 * project onto y=0 there, which lands the globe around knee/lap
 * height — acceptable since the user immediately adjusts height in
 * step 2.
 */
const VR_GAZE_FLOOR_Y = 0

// --- Height rail (vertical indicator shown during the height step) ---
/** Total height of the rail. Spans the full placeable height band. */
const RAIL_HEIGHT = HEIGHT_MAX - HEIGHT_MIN
/** Radius of the slider marker that rides up/down the rail. */
const RAIL_MARKER_RADIUS = 0.02
/** Thin rail line radius. */
const RAIL_TUBE = 0.003

/**
 * Where the floating Place button sits relative to the globe.
 * Positioned just above the HUD (HUD is at y=1.0, z=-1.0) so it's
 * close enough to feel related but not overlapping.
 */
const PLACE_BUTTON_POSITION = { x: 0, y: 1.18, z: -1.0 }

const ACCENT_COLOR = 0x4da6ff // --color-accent

/**
 * Placement sub-step. Placement is no longer a single confirm; it
 * advances through two stages so the user controls height
 * separately from horizontal location.
 *
 * - `'position'` — picking the XZ location. AR: controller hit-test
 *   reticle on real surfaces. VR: gaze ray projected onto a virtual
 *   floor plane (no real geometry). Trigger advances to `'height'`.
 * - `'height'` — XZ locked, the user tilts their head to raise/lower
 *   the globe along a visible rail. Trigger finalises placement.
 */
export type VrPlacementStep = 'position' | 'height'

export interface VrPlacementHandle {
  /** Reticle group — caller adds to scene. Hidden until in Place mode + hit available. */
  readonly reticleGroup: THREE.Group
  /** Height-rail group — caller adds to scene. Visible only during the height step. */
  readonly railGroup: THREE.Group
  /** Floating Place button mesh — caller adds to scene. Used as a raycast target. */
  readonly placeButtonMesh: THREE.Mesh
  /** True while user is in Place mode (either step). */
  isPlacing(): boolean
  /** Programmatically toggle Place mode. Resets to the position step. */
  setPlacing(active: boolean): void
  /** Current sub-step. `'position'` until the first confirm, then `'height'`. */
  getStep(): VrPlacementStep
  /**
   * Advance the placement state machine. From `'position'` → freezes
   * the chosen XZ and switches to `'height'`. From `'height'` → no-op
   * (the caller reads {@link getPlacementPosition} and finalises).
   * Safe to call when not placing.
   */
  advanceStep(): void
  /**
   * Per-frame update for AR sessions — call from the VR session
   * render loop. Reads a hit-test result from the controller's
   * viewer-space ray and positions the reticle there. Drives the
   * `'position'` step. No-op when not in Place mode, in the height
   * step, or when hit-test is unavailable.
   */
  update(frame: XRFrame, refSpace: XRReferenceSpace): void
  /**
   * Per-frame update for VR (non-AR) sessions. Projects the headset
   * gaze ray onto a virtual floor plane to drive the `'position'`
   * step. The caller supplies the headset world pose each frame
   * (origin + unit forward). No-op when not in Place mode or when
   * in the height step.
   */
  updateGaze(
    cameraOrigin: { x: number; y: number; z: number },
    cameraForward: { x: number; y: number; z: number },
  ): void
  /**
   * Per-frame update for the height step. Maps the headset pitch
   * (radians, up positive) to a globe height and moves the height
   * marker along the rail. No-op unless in the `'height'` step.
   */
  updateHeight(elevationRad: number): void
  /**
   * Set the height directly (metres above floor), clamped to the
   * placeable range. Touch-drag alternative to {@link updateHeight}
   * for handheld AR, where device tilt is not the natural input.
   * No-op unless in the `'height'` step.
   */
  setHeight(heightMeters: number): void
  /**
   * Current elevation-driven height (metres above floor), or null
   * when not in the height step. Exposed for analytics/telemetry.
   */
  getHeight(): number | null
  /**
   * The frozen horizontal base position captured when the position
   * step was confirmed, or null if placement hasn't advanced. The
   * height step moves the globe vertically above this point.
   */
  getBasePosition(): THREE.Vector3 | null
  /**
   * Last successful reticle world position, or null if none. Used
   * during the position step to know where the reticle currently is.
   */
  getReticlePosition(): THREE.Vector3 | null
  /**
   * Final globe-centre position for the in-progress placement, or
   * null when there is no valid placement. Combines the frozen base
   * XZ with the elevation-driven height (height step) — or the
   * reticle position (position step, before height is chosen).
   *
   * The caller applies the surface-resting lift via
   * {@link liftedPlacementPosition} on finalise.
   */
  getPlacementPosition(): THREE.Vector3 | null
  /**
   * Latest XR hit-test result from the most recent successful
   * reticle frame, or null. Used by vrSession to create a
   * system-tracked anchor on placement — the anchor stays bolted
   * to the real surface across local-floor coord-system re-bases
   * (which happen every session on Quest), making the globe
   * actually stay put when the user exits and re-enters VR.
   */
  getLastHitTestResult(): XRHitTestResult | null
  /**
   * UV-space hit test on the Place button — analogous to vrHud's
   * hitTest. Returns 'place' if the UV falls inside the button,
   * null otherwise.
   */
  hitTestButton(uv: { x: number; y: number }): 'place' | null
  /** Release every GPU resource. Safe to call multiple times. */
  dispose(): void
}

/**
 * Draw the Place button canvas — a target / crosshair icon
 * inside a dark translucent disc with an accent border.
 */
function drawPlaceButton(ctx: CanvasRenderingContext2D, active: boolean): void {
  const w = PLACE_BUTTON_CANVAS_SIZE
  const h = PLACE_BUTTON_CANVAS_SIZE
  ctx.clearRect(0, 0, w, h)

  // Background disc
  ctx.fillStyle = active ? 'rgba(77, 166, 255, 0.85)' : 'rgba(13, 13, 18, 0.75)'
  ctx.beginPath()
  ctx.arc(w / 2, h / 2, w / 2 - 8, 0, Math.PI * 2)
  ctx.fill()

  // Accent ring border
  ctx.strokeStyle = active ? '#fff' : `rgba(77, 166, 255, 0.85)`
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.arc(w / 2, h / 2, w / 2 - 8, 0, Math.PI * 2)
  ctx.stroke()

  // Inner crosshair / target icon
  ctx.strokeStyle = active ? '#fff' : '#e8eaf0'
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  const center = w / 2
  const armLen = 36
  const innerGap = 12
  // Horizontal
  ctx.beginPath()
  ctx.moveTo(center - innerGap - armLen, center)
  ctx.lineTo(center - innerGap, center)
  ctx.moveTo(center + innerGap, center)
  ctx.lineTo(center + innerGap + armLen, center)
  ctx.stroke()
  // Vertical
  ctx.beginPath()
  ctx.moveTo(center, center - innerGap - armLen)
  ctx.lineTo(center, center - innerGap)
  ctx.moveTo(center, center + innerGap)
  ctx.lineTo(center, center + innerGap + armLen)
  ctx.stroke()
  // Center dot
  ctx.fillStyle = active ? '#fff' : '#e8eaf0'
  ctx.beginPath()
  ctx.arc(center, center, 6, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Whether the placement handle is backed by real-world geometry
 * (AR hit-test) or a virtual floor (VR gaze). The factory needs to
 * know so it can reveal the Place button only when a position
 * source actually exists: AR requires a hit-test source; VR always
 * has a gaze ray, so the button always shows.
 */
export type VrPlacementMode = 'ar' | 'vr'

export function createVrPlacement(
  THREE_: typeof THREE,
  mode: VrPlacementMode,
  hitTestSource: XRHitTestSource | null,
): VrPlacementHandle {
  // --- Reticle ---
  // Thin ring + center dot, lying flat on whatever surface the
  // hit-test resolves to. Lit additively so it pops against both
  // dark VR void and bright AR passthrough.
  const reticleGroup = new THREE_.Group()

  const ringGeometry = new THREE_.TorusGeometry(RETICLE_OUTER_RADIUS, RETICLE_TUBE, 8, 48)
  const ringMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  })
  const ring = new THREE_.Mesh(ringGeometry, ringMaterial)
  // Torus default plane is XY; rotate so it lies flat on XZ (floor).
  ring.rotation.x = -Math.PI / 2
  reticleGroup.add(ring)

  const centerGeometry = new THREE_.SphereGeometry(RETICLE_CENTER_RADIUS, 12, 12)
  const centerMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  })
  const center = new THREE_.Mesh(centerGeometry, centerMaterial)
  reticleGroup.add(center)

  reticleGroup.renderOrder = 11 // above HUD (10), below the laser dot (12)
  reticleGroup.visible = false

  // --- Place button ---
  // Floating disc with target/crosshair icon. Renders as a flat
  // billboard plane via CanvasTexture; vrInteraction raycasts it
  // alongside the HUD and globe.
  const placeCanvas = document.createElement('canvas')
  placeCanvas.width = PLACE_BUTTON_CANVAS_SIZE
  placeCanvas.height = PLACE_BUTTON_CANVAS_SIZE
  const placeCtxOrNull = placeCanvas.getContext('2d')
  if (!placeCtxOrNull) throw new Error('[VR placement] 2D canvas context unavailable')
  // Reassign to a non-nullable local so the closure below can use
  // it without the TypeScript narrowing being lost.
  const placeCtx: CanvasRenderingContext2D = placeCtxOrNull
  drawPlaceButton(placeCtx, false)

  const placeTexture = new THREE_.CanvasTexture(placeCanvas)
  placeTexture.colorSpace = THREE_.SRGBColorSpace
  placeTexture.minFilter = THREE_.LinearFilter
  placeTexture.magFilter = THREE_.LinearFilter

  const placeMaterial = new THREE_.MeshBasicMaterial({
    map: placeTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const placeGeometry = new THREE_.PlaneGeometry(PLACE_BUTTON_WIDTH, PLACE_BUTTON_HEIGHT)
  const placeButtonMesh = new THREE_.Mesh(placeGeometry, placeMaterial)
  placeButtonMesh.position.set(
    PLACE_BUTTON_POSITION.x,
    PLACE_BUTTON_POSITION.y,
    PLACE_BUTTON_POSITION.z,
  )
  placeButtonMesh.renderOrder = 10
  // Hidden by default — vrSession reveals it once it confirms
  // hit-test is supported on this session (AR) or always for VR.
  placeButtonMesh.visible = false

  // --- Height rail ---
  // Vertical line + slider marker shown during the height step so
  // the user has a visible target for "how high am I placing". The
  // rail is repositioned to the frozen base XZ each time the
  // position step is confirmed; only its marker moves per-frame.
  const railGroup = new THREE_.Group()

  const railGeom = new THREE_.CylinderGeometry(RAIL_TUBE, RAIL_TUBE, RAIL_HEIGHT, 8)
  const railMat = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.5,
    depthTest: false,
  })
  const railLine = new THREE_.Mesh(railGeom, railMat)
  // Cylinder is centred on its midpoint; shift so its base sits at
  // the group origin (the floor point under the chosen XZ).
  railLine.position.y = RAIL_HEIGHT / 2
  railGroup.add(railLine)

  const markerGeom = new THREE_.SphereGeometry(RAIL_MARKER_RADIUS, 16, 16)
  const markerMat = new THREE_.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  })
  const railMarker = new THREE_.Mesh(markerGeom, markerMat)
  railGroup.add(railMarker)

  railGroup.renderOrder = 11 // alongside the reticle
  railGroup.visible = false

  // --- State ---
  let placing = false
  /** Current placement sub-step. Resets to 'position' on setPlacing(true). */
  let step: VrPlacementStep = 'position'
  /**
   * Latest hit position from per-frame hit-test (AR) or gaze
   * projection (VR). Single allocated Vector3 reused each frame via
   * `.copy()` — previous version re-allocated with `scratch.clone()`
   * every frame during Place mode, which shows up as GC churn during
   * a long placement hold. `lastHitValid` tracks whether the stored
   * pose is current.
   */
  const lastHitPosition = new THREE_.Vector3()
  let lastHitValid = false
  /**
   * The raw XR hit-test result from the most recent frame. Kept so
   * vrSession can call `createAnchor()` on it at placement-confirm
   * time. Cleared when the reticle loses its surface. VR sessions
   * never populate this (no real geometry to anchor against).
   */
  let lastHitResult: XRHitTestResult | null = null
  /** Scratch vector for hit-test / gaze result extraction. */
  const scratch = new THREE_.Vector3()

  /**
   * Frozen horizontal base point captured when the position step is
   * confirmed. The height step moves the globe vertically above
   * this XZ. Null until the position step advances.
   */
  const basePosition = new THREE_.Vector3()
  let baseValid = false
  /**
   * Elevation-driven height (metres above floor) during the height
   * step. Null outside the height step. Read by getPlacementPosition
   * to combine with the frozen base XZ.
   */
  let heightValue: number | null = null

  function hidePositionVisuals(): void {
    reticleGroup.visible = false
    lastHitValid = false
    lastHitResult = null
  }

  function resetToPositionStep(): void {
    step = 'position'
    baseValid = false
    heightValue = null
    railGroup.visible = false
  }

  function refreshPlaceButtonAppearance(): void {
    drawPlaceButton(placeCtx, placing)
    placeTexture.needsUpdate = true
  }

  return {
    reticleGroup,
    railGroup,
    placeButtonMesh,

    isPlacing() {
      return placing
    },

    setPlacing(active) {
      if (placing === active) return
      placing = active
      refreshPlaceButtonAppearance()
      if (active) {
        // Entering Place mode always starts at the position step.
        resetToPositionStep()
        reticleGroup.visible = false
      } else {
        hidePositionVisuals()
        resetToPositionStep()
      }
    },

    getStep() {
      return step
    },

    advanceStep() {
      if (!placing) return
      if (step === 'position') {
        // Freeze the current reticle XZ as the placement base.
        const reticle = lastHitValid ? lastHitPosition : null
        if (!reticle) return // nothing aimed at yet; ignore the tap
        basePosition.copy(reticle)
        baseValid = true
        step = 'height'
        // Seed the height from the reticle's own Y so there's no
        // visible jump when the rail appears — the globe starts at
        // wherever the surface was, then the user adjusts.
        heightValue = Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, reticle.y))
        // Park the rail at the frozen base and show it.
        railGroup.position.set(basePosition.x, 0, basePosition.z)
        railMarker.position.y = heightValue
        railGroup.visible = true
        // Reticle is no longer the active affordance.
        hidePositionVisuals()
      }
      // From 'height' the caller reads getPlacementPosition and
      // finalises — no state transition here.
    },

    update(frame, refSpace) {
      // Only do hit-test work while in the position step — saves
      // the per-frame WebXR call otherwise. The height step is
      // driven by updateHeight instead.
      if (!placing || step !== 'position' || !hitTestSource) {
        if (reticleGroup.visible) reticleGroup.visible = false
        return
      }
      const hits = frame.getHitTestResults(hitTestSource)
      if (hits.length === 0) {
        // Lost the surface — keep reticle hidden, lastHitPosition
        // stays null so a confirm tap won't place spuriously.
        hidePositionVisuals()
        return
      }
      const pose = hits[0].getPose(refSpace)
      if (!pose) {
        hidePositionVisuals()
        return
      }
      // Keep the raw hit-test result around — vrSession will call
      // `createAnchor()` on it at placement-confirm time.
      lastHitResult = hits[0]
      scratch.set(
        pose.transform.position.x,
        pose.transform.position.y,
        pose.transform.position.z,
      )
      reticleGroup.position.copy(scratch)
      reticleGroup.visible = true
      // Reuse the same Vector3 instead of cloning every frame.
      lastHitPosition.copy(scratch)
      lastHitValid = true
    },

    updateGaze(cameraOrigin, cameraForward) {
      if (!placing || step !== 'position') {
        if (reticleGroup.visible) reticleGroup.visible = false
        return
      }
      const hit = rayPlaneXZ(cameraOrigin, cameraForward, VR_GAZE_FLOOR_Y)
      if (!hit) {
        // Looking up/level — no floor crossing ahead.
        hidePositionVisuals()
        return
      }
      scratch.set(hit.x, VR_GAZE_FLOOR_Y, hit.z)
      reticleGroup.position.copy(scratch)
      reticleGroup.visible = true
      lastHitPosition.copy(scratch)
      lastHitValid = true
      // VR gaze has no XR hit-test result, so lastHitResult stays
      // null — vrSession's anchor path is AR-only already.
    },

    updateHeight(elevationRad) {
      if (!placing || step !== 'height' || heightValue === null) return
      heightValue = elevationToHeight(elevationRad)
      railMarker.position.y = heightValue
    },

    setHeight(heightMeters) {
      if (!placing || step !== 'height' || heightValue === null) return
      heightValue = Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, heightMeters))
      railMarker.position.y = heightValue
    },

    getHeight() {
      return heightValue
    },

    getBasePosition() {
      return baseValid ? basePosition.clone() : null
    },

    getReticlePosition() {
      // Clone here (not per-frame) so callers can safely store the
      // returned Vector3 without worrying about us mutating it the
      // next frame. Called once per placement-confirm tap — cheap.
      return lastHitValid ? lastHitPosition.clone() : null
    },

    getPlacementPosition() {
      if (!placing) return null
      if (step === 'height' && baseValid && heightValue !== null) {
        return new THREE_.Vector3(basePosition.x, heightValue, basePosition.z)
      }
      // Position step (or height step with no height set yet):
      // fall back to the live reticle so a hasty confirm still lands
      // somewhere sensible.
      return lastHitValid ? lastHitPosition.clone() : null
    },

    getLastHitTestResult() {
      return lastHitResult
    },

    hitTestButton(uv) {
      if (!placeButtonMesh.visible) return null
      // Inside the disc — UV in the unit square, treat as inside if
      // we're roughly within the visible disc region (no fancy
      // circular hit-test; full square is fine for a button this
      // small).
      if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null
      return 'place'
    },

    dispose() {
      ringGeometry.dispose()
      ringMaterial.dispose()
      centerGeometry.dispose()
      centerMaterial.dispose()
      placeGeometry.dispose()
      placeMaterial.dispose()
      placeTexture.dispose()
      railGeom.dispose()
      railMat.dispose()
      markerGeom.dispose()
      markerMat.dispose()
    },
  }
}

/**
 * Compute the world position the globe should occupy when placed at
 * a hit-test point. The hit point is ON the surface; lifting by
 * `PLACE_LIFT_Y * scale` puts the globe's centre above the surface
 * so the visible bottom rests on top — the multiplication by scale
 * is critical because the globe is user-zoomable and a constant
 * lift would leave a zoomed-up globe floating above the surface
 * (or a zoomed-down globe sunken into it).
 *
 * Accepts any object with {x, y, z} numeric fields — lets callers
 * pass either a `THREE.Vector3` (placement-confirm callback) or a
 * `DOMPointReadOnly` direct from `anchorPose.transform.position`
 * (per-frame anchor sync) without conversion.
 *
 * @param scale Current uniform globe scale (e.g. `globe.scale.x`).
 *   Used to scale the lift so the visible bottom stays on the
 *   surface at any zoom level.
 * @param out Optional target to write into. Hot paths (per-frame
 *   anchor pose sync) pass the globe's own position vector to
 *   avoid allocation; one-shot paths can omit and get a new one.
 */
export function liftedPlacementPosition(
  THREE_: typeof THREE,
  hitPosition: { x: number; y: number; z: number },
  scale: number,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const target = out ?? new THREE_.Vector3()
  target.set(hitPosition.x, hitPosition.y + PLACE_LIFT_Y * scale, hitPosition.z)
  return target
}
