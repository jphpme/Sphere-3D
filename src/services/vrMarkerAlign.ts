// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the marker scan of a handheld AR session: reads the camera
 * picture the session is already tracking with, finds the shared-AR
 * marker in it, and reports where the marker is in the room
 * (`docs/SHARED_AR_PLAN.md`).
 *
 * This is the WebXR half; the finding is `sharedMarkerDetect.ts` and the
 * geometry `sharedMarkerPose.ts`, both pure. What lives here is what
 * needs a session:
 *
 *   - the camera picture, through WebXR raw camera access (the
 *     `camera-access` feature, Chrome on Android). Headset browsers do
 *     not grant it, so `createVrMarkerAlign` returns null there;
 *   - the surface under the marker, from the session's own hit test.
 *     The corners' lines of sight are met with that surface, which is why
 *     the marker's printed size never matters;
 *   - the pace. A full camera frame is read back a few times a second and
 *     only while scanning; a session that never scans reads nothing.
 *
 * A result needs several readings in a row that agree, so one misread
 * frame, or a phone still swinging toward the marker, cannot place the
 * sphere.
 */

import { cameraPixelsToGray, detectMarker } from './sharedMarkerDetect'
import {
  intersectPlane,
  markerFrameFromCorners,
  rotateVector,
  steadyMarkerFrame,
  viewRay,
  type MarkerFrame,
  type Vec3,
} from './sharedMarkerPose'
import { logger } from '../utils/logger'

/** What the scan is waiting for, for the hint and the debug panel. */
export type MarkerScanStatus =
  | 'idle'
  /** The session gave no camera picture this frame. */
  | 'no-camera'
  /** No surface found under the middle of the view yet. */
  | 'no-surface'
  /** Looking; no marker in the picture. */
  | 'searching'
  /** Marker seen; collecting readings that agree. */
  | 'steadying'
  /** The marker is on a wall or a slope; the sphere needs a level one. */
  | 'not-level'
  /** Done: the last scan produced a frame. */
  | 'aligned'

export interface VrMarkerAlignHandle {
  start(): void
  stop(): void
  isScanning(): boolean
  /**
   * Call once per XR frame while scanning. Returns the marker's frame in
   * `refSpace` on the frame the readings settle, and stops the scan.
   */
  update(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    hitTestSource: XRHitTestSource,
    nowMs: number,
  ): MarkerFrame | null
  getStatus(): MarkerScanStatus
  /** The marker's measured side in metres, from the last reading. */
  getLastSize(): number | null
  dispose(): void
}

/** Milliseconds between camera readbacks while scanning. */
const SCAN_INTERVAL_MS = 120
/** Readings in a row that must agree. */
const READINGS_NEEDED = 4
/** Is the marker scan asked for? Opt-in by `?marker=1` until rooms exist. */
export function isMarkerAlignRequested(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): boolean {
  return new URLSearchParams(search).get('marker') === '1'
}

/** The parts of raw camera access the WebXR type definitions do not carry yet. */
interface XRCameraLike {
  readonly width: number
  readonly height: number
}
interface CameraBinding {
  getCameraImage(camera: XRCameraLike): WebGLTexture | null
}

/**
 * Build the scan for a session, or null when the session has no camera
 * picture to offer (the feature was not granted, or the browser has no
 * `XRWebGLBinding`).
 */
