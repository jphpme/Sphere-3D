/**
 * Floating in-VR/AR HUD rendered as a CanvasTexture.
 *
 * Layout:
 *   row 1: single-line dataset title
 *   row 2: playback controls, progress, elapsed/total, mute, catalog, close
 */

import type * as THREE from 'three'
import type { ChatVoiceStatus } from '../ui/chatUI'

const HUD_WIDTH = 0.9
const HUD_HEIGHT = 0.22
const HUD_POSITION = { x: 0, y: 1.0, z: -1.0 }

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 320

const TOP_ROW_HEIGHT = 118
const BOTTOM_ROW_TOP = TOP_ROW_HEIGHT
const BOTTOM_ROW_HEIGHT = CANVAS_HEIGHT - TOP_ROW_HEIGHT

const PANEL_BG = 'rgba(13, 13, 18, 0.86)'
const BORDER = 'rgba(255, 255, 255, 0.12)'
const TEXT = '#e8eaf0'
const MUTED = 'rgba(232, 234, 240, 0.54)'
const ACCENT = 'rgba(77, 166, 255, 0.94)'
const TRACK = 'rgba(255, 255, 255, 0.14)'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const RECTS = {
  playPause: { x: 38, y: 166, w: 58, h: 58 },
  stop: { x: 112, y: 166, w: 58, h: 58 },
  progress: { x: 192, y: 187, w: 500, h: 16 },
  voice: { x: 880, y: 166, w: 58, h: 58 },
  mute: { x: 970, y: 166, w: 58, h: 58 },
  browse: { x: 1060, y: 166, w: 58, h: 58 },
  exit: { x: 1150, y: 166, w: 58, h: 58 },
} as const satisfies Record<string, Rect>

export type VrHudAction =
  | { kind: 'play-pause' }
  | { kind: 'stop' }
  | { kind: 'seek'; fraction: number }
  | { kind: 'voice' }
  | { kind: 'mute' }
  | { kind: 'browse' }
  | { kind: 'exit-vr' }

export interface VrHudState {
  datasetTitle: string | null
  isPlaying: boolean
  hasVideo: boolean
  isMuted: boolean
  currentTime: number
  duration: number
  panelCount: number
  primaryIndex: number
  browseOpen: boolean
  voiceStatus: ChatVoiceStatus
  voiceTranscript: string
}

export interface VrHudHandle {
  readonly mesh: THREE.Mesh
  setState(state: VrHudState): void
  hitTest(uv: { x: number; y: number }): VrHudAction | null
  dispose(): void
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, w, h)
  }
}

function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.stroke()
  } else {
    ctx.strokeRect(x, y, w, h)
  }
}

function drawButtonBackplate(ctx: CanvasRenderingContext2D, rect: Rect, active = false): void {
  ctx.fillStyle = active ? 'rgba(77, 166, 255, 0.18)' : 'rgba(255, 255, 255, 0.07)'
  fillRoundRect(ctx, rect.x, rect.y, rect.w, rect.h, 12)
  ctx.strokeStyle = active ? 'rgba(77, 166, 255, 0.42)' : 'rgba(255, 255, 255, 0.10)'
  ctx.lineWidth = 2
  strokeRoundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 12)
}

function drawPlayPause(ctx: CanvasRenderingContext2D, rect: Rect, isPlaying: boolean, enabled: boolean): void {
  drawButtonBackplate(ctx, rect)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  ctx.fillStyle = enabled ? ACCENT : MUTED
  if (isPlaying) {
    ctx.fillRect(cx - 12, cy - 18, 9, 36)
    ctx.fillRect(cx + 3, cy - 18, 9, 36)
  } else {
    ctx.beginPath()
    ctx.moveTo(cx - 12, cy - 18)
    ctx.lineTo(cx - 12, cy + 18)
    ctx.lineTo(cx + 18, cy)
    ctx.closePath()
    ctx.fill()
  }
}

function drawStop(ctx: CanvasRenderingContext2D, rect: Rect, enabled: boolean): void {
  drawButtonBackplate(ctx, rect)
  ctx.fillStyle = enabled ? TEXT : MUTED
  const size = 26
  ctx.fillRect(rect.x + rect.w / 2 - size / 2, rect.y + rect.h / 2 - size / 2, size, size)
}

