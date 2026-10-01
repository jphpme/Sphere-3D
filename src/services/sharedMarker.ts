// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * AYNI — the shared-AR marker: the AYNI XR mark inside a black frame,
 * with a ring of black and white squares between the two. Everyone in a
 * room looks at one printed (or displayed) copy, and each device derives
 * the same position and heading from it, which is what lets several
 * phones see one sphere in one place (`docs/SHARED_AR_PLAN.md`).
 *
 * This module is the layout alone, shared by the artwork
 * (`buildMarkerSvg`, written to `public/ayni-xr-anchor.svg`) and the
 * detector (`sharedMarkerDetect.ts`), so the two cannot disagree about
 * which square is black.
 *
 * The frame is an 8 x 8 grid of modules:
 *
 *   - the outer ring is the black frame the detector finds as a quad;
 *   - the next ring is 20 code squares, read clockwise from the top-left;
 *   - the 4 x 4 centre is the mark, which the detector never reads.
 *
 * A module of white surrounds the frame (the quiet zone). The code is one
 * fixed pattern rather than an id: its job is to prove the quad is this
 * marker and to say which corner is the top-left. Its four rotations
 * differ from each other in at least 12 of 20 squares, so a read with a
 * couple of wrong squares still resolves to one orientation.
 */

/** Modules across the black frame, frame included. */
export const MARKER_GRID = 8
/** White modules around the frame. */
export const MARKER_QUIET = 1
/** Squares in the code ring. */
export const MARKER_CODE_LENGTH = 20

/** The code ring, clockwise from the top-left square. true = black. */
export const MARKER_CODE: readonly boolean[] = Array.from(
  '00010001001101110111',
  (c) => c === '1',
)

/** Row and column of each code square, in reading order. */
export const MARKER_CODE_CELLS: readonly (readonly [row: number, col: number])[] = (() => {
  const cells: [number, number][] = []
  const lo = 1
  const hi = MARKER_GRID - 2
  for (let c = lo; c < hi; c++) cells.push([lo, c]) // top side, left to right
  for (let r = lo; r < hi; r++) cells.push([r, hi]) // right side, downward
  for (let c = hi; c > lo; c--) cells.push([hi, c]) // bottom side, right to left
  for (let r = hi; r > lo; r--) cells.push([r, lo]) // left side, upward
  return cells
})()

/** True for a module of the black frame. */
export function isMarkerFrameCell(row: number, col: number): boolean {
  const last = MARKER_GRID - 1
  return row === 0 || col === 0 || row === last || col === last
}

/**
 * Is the module at (row, col) black? `null` for the centre, which holds
 * the mark and carries no information.
 */
export function markerCellIsDark(row: number, col: number): boolean | null {
  if (isMarkerFrameCell(row, col)) return true
  const index = MARKER_CODE_CELLS.findIndex(([r, c]) => r === row && c === col)
  return index === -1 ? null : MARKER_CODE[index]
}

/**
 * The marker as a standalone SVG, one unit per module. `markSvg` is the
 * AYNI XR mark's own `<svg>` document; it is nested in the centre with a
 * margin, so it never touches the code ring.
 */
export function buildMarkerSvg(markSvg: string): string {
  const total = MARKER_GRID + 2 * MARKER_QUIET
  const rects: string[] = []
  for (let row = 0; row < MARKER_GRID; row++) {
    for (let col = 0; col < MARKER_GRID; col++) {
      if (!markerCellIsDark(row, col)) continue
      // A hair of overlap, so no renderer leaves a seam between modules.
      rects.push(
        `<rect x="${col + MARKER_QUIET - 0.01}" y="${row + MARKER_QUIET - 0.01}" width="1.02" height="1.02"/>`,
      )
    }
  }
  const centre = MARKER_QUIET + 2
  const centreSize = MARKER_GRID - 4
  const margin = 0.3
  const nested = markSvg
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(
      /<svg\b/,
      `<svg x="${centre + margin}" y="${centre + margin}" width="${centreSize - 2 * margin}" height="${centreSize - 2 * margin}"`,
    )
    .trim()
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}">`,
    '<title>AYNI XR shared-AR marker</title>',
    `<rect width="${total}" height="${total}" fill="#fff"/>`,
    `<g fill="#000">${rects.join('')}</g>`,
    nested,
    '</svg>',
    '',
  ].join('\n')
}
