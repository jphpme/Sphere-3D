// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * In-AR diagnostic readout (`?vrDebug=1`).
 *
 * Exists because the AR failures it reports cannot be debugged the usual
 * way: the phone has no devtools, `chrome://inspect` needs a desktop
 * attached, and a console line is worth nothing to the person holding the
 * headset. What that person CAN do is look at the screen and photograph
 * it — so the state a bug report needs is drawn where they already are,
 * as a billboarded panel floating in front of the camera.
 *
 * Deliberately separate from `vrHud`: the HUD is the product surface
 * (title, transport, buttons) with its own layout and tests, and this is
 * a diagnostic that ships inert. Nothing mounts unless the URL asks for
 * it, so a normal session pays one boolean.
 *
 * The fields answer the questions a "the gestures do nothing" report
 * actually raises, in the order they are asked:
 *
 *   - `class` / `src` / `pad` / `domOv` — what the session and the
 *     device reported, which is what decides every branch downstream.
 *   - `touch` / `layer` — whether the AR touch layer mounted (the one
 *     thing that makes one finger move the globe).
 *   - `img` / `load` — whether a dataset texture reached the scene and
 *     whether the loading scene is still up, which is what "there are two
 *     spheres" turns out to be.
 *   - `cat` / `panels` — whether the catalog is empty (nothing to pick)
 *     and how many globes the 2D layout put in the scene.
 *   - `scale` — the globe's size, which is the number the pinch keeps
 *     driving to its maximum.
 */

import type * as THREE from 'three'

/** Handle returned by {@link createVrDebugPanel}. */
export interface VrDebugPanelHandle {
  readonly mesh: THREE.Mesh
  /** Replace the text. Redraws the canvas only when the text changed. */
  setLines(lines: string[]): void
  /** Keep the panel in front of the viewer. Call once per frame. */
  update(camera: THREE.Camera): void
  dispose(): void
}

/** Canvas size — wide enough for the longest line at 20 px monospace. */
const CANVAS_WIDTH = 768
const CANVAS_HEIGHT = 176
/** Panel width in metres, ~arm's length in front of the viewer. */
const PANEL_WIDTH = 0.42
/** Distance in front of the camera the panel floats at. */
const DISTANCE = 0.6

export function createVrDebugPanel(THREE_: typeof THREE): VrDebugPanelHandle {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('vrDebugPanel: 2D canvas context unavailable')

  const texture = new THREE_.CanvasTexture(canvas)
  texture.colorSpace = THREE_.SRGBColorSpace
  const material = new THREE_.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const height = PANEL_WIDTH * (CANVAS_HEIGHT / CANVAS_WIDTH)
  const geometry = new THREE_.PlaneGeometry(PANEL_WIDTH, height)
  const mesh = new THREE_.Mesh(geometry, material)
  // Drawn over the scene: a diagnostic behind a globe explains nothing.
  mesh.renderOrder = 9999
  mesh.frustumCulled = false

  let current = ''

  function draw(lines: string[]): void {
    const text = lines.join('\n')
    if (text === current) return
    current = text
    ctx!.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    ctx!.fillStyle = 'rgba(4, 10, 24, 0.78)'
    ctx!.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    ctx!.strokeStyle = 'rgba(140, 190, 255, 0.5)'
    ctx!.lineWidth = 2
    ctx!.strokeRect(1, 1, CANVAS_WIDTH - 2, CANVAS_HEIGHT - 2)
    ctx!.fillStyle = '#cfe4ff'
    ctx!.font = '20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    ctx!.textBaseline = 'top'
    lines.slice(0, 7).forEach((line, i) => {
      ctx!.fillText(line, 12, 10 + i * 23)
    })
    texture.needsUpdate = true
  }

  const scratchCamPos = new THREE_.Vector3()
  const scratchForward = new THREE_.Vector3()
  const scratchRight = new THREE_.Vector3()
  const scratchUp = new THREE_.Vector3()

  draw(['vrDebug: waiting for frame'])

  return {
    mesh,
    setLines(lines) {
      draw(lines)
    },
    update(camera) {
      // Camera basis straight off the world matrix — the panel keeps its
      // corner of the view whatever the head does.
      const m = camera.matrixWorld.elements
      scratchRight.set(m[0], m[1], m[2]).normalize()
      scratchUp.set(m[4], m[5], m[6]).normalize()
      scratchForward.set(-m[8], -m[9], -m[10]).normalize()
      camera.getWorldPosition(scratchCamPos)
      mesh.position
        .copy(scratchCamPos)
        .addScaledVector(scratchForward, DISTANCE)
        .addScaledVector(scratchUp, 0.16)
        .addScaledVector(scratchRight, -0.3)
      // `Object3D.lookAt` points a non-camera object's +Z at the target,
      // and a PlaneGeometry's front face is +Z — so this already faces
      // the viewer (same call `vrTimeLabel` makes).
      mesh.lookAt(scratchCamPos)
    },
    dispose() {
      texture.dispose()
      material.dispose()
      geometry.dispose()
    },
  }
}
