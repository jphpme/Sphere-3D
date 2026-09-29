// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * 3D translation of the 2D loading screen (`src/styles/loading.css`).
 *
 * Faithful to the 2D visual language: the AYNI XR mark beating like a
 * heart over a soft green glow (AYNI icon package, 2026-09-29 — it
 * replaced a pulsing blue sphere and two spinning rings), the "AYNI XR"
 * wordmark + subtitle, thin progress bar, status text. Replaces the 2D
 * HTML loading screen with a spatial version while the WebXR session is
 * starting up and the dataset texture is decoding.
 *
 * Visible from the moment `vrSession.enterVr()` builds the scene
 * until the dataset texture has a decoded frame. Then fades out via
 * `fadeOut()` and the real globe takes over the same anchor point.
 *
 * See {@link file://./../../docs/VR_INVESTIGATION_PLAN.md VR_INVESTIGATION_PLAN.md}
 * Phase 2 — visual polish, loading gate.
 */

import type * as THREE from 'three'
import { getLocale, t } from '../i18n'

/** Anchor in local-floor space — same spot the globe will occupy when ready. */
const LOADING_POSITION = { x: 0, y: 1.3, z: -1.5 }

// --- Geometry sizes (metres). Sized to feel "small but inviting" — not
//     dominating the user's view. Roughly matches the 2D version's
//     88 px mark.
const MARK_SIZE = 0.12
const GLOW_SIZE = 0.22
const MARK_CANVAS_SIZE = 512
const MARK_URL = '/ayni-xr-mark.svg'

// --- Colours pulled from src/styles/tokens.css.
const ACCENT_COLOR = 0x22c55e // --color-accent
const BRAND_START = '#22c55e' // --color-brand-start
const BRAND_END = '#facc15' // --color-brand-end
const TEXT_COLOR = '#e8eaf0' // --color-text
const TEXT_MUTED = '#999' // --color-text-muted

/** One heartbeat, in seconds — the same as `ayni-heartbeat` in loading.css. */
export const HEARTBEAT_PERIOD_S = 1.4

/**
 * The mark's scale through a heartbeat: two quick beats, then a rest.
 * Mirrors the `ayni-heartbeat` keyframes (1 → 1.12 → 1 → 1.07 → 1 by
 * 60 %, still until the next beat); eased between the keyframes so the
 * canvas and the CSS read as one motion.
 */
export function heartbeatScale(tSeconds: number): number {
  const p = ((tSeconds % HEARTBEAT_PERIOD_S) + HEARTBEAT_PERIOD_S) % HEARTBEAT_PERIOD_S / HEARTBEAT_PERIOD_S
  const keys: ReadonlyArray<readonly [number, number]> = [[0, 1], [0.14, 1.12], [0.28, 1], [0.42, 1.07], [0.6, 1], [1, 1]]
  for (let i = 1; i < keys.length; i++) {
    const [p1, s1] = keys[i]!
    if (p <= p1) {
      const [p0, s0] = keys[i - 1]!
      const f = (p - p0) / (p1 - p0)
      const eased = f * f * (3 - 2 * f) // smoothstep, like ease-in-out
      return s0 + (s1 - s0) * eased
    }
  }
  return 1
}

// --- Title / subtitle / progress / status panel sizes.
const TITLE_PANEL_WIDTH = 0.18 // 18 cm
const TITLE_PANEL_HEIGHT = 0.045
const TITLE_CANVAS_WIDTH = 768
const TITLE_CANVAS_HEIGHT = 192
const TITLE_OFFSET_Y = -0.11

const PROGRESS_WIDTH = 0.13
const PROGRESS_HEIGHT = 0.0015
const PROGRESS_OFFSET_Y = -0.155

const STATUS_PANEL_WIDTH = 0.18
const STATUS_PANEL_HEIGHT = 0.025
const STATUS_CANVAS_WIDTH = 768
const STATUS_CANVAS_HEIGHT = 96
const STATUS_OFFSET_Y = -0.18

const FADE_DURATION_MS = 800 // matches 2D's `transition: opacity 0.8s ease`

export interface VrLoadingHandle {
  /** Three.js group to add to the scene. */
  readonly group: THREE.Group
  /** Update progress (0-1) and optionally the status text. */
  setProgress(progress: number, status?: string): void
  /** Per-frame animation update — call from the session render loop. */
  update(deltaSeconds: number): void
  /**
   * Begin a fade-out animation; resolves when complete. Caller
   * typically removes + disposes the group right after.
   */
  fadeOut(): Promise<void>
  /**
   * True once a fade-out has run to completion. A synchronous read the
   * render loop can poll on the same frame the fade finishes, so the
   * handover does not depend on a promise continuation being scheduled.
   */
  isFadedOut(): boolean
  /** Release every GPU resource. Safe to call multiple times. */
  dispose(): void
}

/**
 * Draw the title canvas. The "AYNI XR" wordmark + Pachamama Studios
 * subtitle in accent, mirroring the 2D headings.
 */
function drawTitle(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, TITLE_CANVAS_WIDTH, TITLE_CANVAS_HEIGHT)
  ctx.fillStyle = TEXT_COLOR
  ctx.font = '300 88px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Letter-spacing isn't a Canvas2D property — fake it by drawing
  // each letter with a fixed advance. Matches 2D's letter-spacing: 0.25em.
  const titleText = 'AYNI'
  const letterSpacingPx = 12
  const letterWidth = ctx.measureText('M').width // approx em width
  const ayniWidth = titleText.length * (letterWidth * 0.55 + letterSpacingPx)
  // "XR" as in the wordmark: heavier, 1.33x, in the brand gradient.
  const xrFont = '800 104px system-ui, -apple-system, sans-serif'
  ctx.font = xrFont
  const xrWidth = ctx.measureText('XR').width
  const gap = 20
  let x = TITLE_CANVAS_WIDTH / 2 - (ayniWidth + gap + xrWidth) / 2
  ctx.font = '300 88px system-ui, -apple-system, sans-serif'
  for (const ch of titleText) {
    ctx.fillText(ch, x + (letterWidth * 0.55) / 2, TITLE_CANVAS_HEIGHT / 2 - 8)
    x += letterWidth * 0.55 + letterSpacingPx
  }
  x += gap
  ctx.font = xrFont
  ctx.textAlign = 'left'
  const gradient = ctx.createLinearGradient(x, 0, x + xrWidth, 0)
  gradient.addColorStop(0, BRAND_START)
  gradient.addColorStop(1, BRAND_END)
  ctx.fillStyle = gradient
  ctx.fillText('XR', x, TITLE_CANVAS_HEIGHT / 2 - 10)
  ctx.textAlign = 'center'

  // Subtitle in accent. The 2D version applies `text-transform:
  // uppercase` to the same `loading.subtitle` key; canvas can't
  // do CSS so we uppercase via `toLocaleUpperCase(getLocale())`.
  // Passing the i18n active locale explicitly (rather than letting
  // the call default to the host environment's locale) is what
  // gets the Turkish dotted/dotless-I case right when the user has
  // picked a locale that differs from the browser default. Scripts
  // without case (Arabic, CJK, etc.) pass through unchanged.
  ctx.fillStyle = '#22c55e'
  ctx.font = '500 32px system-ui, -apple-system, sans-serif'
  ctx.fillText(
    t('loading.subtitle').toLocaleUpperCase(getLocale()),
    TITLE_CANVAS_WIDTH / 2,
    TITLE_CANVAS_HEIGHT / 2 + 64,
  )
}

