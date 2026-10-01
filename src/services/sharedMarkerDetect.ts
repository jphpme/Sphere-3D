// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — finds the shared-AR marker (`sharedMarker.ts`) in a grayscale
 * camera frame and returns its four corners, in the marker's own order.
 *
 * Hand-written because the browser gives no help here: WebXR image
 * tracking is still behind a flag in Chrome, so the session hands over
 * raw camera pixels (`vrMarkerAlign.ts`) and the finding is ours. The
 * steps are the usual ones for a square fiducial:
 *
 *   1. threshold against the local mean, so a shadow across the table or
 *      a dim screen does not move the black/white boundary;
 *   2. collect connected dark regions;
 *   3. take the four corners of each region's outline as a candidate
 *      quad, sharpened by fitting a line to each side;
 *   4. read the 8 x 8 grid through the quad's perspective mapping, and
 *      accept only a black frame around the expected code ring.
 *
 * Step 4 is the whole of the verification, and it also settles which
 * corner is the top-left: the code's four rotations are far apart, and a
 * mirror image matches none of them.
 *
 * Coordinates are image pixels with x to the right and y downward; a
 * pixel's centre is at +0.5. Pure: no DOM, no WebGL.
 */

import {
  MARKER_CODE,
  MARKER_CODE_CELLS,
  MARKER_CODE_LENGTH,
  MARKER_GRID,
  isMarkerFrameCell,
} from './sharedMarker'

/** One 8-bit luminance plane, row 0 at the top. */
export interface GrayImage {
  readonly data: Uint8Array | Uint8ClampedArray
  readonly width: number
  readonly height: number
}

export interface Point2 {
  x: number
  y: number
}

export interface MarkerDetection {
  /** The black frame's outer corners: top-left, top-right, bottom-right,
   *  bottom-left, as printed. */
  corners: [Point2, Point2, Point2, Point2]
  /** Code squares that read wrong (0 to MAX_CODE_ERRORS). */
  codeErrors: number
}

/** Code squares allowed to read wrong. The rotations differ in 12. */
export const MAX_CODE_ERRORS = 2
/** Frame modules (of 28) allowed to read white. */
const MAX_FRAME_ERRORS = 3
/** A pixel is dark when this far below its neighbourhood's mean. */
const DARK_RATIO = 0.85
/** Smallest frame worth reading: under 3 px per module the code blurs. */
const MIN_SIDE_PX = 24

/** The detector's picture: a camera frame reduced to about this many pixels on its long side. */
const DETECT_LONG_SIDE = 800

/**
 * Reduce an RGBA readback to the detector's grayscale picture, row 0 at
 * the top. `bottomFirst` says the readback's first row is the bottom of
 * the picture, as `readPixels` delivers a framebuffer.
 */
export function cameraPixelsToGray(
  rgba: Uint8Array,
  width: number,
  height: number,
  bottomFirst: boolean,
  longSide: number = DETECT_LONG_SIDE,
): GrayImage {
  const step = Math.max(1, Math.floor(Math.max(width, height) / longSide))
  const outWidth = Math.floor(width / step)
  const outHeight = Math.floor(height / step)
  const data = new Uint8Array(outWidth * outHeight)
  for (let y = 0; y < outHeight; y++) {
    const srcRow = bottomFirst ? height - 1 - y * step : y * step
    let src = srcRow * width * 4
    for (let x = 0; x < outWidth; x++) {
      data[y * outWidth + x] = (rgba[src] * 77 + rgba[src + 1] * 150 + rgba[src + 2] * 29) >> 8
      src += step * 4
    }
  }
  return { data, width: outWidth, height: outHeight }
}

/** Dark/light mask by comparison with the mean of a window around each pixel. */
export function thresholdAdaptive(image: GrayImage): Uint8Array {
  const { data, width, height } = image
  const stride = width + 1
  const integral = new Uint32Array(stride * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      rowSum += data[y * width + x]
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum
    }
  }
  // The window must be wider than the frame is thick, or the middle of
  // the frame sees only black and reads as "not darker than its
  // surroundings". A quarter of the short side covers a marker that
  // fills the picture.
  const half = Math.max(8, Math.round(Math.min(width, height) / 8))
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half)
    const y1 = Math.min(height, y + half + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half)
      const x1 = Math.min(width, x + half + 1)
      const sum =
        integral[y1 * stride + x1] -
        integral[y0 * stride + x1] -
        integral[y1 * stride + x0] +
        integral[y0 * stride + x0]
      const count = (x1 - x0) * (y1 - y0)
      if (data[y * width + x] * count < sum * DARK_RATIO) mask[y * width + x] = 1
    }
  }
  return mask
}

