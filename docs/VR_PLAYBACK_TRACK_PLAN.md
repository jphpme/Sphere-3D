# VR / AR Playback Track and Dates

Status: **shipped for VR/AR and the 2D transport.** Design record for the
date track — the strip that shows *when* the frame on the globe is, and
lets the user move through it. Companion to
[`REALTIME_OVERLAY_PLAN.md`](REALTIME_OVERLAY_PLAN.md) (which owns the
overlay rendering) and [`VR_INVESTIGATION_PLAN.md`](VR_INVESTIGATION_PLAN.md)
(which owns the immersive stack).

## Why

A real-time or forecast stream is a time series pretending to be a
video: 2,880 encoded frames at 24 fps is two minutes of video and
**thirty days of data**. The globe shows one of those instants, and
until now nothing in VR said which: `vrTimeLabel.ts` renders a
formatted string, but it only ever fills in for datasets whose catalog
row carries `startTime`/`endTime` — and the real-time rows
(`R2_DASH_*`) carry neither. Those datasets reached VR with **no date
at all** and no way to move through the series except letting it play.

The dates are not missing. They are declared beside every stream, in
the R2 bucket the MPD is pulled from.

## What shipped

| Piece | Where |
|---|---|
| The time axis, parsed and mapped | `src/services/dsaTimeline.ts` |
| Fetch once, remember success and failure | `src/services/dsaTimelineCache.ts` |
| The strip itself — geometry, labels, drawing | `src/services/timelineTrackCanvas.ts` |
| The VR half: plane, texture, UV hits | `src/services/vrTimelineTrack.ts` |
| The 2D half: panel canvas, pointer, keyboard, ARIA | `src/ui/timelineTrackUI.ts` |
| Resolved into the catalog row | `Dataset.timelineLink` (`dataService`) |
| Polled, drawn, positioned, torn down | `vrSession` (`getDatasetTimeline`, `seekToTimelineDate`) |
| Ray → scrub or tap → seek | `vrInteraction` (`{ kind: 'timeline' }`) |
| The host's answers, for both surfaces | `main.ts` (`timelineSnapshot`, `seekTimelineDate`) |

The two surfaces share the renderer deliberately: one implementation of
"where does a tick fall, what does a shaded span mean, where is the
playhead" cannot disagree with itself, and the geometry is proportional so
the same code draws a 1200 x 220 headset strip and a 240 x 56 panel
canvas. The VR drawing did not move when the renderer was extracted —
`timelineTrackCanvas.test.ts` pins its original pixel numbers.

**Labels are distributed, not counted.** A tick *count* is not a fit: labels
change width with the span, the canvas changes with the panel, and a ladder
that tops out can still return more ticks than the budget asked for. Every
candidate is measured and thinned against its row — ends anchored, a dropped
label never dropping its tick line — and the label form follows the **step**
(a sub-daily step prints the time as well), because a six-hour axis stepped
every three hours otherwise says "Aug 18" four times. The mobile report was a
measured one on both counts: at 390 px the panel's canvas is 300 px, and the
panel's time label overlapped the lat/lng readout by 33 px until it moved to
its own row.

**Dates in the 2D app.** The panel's time label now fills in for real-time
and forecast streams, which it never did: they carry no catalog
`startTime`/`endTime`, so the old path hid it. It borrows the track's UTC
formatter, because the axis is declared in UTC and two surfaces
disagreeing about one instant by a timezone offset is worse than either
choice on its own.

Not shipped, and deliberately: seeking backwards in a `type="dynamic"`
manifest, and anything the DSA declares beyond the time axis.

## What the data gives us

Each row of `public/assets/realtime-dash-datasets.json` (72 rows, all
72 with a `dsa`) names a `.dsa` — a JSON dataset annotation whose
schema is published at
`https://pachamama-studios.stream/schemas/dsa-v1.6.json`. The fields
this feature stands on, all verified against live files:

| field | meaning |
|---|---|
| `timeEnabled` | the row is a time series |
| `timeRange.start` / `.end` | the represented span |
| `timeRangeEndMode` | `exclusive` (`end` is the interval end) or `last_frame` (`end` is the final frame's stamp) |
| `timeTotalFrames` | data frames on the axis |
| `timeCadenceSeconds` | represented data time **per encoded frame** |
| `videoFrameRate` | encoded fps (`timeFrameRate` is the deprecated alias) |
| `dataAvailability` | `status`, counts, `fillPolicy`, and `ranges[]` marking `real` / `filled` / `missing` frame spans, with `sourceFrame` for a frozen fill |

**One encoded video frame is one data frame**, so the mapping is
arithmetic, not inference:

    frame = floor(videoTime × videoFrameRate)
    date(frame) = timeRange.start + frame × timeCadenceSeconds
    duration = timeTotalFrames / videoFrameRate

Checked against four live files across the two kinds: aircraft 2880
frames @ 900 s / 24 fps (2 min of video, 30 days of data — and the MPD
is `type="static"`, `mediaPresentationDuration="PT2M0.2S"`,
`availabilityStartTime` equal to the DSA's `timeRange.start`), fires
834 @ 14400 s, chlorophyll 96 @ 54000 s with `status: complete`, and a
regional forecast at 31 frames @ 3600 s encoded at **8** fps. The
cadence and the frame rate are per-row, which is why both are read
rather than assumed.

The 2D app's date machinery (`src/utils/time.ts`) is a different
mechanism for a different input: it infers a display interval from
catalog `start_time`/`end_time` plus `period` / `frames.count`, and
it cannot serve these rows because they have none of those fields. The
two must not be conflated: the DSA is exact where the catalog is a
heuristic.

## Non-goals

- **Replacing the 2D date path.** `inferDisplayInterval`,
  `videoTimeToDate` and friends keep serving catalog datasets. This
  feature reads a declared axis, not an inferred one.
- **A 2D track.** VR/AR first; the mapping module is UI-agnostic so a
  2D strip can reuse it later without a second implementation.
- **Live (`type="dynamic"`) MPDs.** Seeking a dynamic manifest
  backwards is not generally possible. The mapping is manifest-agnostic
  and would still *display* correctly; only the seek would need gating
  once such a row exists.
- **DSA fields beyond the time axis.** `layers`, `interactive`,
  `streaming`, `playbackSettings`, `captions`, `arLayers` and the
  rest are the overlay plan's business, not this one's.

## Design

Three modules, each with one job, split the way
`vrHeightControl`/`vrPlacement` and `equirectRtt`/`outputScene` are:

1. **`src/services/dsaTimeline.ts`** — pure. Parse the time block into
   a `DsaTimeline`, and map between data frames, dates, and video
   seconds. No DOM, no Three.js, no fetch: the whole contract above is
   testable as arithmetic. Degrades to `null` on anything it cannot
   stand on (no `timeEnabled`, unparseable range, no frame count, no
   frame rate), because a stream with a half-known axis is worse served
   by a wrong date than by no date.
2. **`src/services/dsaTimelineCache.ts`** — fetch plus memory. A
   `.dsa` is fetched once per URL, failures are remembered as
   failures (so a 404 — one index row has one today — does not retry on
   every frame), and `prefetch()` is fire-and-forget so a caller on
   the render loop can call it unconditionally.
3. **`src/services/vrTimelineTrack.ts`** — the widget. A CanvasTexture
   strip on a plane, in the `vrTourControls` idiom: start and end
   dates, tick marks, a progress bar, the playhead, and `dataAvailability`
   spans shaded so a frozen fill reads as a frozen fill rather than as
   data. Exposes `hitTest(uv)` for the interaction layer.

The host wires them: `Dataset.timelineLink` is resolved alongside
`dataLink` when the real-time index is mapped, `main.ts` answers
`getDatasetTimeline()` from the cache plus the video's playhead and
implements `seekToTimelineDate()`, and `vrSession` polls both per
frame.

## Interaction rules

- **Headset:** trigger-drag on the track scrubs — the playhead follows
  the ray, the globe's frame follows at a throttled rate (a DASH seek
  per XR frame is 90 seeks a second), and the release commits. A tap
  seeks to the tapped instant.
- **Handheld AR:** **tap only.** The phone's touch is rotate-only by
  design (`vrRotateTouch`), so a drag that starts on the track must
  not also scrub: the release commits only when it stayed within a tap
  threshold of where it started.
- **Deliberately not a globe gesture.** The track is a control, so a
  drag on it never rotates the globe — the same rule the placement
  buttons and the browse panel already follow.

## Verification

- **Unit tests** — 57 across `dsaTimeline.test.ts`,
  `dsaTimelineCache.test.ts`, `timelineTrackCanvas.test.ts` and
  `timelineTrackUI.test.ts`: the parse
  (numeric strings, the deprecated fps alias, a derived cadence, and
  every rejection), the mapping (`last_frame`, mid-frame seeks,
  clamping, the axis round-trip), the availability lookup (binary
  search, sparse spans, `unknown`), the tick ladder, the UV↔progress
  inversion, and the cache's five rules — one fetch per URL including
  failures, concurrent callers sharing it, and null for every miss.
- **`npm run type-check`** — the repo's whole gate chain — passes.
- ☐ **On hardware.** A real-time stream in VR should show dates and
  scrub; a phone should seek on a tap and still rotate on a drag; the 2D
  panel should show the same axis above its scrubber and seek by click,
  drag and arrow key; a dataset with no axis should show no track and no
  regression.