export function createVrMarkerAlign(
  session: XRSession,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): VrMarkerAlignHandle | null {
  if (!session.enabledFeatures?.includes('camera-access')) return null
  if (typeof XRWebGLBinding === 'undefined') return null
  let binding: CameraBinding
  try {
    binding = new XRWebGLBinding(session, gl) as unknown as CameraBinding
  } catch (err) {
    logger.warn('[VR] marker scan: no XRWebGLBinding for this session:', err)
    return null
  }
  if (typeof binding.getCameraImage !== 'function') return null

  const framebuffer = gl.createFramebuffer()
  let pixels = new Uint8Array(0)
  let scanning = false
  let status: MarkerScanStatus = 'idle'
  let lastScanMs = -Infinity
  let lastSize: number | null = null
  let readings: MarkerFrame[] = []
  /**
   * Which way up the readback is. A framebuffer reads bottom row first,
   * but the camera texture's own row order is the browser's choice; a
   * picture read the wrong way up is a mirror image, which the detector
   * refuses, so the other order is tried and the one that works is kept.
   */
  let bottomFirst = true

  /** Read the camera texture back; false when it cannot be read. */
  function readCamera(texture: WebGLTexture, width: number, height: number): boolean {
    if (pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4)
    // Only the framebuffer binding is touched, and it is put back, so the
    // renderer's own state cache stays true.
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    if (complete) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous)
    return complete
  }

  function update(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    hitTestSource: XRHitTestSource,
    nowMs: number,
  ): MarkerFrame | null {
    if (!scanning || nowMs - lastScanMs < SCAN_INTERVAL_MS) return null
    lastScanMs = nowMs

    const view = frame.getViewerPose(refSpace)?.views[0]
    const camera = (view as unknown as { camera?: XRCameraLike } | undefined)?.camera
    if (!view || !camera) {
      status = 'no-camera'
      return null
    }
    const hit = frame.getHitTestResults(hitTestSource)[0]?.getPose(refSpace)
    if (!hit) {
      status = 'no-surface'
      readings = []
      return null
    }
    const texture = binding.getCameraImage(camera)
    if (!texture || !readCamera(texture, camera.width, camera.height)) {
      status = 'no-camera'
      return null
    }

    let image = cameraPixelsToGray(pixels, camera.width, camera.height, bottomFirst)
    let found = detectMarker(image)
    if (!found) {
      image = cameraPixelsToGray(pixels, camera.width, camera.height, !bottomFirst)
      found = detectMarker(image)
      if (found) bottomFirst = !bottomFirst
    }
    if (!found) {
      status = 'searching'
      readings = []
      return null
    }

    // The camera picture is aligned with the view, so a picture position
    // is a view position: across is -1..1 left to right, and the picture's
    // top row is the view's top.
    const surface = {
      point: hit.transform.position as Vec3,
      normal: rotateVector(hit.transform.orientation, { x: 0, y: 1, z: 0 }),
    }
    const corners: Vec3[] = []
    for (const corner of found.corners) {
      const ray = viewRay(
        (corner.x / image.width) * 2 - 1,
        1 - (corner.y / image.height) * 2,
        view.projectionMatrix,
        view.transform.matrix,
      )
      const point = intersectPlane(ray, surface)
      if (point) corners.push(point)
    }
    const reading =
      corners.length === 4
        ? markerFrameFromCorners(corners as [Vec3, Vec3, Vec3, Vec3], surface.normal)
        : null
    if (!reading) {
      status = 'searching'
      readings = []
      return null
    }
    lastSize = reading.size
    if (rotateVector(reading.orientation, { x: 0, y: 1, z: 0 }).y < 0.999) {
      status = 'not-level'
      readings = []
      return null
    }

    readings.push(reading)
    if (readings.length > READINGS_NEEDED) readings.shift()
    status = 'steadying'
    if (readings.length < READINGS_NEEDED) return null
    const steady = steadyMarkerFrame(readings)
    if (!steady) return null
    scanning = false
    readings = []
    status = 'aligned'
    logger.info(`[VR] marker found: side ${(steady.size * 100).toFixed(1)} cm`)
    return steady
  }

  return {
    start() {
      scanning = true
      status = 'searching'
      readings = []
      lastScanMs = -Infinity
    },
    stop() {
      if (!scanning) return
      scanning = false
      status = 'idle'
      readings = []
    },
    isScanning: () => scanning,
    update,
    getStatus: () => status,
    getLastSize: () => lastSize,
    dispose() {
      scanning = false
      gl.deleteFramebuffer(framebuffer)
      pixels = new Uint8Array(0)
    },
  }
}