/** Maps the unit square onto a quad given in the order (0,0) (1,0) (1,1) (0,1). */
export function squareToQuad(quad: readonly Point2[]): (u: number, v: number) => Point2 {
  const [p0, p1, p2, p3] = quad
  const sx = p0.x - p1.x + p2.x - p3.x
  const sy = p0.y - p1.y + p2.y - p3.y
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const den = dx1 * dy2 - dx2 * dy1
  const g = den === 0 ? 0 : (sx * dy2 - dx2 * sy) / den
  const h = den === 0 ? 0 : (dx1 * sy - sx * dy1) / den
  const a = p1.x - p0.x + g * p1.x
  const b = p3.x - p0.x + h * p3.x
  const d = p1.y - p0.y + g * p1.y
  const e = p3.y - p0.y + h * p3.y
  return (u, v) => {
    const w = g * u + h * v + 1
    return { x: (a * u + b * v + p0.x) / w, y: (d * u + e * v + p0.y) / w }
  }
}

/**
 * A region's outline: for every row its leftmost and rightmost pixel, and
 * for every column its topmost and bottommost. For a convex shape that is
 * the whole outer edge, and it leaves out the holes, which is the point:
 * the frame is hollow, and only its outside is a square.
 */
function outline(pixels: Int32Array, count: number, width: number, height: number): Point2[] {
  const rowMin = new Int32Array(height).fill(width)
  const rowMax = new Int32Array(height).fill(-1)
  const colMin = new Int32Array(width).fill(height)
  const colMax = new Int32Array(width).fill(-1)
  for (let i = 0; i < count; i++) {
    const x = pixels[i] % width
    const y = (pixels[i] / width) | 0
    if (x < rowMin[y]) rowMin[y] = x
    if (x > rowMax[y]) rowMax[y] = x
    if (y < colMin[x]) colMin[x] = y
    if (y > colMax[x]) colMax[x] = y
  }
  const points: Point2[] = []
  for (let y = 0; y < height; y++) {
    if (rowMax[y] < 0) continue
    points.push({ x: rowMin[y], y }, { x: rowMax[y], y })
  }
  for (let x = 0; x < width; x++) {
    if (colMax[x] < 0) continue
    points.push({ x, y: colMin[x] }, { x, y: colMax[x] })
  }
  return points
}

/**
 * The four corners of an outline, roughly, clockwise as seen in the image;
 * null when it is not quad-like. For a convex quad: the point farthest
 * from the middle is a corner, the point farthest from that is another,
 * the point farthest from the line through those two is a third, and the
 * point farthest outside that triangle is the fourth.
 */
function roughQuad(points: readonly Point2[]): Point2[] | null {
  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= points.length
  cy /= points.length
  const farthestFrom = (fx: number, fy: number): Point2 => {
    let best = -1
    let found = points[0]
    for (const p of points) {
      const dist = (p.x - fx) * (p.x - fx) + (p.y - fy) * (p.y - fy)
      if (dist > best) {
        best = dist
        found = p
      }
    }
    return found
  }
  const a = farthestFrom(cx, cy)
  const b = farthestFrom(a.x, a.y)
  const span = Math.hypot(b.x - a.x, b.y - a.y)
  if (span < MIN_SIDE_PX) return null
  let c = a
  let farthest = 0
  for (const p of points) {
    const dist = Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / span
    if (dist > farthest) {
      farthest = dist
      c = p
    }
  }
  // A line or a sliver has no third corner standing clear of the first two.
  if (farthest < 0.15 * span) return null
  // Seen at a slant the near edge can be longer than a diagonal, so the
  // first two corners may be neighbours: no pair is assumed to be opposite.
  const triangle = [a, b, c]
  const edges = triangle.map((p, i) => {
    const q = triangle[(i + 1) % 3]
    const r = triangle[(i + 2) % 3]
    const ex = q.x - p.x
    const ey = q.y - p.y
    const len = Math.hypot(ex, ey) || 1
    // Signed so the triangle's own third corner is on the negative side.
    const sign = ex * (r.y - p.y) - ey * (r.x - p.x) > 0 ? -1 : 1
    return { p, ex: (sign * ex) / len, ey: (sign * ey) / len }
  })
  let d = a
  let outside = 0
  for (const p of points) {
    for (const edge of edges) {
      const dist = edge.ex * (p.y - edge.p.y) - edge.ey * (p.x - edge.p.x)
      if (dist > outside) {
        outside = dist
        d = p
      }
    }
  }
  if (outside < 0.1 * span) return null
  // Clockwise as seen in the image: with y downward, by increasing angle
  // around the middle.
  const midX = (a.x + b.x + c.x + d.x) / 4
  const midY = (a.y + b.y + c.y + d.y) / 4
  return [a, b, c, d].sort(
    (p, q) => Math.atan2(p.y - midY, p.x - midX) - Math.atan2(q.y - midY, q.x - midX),
  )
}

