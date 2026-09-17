# VR / AR Playback Track and Dates

Status: **implementing.** Design record for the in-VR date track —
the timeline strip that shows *when* the frame on the globe is, and
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

- Unit tests for the parse, the mapping (including `last_frame` and
  the mid-frame seek), the availability lookup, and the tick layout.
- `npm run type-check` (the repo's gate chain) and the VR suites.
- On hardware: a real-time stream in VR shows dates and scrubs; a
  phone taps the track without rotating the globe; a dataset without a
  DSA shows no track and no regression.