function drawSpeaker(ctx: CanvasRenderingContext2D, rect: Rect, muted: boolean, enabled: boolean): void {
  drawButtonBackplate(ctx, rect)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  ctx.fillStyle = !enabled || muted ? MUTED : ACCENT
  ctx.beginPath()
  ctx.moveTo(cx - 22, cy - 10)
  ctx.lineTo(cx - 10, cy - 10)
  ctx.lineTo(cx + 8, cy - 23)
  ctx.lineTo(cx + 8, cy + 23)
  ctx.lineTo(cx - 10, cy + 10)
  ctx.lineTo(cx - 22, cy + 10)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = !enabled || muted ? MUTED : ACCENT
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  if (muted || !enabled) {
    ctx.beginPath()
    ctx.moveTo(cx - 22, cy - 24)
    ctx.lineTo(cx + 24, cy + 24)
    ctx.stroke()
  } else {
    for (const radius of [17, 28]) {
      ctx.beginPath()
      ctx.arc(cx + 10, cy, radius, -Math.PI / 4, Math.PI / 4)
      ctx.stroke()
    }
  }
}

function drawVoice(ctx: CanvasRenderingContext2D, rect: Rect, status: ChatVoiceStatus): void {
  const enabled = status !== 'unsupported'
  drawButtonBackplate(ctx, rect, status === 'listening')
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  ctx.strokeStyle = !enabled
    ? MUTED
    : status === 'listening'
      ? '#ff8a8a'
      : status === 'thinking'
        ? ACCENT
        : TEXT
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.roundRect(cx - 9, cy - 24, 18, 34, 9)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx - 22, cy - 4)
  ctx.quadraticCurveTo(cx - 22, cy + 22, cx, cy + 22)
  ctx.quadraticCurveTo(cx + 22, cy + 22, cx + 22, cy - 4)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx, cy + 22)
  ctx.lineTo(cx, cy + 30)
  ctx.stroke()
  if (!enabled) {
    ctx.beginPath()
    ctx.moveTo(cx - 24, cy - 24)
    ctx.lineTo(cx + 24, cy + 24)
    ctx.stroke()
  }
}

function drawBrowse(ctx: CanvasRenderingContext2D, rect: Rect, active: boolean): void {
  drawButtonBackplate(ctx, rect, active)
  ctx.fillStyle = active ? ACCENT : TEXT
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  for (const y of [cy - 15, cy, cy + 15]) {
    fillRoundRect(ctx, cx - 19, y - 3, 38, 6, 3)
  }
}

function drawExit(ctx: CanvasRenderingContext2D, rect: Rect): void {
  drawButtonBackplate(ctx, rect)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  ctx.strokeStyle = TEXT
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx - 17, cy - 17)
  ctx.lineTo(cx + 17, cy + 17)
  ctx.moveTo(cx + 17, cy - 17)
  ctx.lineTo(cx - 17, cy + 17)
  ctx.stroke()
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const whole = Math.floor(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function drawProgress(ctx: CanvasRenderingContext2D, state: VrHudState): void {
  const rect = RECTS.progress
  const enabled = state.hasVideo && Number.isFinite(state.duration) && state.duration > 0
  const fraction = enabled ? clamp01(state.currentTime / state.duration) : 0
  const y = rect.y + rect.h / 2

  ctx.strokeStyle = enabled ? TRACK : 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = rect.h
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(rect.x, y)
  ctx.lineTo(rect.x + rect.w, y)
  ctx.stroke()

  if (enabled) {
    ctx.strokeStyle = ACCENT
    ctx.beginPath()
    ctx.moveTo(rect.x, y)
    ctx.lineTo(rect.x + rect.w * fraction, y)
    ctx.stroke()

    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(rect.x + rect.w * fraction, y, 13, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.fillStyle = enabled ? TEXT : MUTED
  ctx.font = '500 24px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(
    `${formatClock(state.currentTime)} / ${formatClock(state.duration)}`,
    rect.x + rect.w + 28,
    y,
  )
}

function voiceLabel(status: ChatVoiceStatus): string {
  if (status === 'unsupported') return 'Voice unavailable'
  if (status === 'listening') return 'Listening...'
  if (status === 'transcribing') return 'Transcribing...'
  if (status === 'thinking') return 'Thinking...'
  return ''
}

function drawVoiceStatus(ctx: CanvasRenderingContext2D, state: VrHudState): void {
  const label = voiceLabel(state.voiceStatus)
  if (!label && !state.voiceTranscript) return
  const text = state.voiceTranscript || label
  ctx.font = '500 24px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = state.voiceStatus === 'listening' ? '#ffb0b0' : 'rgba(232, 234, 240, 0.72)'
  let line = text
  const maxWidth = 480
  while (ctx.measureText(line).width > maxWidth && line.length > 5) {
    line = `${line.slice(0, -2)}...`
  }
  ctx.fillText(line, CANVAS_WIDTH / 2, TOP_ROW_HEIGHT - 24)
}

function drawPanelDots(ctx: CanvasRenderingContext2D, state: VrHudState): void {
  if (state.panelCount <= 1) return
  const dotRadius = 6
  const spacing = 24
  const totalWidth = (state.panelCount - 1) * spacing
  const startX = CANVAS_WIDTH / 2 - totalWidth / 2
  const y = 24
  for (let i = 0; i < state.panelCount; i++) {
    ctx.beginPath()
    ctx.arc(startX + i * spacing, y, dotRadius, 0, Math.PI * 2)
    ctx.fillStyle = i === state.primaryIndex ? ACCENT : 'rgba(232, 234, 240, 0.35)'
    ctx.fill()
  }
}

function drawCanvas(ctx: CanvasRenderingContext2D, state: VrHudState): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = PANEL_BG
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)

  ctx.strokeStyle = BORDER
  ctx.beginPath()
  ctx.moveTo(0, TOP_ROW_HEIGHT)
  ctx.lineTo(w, TOP_ROW_HEIGHT)
  ctx.stroke()

  drawPanelDots(ctx, state)
  drawVoiceStatus(ctx, state)

  const titleText = state.datasetTitle || 'Load a dataset in 2D view first'
  ctx.fillStyle = TEXT
  ctx.font = '600 44px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let title = titleText
  const maxTitleWidth = w - 120
  while (ctx.measureText(title).width > maxTitleWidth && title.length > 5) {
    title = `${title.slice(0, -2)}...`
  }
  ctx.fillText(title, w / 2, TOP_ROW_HEIGHT / 2 + 8)

  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)'
  ctx.fillRect(0, BOTTOM_ROW_TOP, w, BOTTOM_ROW_HEIGHT)

  drawPlayPause(ctx, RECTS.playPause, state.isPlaying, state.hasVideo)
  drawStop(ctx, RECTS.stop, state.hasVideo)
  drawProgress(ctx, state)
  drawVoice(ctx, RECTS.voice, state.voiceStatus)
  drawSpeaker(ctx, RECTS.mute, state.isMuted, state.hasVideo)
  drawBrowse(ctx, RECTS.browse, state.browseOpen)
  drawExit(ctx, RECTS.exit)
}