/**
 * Sharpen a rough quad: fit a line to the outline points along each side
 * and take the corners where neighbouring lines cross.
 *
 * The rough corners are single pixels, and where a side runs nearly
 * parallel to the line it was measured from, the "farthest" pixel can sit
 * several pixels along the side from the true corner. A fitted line uses
 * every pixel of the side, which also brings the corner to a fraction of
 * a pixel. Returns null when a side has too few points to fit.
 */
function refineQuad(points: readonly Point2[], rough: readonly Point2[]): Point2[] | null {
  let quad = rough.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }))
  // Twice: the second pass assigns points with the first pass's corners.
  for (let pass = 0; pass < 2; pass++) {
    const midX = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4
    const midY = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4
    const sums = quad.map(() => ({ n: 0, x: 0, y: 0, xx: 0, xy: 0, yy: 0 }))
    for (const point of points) {
      const px = point.x + 0.5
      const py = point.y + 0.5
      let nearest = -1
      let nearestDist = Infinity
      for (let i = 0; i < 4; i++) {
        const p = quad[i]
        const q = quad[(i + 1) % 4]
        const ex = q.x - p.x
        const ey = q.y - p.y
        const len2 = ex * ex + ey * ey || 1
        const along = ((px - p.x) * ex + (py - p.y) * ey) / len2
        // The ends of a side belong to the corner, where two sides meet.
        if (along < 0.12 || along > 0.88) continue
        const len = Math.sqrt(len2)
        const dist = Math.abs(ex * (py - p.y) - ey * (px - p.x)) / len
        // A point left out of its own side's ends must not fall to the
        // side across the square: only points near a side count for it.
        // The first pass allows for a rough corner being off.
        if (dist > Math.max(2.5, (pass === 0 ? 0.1 : 0.03) * len)) continue
        if (dist < nearestDist) {
          nearestDist = dist
          nearest = i
        }
      }
      if (nearest === -1) continue
      const s = sums[nearest]
      s.n++
      s.x += px
      s.y += py
      s.xx += px * px
      s.xy += px * py
      s.yy += py * py
    }
    // Each side as a point and a unit direction: the principal axis of
    // its points.
    const lines: { x: number; y: number; dx: number; dy: number }[] = []
    for (const s of sums) {
      if (s.n < 6) return null
      const mx = s.x / s.n
      const my = s.y / s.n
      const cxx = s.xx / s.n - mx * mx
      const cxy = s.xy / s.n - mx * my
      const cyy = s.yy / s.n - my * my
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
      const dx = Math.cos(angle)
      const dy = Math.sin(angle)
      // An outline pixel's centre lies up to a pixel inside the true
      // edge, half on average along the axis it was scanned on: move the
      // line outward by that much.
      let nx = -dy
      let ny = dx
      if (nx * (mx - midX) + ny * (my - midY) < 0) {
        nx = -nx
        ny = -ny
      }
      const out = 0.5 * Math.max(Math.abs(nx), Math.abs(ny))
      lines.push({ x: mx + nx * out, y: my + ny * out, dx, dy })
    }
    const next: Point2[] = []
    for (let i = 0; i < 4; i++) {
      // Corner i is where side i-1 meets side i.
      const l1 = lines[(i + 3) % 4]
      const l2 = lines[i]
      const den = l1.dx * l2.dy - l1.dy * l2.dx
      if (Math.abs(den) < 1e-6) return null
      const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / den
      next.push({ x: l1.x + t * l1.dx, y: l1.y + t * l1.dy })
    }
    quad = next
  }
  return quad
}