/** Draw the status text canvas. */
function drawStatus(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.clearRect(0, 0, STATUS_CANVAS_WIDTH, STATUS_CANVAS_HEIGHT)
  ctx.fillStyle = TEXT_MUTED
  ctx.font = '400 36px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, STATUS_CANVAS_WIDTH / 2, STATUS_CANVAS_HEIGHT / 2)
}

export function createVrLoading(THREE_: typeof THREE): VrLoadingHandle {
  const group = new THREE_.Group()
  group.position.set(LOADING_POSITION.x, LOADING_POSITION.y, LOADING_POSITION.z)

  // Track materials we need to fade out — collected as we build them.
  const fadeMaterials: THREE.Material[] = []

  // --- Glow behind the mark: a soft green disc that swells with each beat ---
  const glowCanvas = document.createElement('canvas')
  glowCanvas.width = glowCanvas.height = 256
  const glowCtx = glowCanvas.getContext('2d')
  if (!glowCtx) throw new Error('[VR loading] 2D canvas context unavailable')
  const glowGradient = glowCtx.createRadialGradient(128, 128, 0, 128, 128, 128)
  glowGradient.addColorStop(0, 'rgba(34, 197, 94, 0.55)')
  glowGradient.addColorStop(0.45, 'rgba(34, 197, 94, 0.18)')
  glowGradient.addColorStop(1, 'rgba(34, 197, 94, 0)')
  glowCtx.fillStyle = glowGradient
  glowCtx.fillRect(0, 0, 256, 256)
  const glowTexture = new THREE_.CanvasTexture(glowCanvas)
  glowTexture.colorSpace = THREE_.SRGBColorSpace
  const glowMaterial = new THREE_.MeshBasicMaterial({
    map: glowTexture,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  })
  const glowGeometry = new THREE_.PlaneGeometry(GLOW_SIZE, GLOW_SIZE)
  const glow = new THREE_.Mesh(glowGeometry, glowMaterial)
  glow.position.z = -0.002
  group.add(glow)
  fadeMaterials.push(glowMaterial)

  // --- The AYNI XR mark ---
  // Drawn into a canvas once the SVG decodes (a few ms, from the same
  // origin); until then the plane is clear rather than a placeholder.
  const markCanvas = document.createElement('canvas')
  markCanvas.width = markCanvas.height = MARK_CANVAS_SIZE
  const markCtx = markCanvas.getContext('2d')
  if (!markCtx) throw new Error('[VR loading] 2D canvas context unavailable')
  const markTexture = new THREE_.CanvasTexture(markCanvas)
  markTexture.colorSpace = THREE_.SRGBColorSpace
  markTexture.minFilter = THREE_.LinearFilter
  markTexture.magFilter = THREE_.LinearFilter
  const markImage = new Image()
  markImage.decoding = 'async'
  markImage.onload = () => {
    markCtx.clearRect(0, 0, MARK_CANVAS_SIZE, MARK_CANVAS_SIZE)
    markCtx.drawImage(markImage, 0, 0, MARK_CANVAS_SIZE, MARK_CANVAS_SIZE)
    markTexture.needsUpdate = true
  }
  markImage.src = MARK_URL
  const markMaterial = new THREE_.MeshBasicMaterial({
    map: markTexture,
    transparent: true,
    depthWrite: false,
  })
  const markGeometry = new THREE_.PlaneGeometry(MARK_SIZE, MARK_SIZE)
  const mark = new THREE_.Mesh(markGeometry, markMaterial)
  mark.renderOrder = 4
  group.add(mark)
  fadeMaterials.push(markMaterial)

  // A visitor who asked for less motion gets a still mark.
  const reduceMotion = typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // --- Title + subtitle panel ---
  const titleCanvas = document.createElement('canvas')
  titleCanvas.width = TITLE_CANVAS_WIDTH
  titleCanvas.height = TITLE_CANVAS_HEIGHT
  const titleCtx = titleCanvas.getContext('2d')
  if (!titleCtx) throw new Error('[VR loading] 2D canvas context unavailable')
  drawTitle(titleCtx)

  const titleTexture = new THREE_.CanvasTexture(titleCanvas)
  titleTexture.colorSpace = THREE_.SRGBColorSpace
  titleTexture.minFilter = THREE_.LinearFilter
  titleTexture.magFilter = THREE_.LinearFilter

  const titleMaterial = new THREE_.MeshBasicMaterial({
    map: titleTexture,
    transparent: true,
    depthTest: false,
  })
  const titlePlane = new THREE_.Mesh(
    new THREE_.PlaneGeometry(TITLE_PANEL_WIDTH, TITLE_PANEL_HEIGHT),
    titleMaterial,
  )
  titlePlane.position.y = TITLE_OFFSET_Y
  titlePlane.renderOrder = 5
  group.add(titlePlane)
  fadeMaterials.push(titleMaterial)

  // --- Progress bar — track + fill, both as plane meshes ---
  const trackGeometry = new THREE_.PlaneGeometry(PROGRESS_WIDTH, PROGRESS_HEIGHT)
  const trackMaterial = new THREE_.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.08,
    depthTest: false,
  })
  const track = new THREE_.Mesh(trackGeometry, trackMaterial)
  track.position.y = PROGRESS_OFFSET_Y
  track.renderOrder = 5
  group.add(track)
  fadeMaterials.push(trackMaterial)

  // Fill mesh: same geometry, scaled X by progress. Pivot anchored at
  // the left edge by translating the geometry once at construction
  // time (so scale.x = 0..1 grows from the left).
  const fillGeometry = new THREE_.PlaneGeometry(PROGRESS_WIDTH, PROGRESS_HEIGHT)
  fillGeometry.translate(PROGRESS_WIDTH / 2, 0, 0)
  const fillMaterial = new THREE_.MeshBasicMaterial({
    color: ACCENT_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  })
  const fill = new THREE_.Mesh(fillGeometry, fillMaterial)
  // Position the left edge at -PROGRESS_WIDTH/2 in world (matches track).
  fill.position.x = -PROGRESS_WIDTH / 2
  fill.position.y = PROGRESS_OFFSET_Y
  fill.position.z = 0.0001 // slightly in front of track to avoid z-fight
  fill.scale.x = 0
  fill.renderOrder = 6
  group.add(fill)
  fadeMaterials.push(fillMaterial)

  // --- Status text panel ---
  const statusCanvas = document.createElement('canvas')
  statusCanvas.width = STATUS_CANVAS_WIDTH
  statusCanvas.height = STATUS_CANVAS_HEIGHT
  const statusCtx = statusCanvas.getContext('2d')
  if (!statusCtx) throw new Error('[VR loading] 2D canvas context unavailable')
  drawStatus(statusCtx, 'Initializing\u2026')

  const statusTexture = new THREE_.CanvasTexture(statusCanvas)
  statusTexture.colorSpace = THREE_.SRGBColorSpace
  statusTexture.minFilter = THREE_.LinearFilter
  statusTexture.magFilter = THREE_.LinearFilter

  const statusMaterial = new THREE_.MeshBasicMaterial({
    map: statusTexture,
    transparent: true,
    depthTest: false,
  })
  const statusPlane = new THREE_.Mesh(
    new THREE_.PlaneGeometry(STATUS_PANEL_WIDTH, STATUS_PANEL_HEIGHT),
    statusMaterial,
  )
  statusPlane.position.y = STATUS_OFFSET_Y
  statusPlane.renderOrder = 5
  group.add(statusPlane)
  fadeMaterials.push(statusMaterial)

  // --- Animation state ---
  let elapsedSeconds = 0
  /** Target progress (0-1). Animated toward by `displayedProgress`. */
  let targetProgress = 0
  /** What's currently shown on the bar — eased toward target each frame. */
  let displayedProgress = 0
  let lastStatus = 'Initializing\u2026'

  /** Active fade tween, if any. */
  let fadedOut = false
  let fadeStart: number | null = null
  let fadePromise: { resolve: () => void } | null = null

  return {
    group,

    setProgress(progress, status) {
      targetProgress = Math.max(0, Math.min(1, progress))
      if (status !== undefined && status !== lastStatus) {
        lastStatus = status
        drawStatus(statusCtx, status)
        statusTexture.needsUpdate = true
      }
    },

    update(deltaSeconds) {
      elapsedSeconds += deltaSeconds

      // The mark's heartbeat, and the glow swelling with it.
      if (!reduceMotion) {
        const beat = heartbeatScale(elapsedSeconds)
        mark.scale.setScalar(beat)
        glow.scale.setScalar(0.9 + (beat - 1) * 3)
        if (fadeStart === null) glowMaterial.opacity = 0.35 + (beat - 1) * 3
      }

      // Smoothly ease displayed progress toward target.
      // Frame-rate independent lerp via 1 - exp(-rate * dt).
      const easeRate = 6 // higher = snappier
      displayedProgress += (targetProgress - displayedProgress) *
        (1 - Math.exp(-easeRate * deltaSeconds))
      fill.scale.x = Math.max(0.0001, displayedProgress)

      // Fade-out animation.
      if (fadeStart !== null) {
        const fadeProgress = (elapsedSeconds * 1000 - fadeStart) / FADE_DURATION_MS
        const opacity = Math.max(0, 1 - fadeProgress)
        // Apply opacity uniformly to everything that's transparent.
        for (const mat of fadeMaterials) {
          // Scale base opacities so initial differences (e.g. inner ring
          // is 0.55) are preserved through the fade.
          const baseOpacity = mat.userData.baseOpacity ?? mat.opacity
          if (mat.userData.baseOpacity === undefined) {
            mat.userData.baseOpacity = baseOpacity
          }
          mat.opacity = (mat.userData.baseOpacity as number) * opacity
        }
        if (fadeProgress >= 1) {
          fadeStart = null
          group.visible = false
          fadedOut = true
          fadePromise?.resolve()
          fadePromise = null
        }
      }
    },

    isFadedOut() {
      return fadedOut
    },

    fadeOut() {
      return new Promise<void>(resolve => {
        if (fadeStart !== null) {
          // Already fading — just chain.
          const prev = fadePromise?.resolve
          fadePromise = {
            resolve: () => { prev?.(); resolve() },
          }
          return
        }
        fadeStart = elapsedSeconds * 1000
        fadePromise = { resolve }
      })
    },

    dispose() {
      markImage.onload = null
      markGeometry.dispose()
      markMaterial.dispose()
      markTexture.dispose()
      glowGeometry.dispose()
      glowMaterial.dispose()
      glowTexture.dispose()
      titleTexture.dispose()
      titleMaterial.dispose()
      ;(titlePlane.geometry as THREE.BufferGeometry).dispose()
      trackGeometry.dispose()
      trackMaterial.dispose()
      fillGeometry.dispose()
      fillMaterial.dispose()
      statusTexture.dispose()
      statusMaterial.dispose()
      ;(statusPlane.geometry as THREE.BufferGeometry).dispose()
    },
  }
}