function hitRect(px: number, py: number, rect: Rect): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h
}

export function createVrHud(THREE_: typeof THREE): VrHudHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('[VR HUD] 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  texture.minFilter = THREE_.LinearFilter
  texture.magFilter = THREE_.LinearFilter

  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const geometry = new THREE_.PlaneGeometry(HUD_WIDTH, HUD_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.position.set(HUD_POSITION.x, HUD_POSITION.y, HUD_POSITION.z)
  mesh.renderOrder = 10

  let currentState: VrHudState = {
    datasetTitle: null,
    isPlaying: false,
    hasVideo: false,
    isMuted: true,
    currentTime: 0,
    duration: 0,
    panelCount: 1,
    primaryIndex: 0,
    browseOpen: false,
    voiceStatus: 'idle',
    voiceTranscript: '',
  }

  function redraw(): void {
    drawCanvas(ctx2d!, currentState)
    texture.needsUpdate = true
  }

  redraw()

  return {
    mesh,

    setState(state) {
      const changed =
        state.datasetTitle !== currentState.datasetTitle ||
        state.isPlaying !== currentState.isPlaying ||
        state.hasVideo !== currentState.hasVideo ||
        state.isMuted !== currentState.isMuted ||
        Math.abs(state.currentTime - currentState.currentTime) >= 0.25 ||
        state.duration !== currentState.duration ||
        state.panelCount !== currentState.panelCount ||
        state.primaryIndex !== currentState.primaryIndex ||
        state.browseOpen !== currentState.browseOpen ||
        state.voiceStatus !== currentState.voiceStatus ||
        state.voiceTranscript !== currentState.voiceTranscript
      if (!changed) return
      currentState = state
      redraw()
    },

    hitTest(uv) {
      const px = uv.x * CANVAS_WIDTH
      const py = (1 - uv.y) * CANVAS_HEIGHT
      if (py < BOTTOM_ROW_TOP || py > CANVAS_HEIGHT) return null

      if (currentState.hasVideo && hitRect(px, py, RECTS.playPause)) return { kind: 'play-pause' }
      if (currentState.hasVideo && hitRect(px, py, RECTS.stop)) return { kind: 'stop' }
      if (currentState.hasVideo && hitRect(px, py, RECTS.progress)) {
        return { kind: 'seek', fraction: clamp01((px - RECTS.progress.x) / RECTS.progress.w) }
      }
      if (currentState.voiceStatus !== 'unsupported' && hitRect(px, py, RECTS.voice)) return { kind: 'voice' }
      if (currentState.hasVideo && hitRect(px, py, RECTS.mute)) return { kind: 'mute' }
      if (hitRect(px, py, RECTS.browse)) return { kind: 'browse' }
      if (hitRect(px, py, RECTS.exit)) return { kind: 'exit-vr' }
      return null
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