/** Signed area, positive for a quad that runs clockwise in the image. */
function signedArea(quad: readonly Point2[]): number {
  let sum = 0
  for (let i = 0; i < 4; i++) {
    const p = quad[i]
    const q = quad[(i + 1) % 4]
    sum += p.x * q.y - q.x * p.y
  }
  return sum / 2
}

/**
 * Read the grid through `quad` and match it against the marker. Returns
 * the corners reordered to the marker's own, or null.
 */
function decodeQuad(
  mask: Uint8Array,
  width: number,
  height: number,
  quad: readonly Point2[],
): MarkerDetection | null {
  const map = squareToQuad(quad)
  /** Majority of the 3 x 3 pixels around a module's centre. */
  const readCell = (row: number, col: number): boolean => {
    const p = map((col + 0.5) / MARKER_GRID, (row + 0.5) / MARKER_GRID)
    const px = Math.floor(p.x)
    const py = Math.floor(p.y)
    let dark = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx
        const y = py + dy
        if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x]) dark++
      }
    }
    return dark >= 5
  }
  let frameErrors = 0
  for (let row = 0; row < MARKER_GRID; row++) {
    for (let col = 0; col < MARKER_GRID; col++) {
      if (isMarkerFrameCell(row, col) && !readCell(row, col)) frameErrors++
    }
  }
  if (frameErrors > MAX_FRAME_ERRORS) return null
  const read = MARKER_CODE_CELLS.map(([row, col]) => readCell(row, col))
  // The quad starts at an arbitrary corner. If it starts at the marker's
  // corner `m` (0 = top-left, clockwise), the ring reads `m` sides late.
  const side = MARKER_CODE_LENGTH / 4
  let bestErrors = Infinity
  let bestStart = 0
  for (let m = 0; m < 4; m++) {
    let errors = 0
    for (let i = 0; i < MARKER_CODE_LENGTH; i++) {
      if (read[i] !== MARKER_CODE[(i + side * m) % MARKER_CODE_LENGTH]) errors++
    }
    if (errors < bestErrors) {
      bestErrors = errors
      bestStart = m
    }
  }
  if (bestErrors > MAX_CODE_ERRORS) return null
  const topLeft = (4 - bestStart) % 4
  return {
    corners: [
      quad[topLeft],
      quad[(topLeft + 1) % 4],
      quad[(topLeft + 2) % 4],
      quad[(topLeft + 3) % 4],
    ],
    codeErrors: bestErrors,
  }
}

/**
 * Find the marker. Returns the best candidate (fewest code errors, then
 * the largest), or null when the frame holds none.
 */
export function detectMarker(image: GrayImage): MarkerDetection | null {
  const { width, height } = image
  if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) return null
  const mask = thresholdAdaptive(image)
  const visited = new Uint8Array(width * height)
  const pixels = new Int32Array(width * height)
  let best: MarkerDetection | null = null
  let bestArea = 0
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue
    // Flood fill; `pixels` is both the work queue and the region's list.
    let count = 0
    let head = 0
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    visited[start] = 1
    pixels[count++] = start
    while (head < count) {
      const index = pixels[head++]
      const x = index % width
      const y = (index / width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const next = ny * width + nx
          if (mask[next] && !visited[next]) {
            visited[next] = 1
            pixels[count++] = next
          }
        }
      }
    }
    if (maxX - minX < MIN_SIDE_PX || maxY - minY < MIN_SIDE_PX) continue
    // A region cut by the picture's edge is a marker only partly in view.
    if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) continue
    const points = outline(pixels, count, width, height)
    const rough = roughQuad(points)
    const quad = rough && refineQuad(points, rough)
    if (!quad) continue
    const area = signedArea(quad)
    if (area <= 0) continue
    const found = decodeQuad(mask, width, height, quad)
    if (!found) continue
    if (
      !best ||
      found.codeErrors < best.codeErrors ||
      (found.codeErrors === best.codeErrors && area > bestArea)
    ) {
      best = found
      bestArea = area
    }
  }
  return best
}
