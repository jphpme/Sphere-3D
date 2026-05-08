/**
 * AR-only floating legend/colorbar panel.
 *
 * DOM overlays are not visible inside immersive WebXR, so dataset
 * legends need to be rendered as scene geometry. This panel mirrors
 * the current primary dataset's `legendLink` as a canvas texture on a
 * small billboarded plane near the globe.
 */

import type * as THREE from 'three'

const PANEL_WIDTH = 0.46
const PANEL_HEIGHT = 0.18
const CANVAS_WIDTH = 920
const CANVAS_HEIGHT = 360
const TITLE_HEIGHT = 58
const PADDING = 28

const BG_COLOR = 'rgba(13, 13, 18, 0.86)'
const BORDER_COLOR = 'rgba(255, 255, 255, 0.14)'
const TITLE_COLOR = '#e8eaf0'
const MUTED_COLOR = 'rgba(232, 234, 240, 0.68)'

const POSITION_OFFSET = { x: -0.62, y: 0.15, z: 0.12 } as const

export interface VrLegendPanelHandle {
  readonly mesh: THREE.Mesh
  setLegend(src: string | null, title: string | null): void
  update(camera: THREE.Camera, globePosition: THREE.Vector3): void
  dispose(): void
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const w = CANVAS_WIDTH
  const h = CANVAS_HEIGHT
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = BG_COLOR
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, w - 2, h - 2)
}

function drawTitle(ctx: CanvasRenderingContext2D, title: string | null): void {
  const label = title ? `${title} legend` : 'Legend'
  ctx.fillStyle = TITLE_COLOR
  ctx.font = '600 34px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  let text = label
  const maxWidth = CANVAS_WIDTH - PADDING * 2
  while (ctx.measureText(text).width > maxWidth && text.length > 8) {
    text = `${text.slice(0, -2)}...`
  }
  ctx.fillText(text, PADDING, TITLE_HEIGHT / 2)
}

function drawImageContained(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
): void {
  const boxX = PADDING
  const boxY = TITLE_HEIGHT + PADDING / 2
  const boxW = CANVAS_WIDTH - PADDING * 2
  const boxH = CANVAS_HEIGHT - boxY - PADDING

  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
  ctx.fillRect(boxX, boxY, boxW, boxH)

  const iw = image.naturalWidth || image.width
  const ih = image.naturalHeight || image.height
  if (iw <= 0 || ih <= 0) return

  const scale = Math.min(boxW / iw, boxH / ih)
  const drawW = iw * scale
  const drawH = ih * scale
  const drawX = boxX + (boxW - drawW) / 2
  const drawY = boxY + (boxH - drawH) / 2
  ctx.drawImage(image, drawX, drawY, drawW, drawH)
}

function drawLoading(ctx: CanvasRenderingContext2D, title: string | null): void {
  drawBackground(ctx)
  drawTitle(ctx, title)
  ctx.fillStyle = MUTED_COLOR
  ctx.font = '500 30px system-ui, -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('Loading legend...', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 24)
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  title: string | null,
): void {
  drawBackground(ctx)
  drawTitle(ctx, title)
  drawImageContained(ctx, image)
}

export function createVrLegendPanel(THREE_: typeof THREE): VrLegendPanelHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) throw new Error('[VR Legend] 2D canvas context unavailable')

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
  const geometry = new THREE_.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT)
  const mesh = new THREE_.Mesh(geometry, material)
  mesh.renderOrder = 10
  mesh.visible = false

  const scratchTarget = new THREE_.Vector3()
  const scratchCamPos = new THREE_.Vector3()
  let currentSrc: string | null = null
  let currentTitle: string | null = null
  let loadSeq = 0

  return {
    mesh,

    setLegend(src, title) {
      if (src === currentSrc && title === currentTitle) return
      currentSrc = src
      currentTitle = title
      loadSeq++
      const seq = loadSeq

      if (!src) {
        mesh.visible = false
        return
      }

      mesh.visible = true
      drawLoading(ctx2d, title)
      texture.needsUpdate = true

      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        if (seq !== loadSeq) return
        try {
          drawLegend(ctx2d, image, currentTitle)
          texture.needsUpdate = true
          mesh.visible = true
        } catch {
          mesh.visible = false
        }
      }
      image.onerror = () => {
        if (seq !== loadSeq) return
        mesh.visible = false
      }
      image.src = src
    },

    update(camera, globePosition) {
      if (!mesh.visible) return
      scratchTarget.copy(globePosition)
      scratchTarget.x += POSITION_OFFSET.x
      scratchTarget.y += POSITION_OFFSET.y
      scratchTarget.z += POSITION_OFFSET.z
      mesh.position.copy(scratchTarget)
      camera.getWorldPosition(scratchCamPos)
      mesh.lookAt(scratchCamPos)
    },

    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
