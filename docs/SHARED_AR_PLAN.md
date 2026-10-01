# Shared AR Plan

**Status: draft for review.** Phase 1 (the marker) is built
and works on phones. Phases 2 and 3 (the room, and what it shares) are
built and tested between two browsers, not yet between two phones in AR.
Phase 4 is design only.

Last reviewed: 2026-10-01

## Goal

AYNI XR is a one-person experience today. The goal is a shared one, in
the sense the name carries: one person opens a session, others in the
room join it from a QR code, and everyone sees **the same sphere in the
same place**, each from where they stand. The person who opened the
session drives it (dataset, time, spin, tilt, size) and can hand the
controls to someone else. Everyone else watches.

In person first. The same session, without the shared position, is what a
remote audience would join later.

## Non-goals

- **No free-for-all control.** One controller at a time; the room server
  drops state from anyone else.
- **No voice or video between participants.** They are in the same room.
- **No account requirement to join.** A link is enough to watch.
- **No iPhone AR.** Safari has no WebXR. An iPhone can join as a 2D
  follower on the ordinary globe.
- **No private datasets through a room.** A follower gets the geo-media
  rows only if their own browser already has the switch.

## Why a marker

Each device's WebXR session has its own coordinate system, with its
origin wherever that device happened to start. Nothing in the browser
relates one device's coordinates to another's: there are no cloud anchors
on the web. So "the same place" needs something physical that every
device can see and measure itself against.

| Option | Verdict |
|---|---|
| WebXR image tracking | Still behind `chrome://flags/#webxr-incubations`. Cannot ship on it. |
| Raw camera access + our own detector | **Chosen for phones.** Shipped in Chrome for Android since 107. |
| Two taps on known points | **Chosen for headsets** (phase 4): the Quest browser refuses `camera-access`. Uses the hit test that placement already uses. |
| Everyone places their own sphere | Kept as the fallback: same content, not the same place. |

## The marker

`public/ayni-xr-anchor.svg`: the AYNI XR mark inside a black frame, with a
ring of 20 black and white squares between them. The layout is defined
once, in `src/services/sharedMarker.ts`; the file is generated from it
(`npm run build:anchor-marker`) and a test fails if the two drift.

- The **frame** is what the detector finds: a dark quad on a light sheet.
- The **ring** proves the quad is this marker and says which corner is the
  top-left. It is one fixed pattern, not an id. Its four rotations differ
  in at least 12 of the 20 squares, and a read may get 2 wrong.
- The **mark** in the middle is for people. The detector never reads it.
- Colour carries nothing. Coloured corner dots were considered and
  dropped: colour shifts with the room's light, the camera's white
  balance and a screen's brightness.

It can be printed, or shown on a spare phone or tablet lying on the
table. The host's own phone cannot be the marker, because the host is
looking through it.

**Show anchor** (the button under the home button, top-left;
`src/ui/anchorPanel.ts`) turns any device's
screen into the marker: the largest square the screen allows, on white,
with the screen kept awake. The picture is served from the stream host's
R2 bucket (`ayni-videos`, key `shared/xr/ayni-xr-anchor-v1.svg`,
immutable), with the bundled file as the fallback. A change to the layout
means regenerating the file, uploading it under the next version and
bumping `ANCHOR_MARKER_KEY`:

```bash
npx wrangler r2 object put ayni-videos/shared/xr/ayni-xr-anchor-v2.svg \
  --file public/ayni-xr-anchor.svg --content-type image/svg+xml \
  --cache-control "public, max-age=31536000, immutable" --remote
```

### Size does not matter

The detector gives the four corners in the camera picture. Each corner's
line of sight is then met with the surface the device has already found
under the marker (the WebXR hit test). That yields the corners in metres
without knowing how large the marker was printed, so an A4 sheet and a
tablet of unknown size give the same frame. The measured side length is
reported (`?vrDebug=1`, `side=`), which makes a ruler a test of accuracy.

### The shared frame

Every device derives the same frame from the marker
(`src/services/sharedMarkerPose.ts`):

| Axis | Meaning |
|---|---|
| origin | the middle of the marker |
| +Y | up. Snapped to the session's own up when the surface is within 20° of level |
| +X | toward the marker's right edge, as printed |
| +Z | toward the marker's bottom edge |

After a scan the sphere floats above the origin at scale 1, with the
prime meridian facing +Z. The marker defines the frame, not the sphere's
position for ever: in phase 3 the controller moves the sphere within the
frame and everyone sees it move.

The marker only has to be in view during the scan. Afterwards each device
holds the spot with its own anchor.

## Phases

### Phase 1: the marker (built)

Opt-in by `?marker=1` on an Android phone, until rooms exist. With it,
AR mode asks for the camera picture and shows a **Scan marker** button.

| Piece | Where |
|---|---|
| Layout and artwork | `sharedMarker.ts`, `scripts/build-anchor-marker.ts` |
| Detection in a camera frame | `sharedMarkerDetect.ts` |
| Corners to a frame in the room | `sharedMarkerPose.ts` |
| Camera readback, pacing, agreement between readings | `vrMarkerAlign.ts` |
| Button and hints | `src/ui/vrMarkerAlignTouch.ts` |
| The marker on a screen | `src/ui/anchorPanel.ts` (the Show anchor button) |
| Wiring, and placing the sphere | `vrSession.ts` (`applyMarkerFrame`) |

What is verified, and how:

- Detector: unit tests over drawn frames (turned, slanted, small, in
  shadow with noise, mirrored, cut off).
- Artwork against detector: `scripts/experiments/marker-detect-check.ts`
  draws the real file in headless Chromium as a sheet on a table from
  eight views and runs the detector on each screenshot.
- Show anchor: `scripts/experiments/anchor-panel-check.ts` opens the
  panel at five phone and tablet sizes, confirms the picture came from
  R2, and runs the detector on each screen capture.
- Geometry: unit tests, including two phones on opposite sides of a table
  arriving at the same frame.

What is **not** verified, and needs a phone:

1. That Chrome grants `camera-access` beside `dom-overlay`, `hit-test`
   and `anchors` in one session.
2. The camera texture's row order. The code tries both and keeps the one
   that decodes, so either answer should work.
3. That reading the camera frame back a few times a second does not
   disturb the renderer.
4. Accuracy: how far apart two phones put the sphere.

### Phase 1 test procedure

1. Print `ayni-xr-anchor.svg` (any size from about 10 cm) or open it on a
   tablet at full brightness, and lay it flat on a table.
2. On an Android phone open the site with `?marker=1&vrDebug=1` and enter
   AR. Accept the camera prompt.
3. Tap **Scan marker** and point the phone at the marker from 40 to 80 cm.
4. The hint should go from "Point the phone at the marker" to "Marker
   found. Hold still" to "Aligned to the marker", and the sphere should
   jump to float above the marker.
5. Read `side=` on the debug panel and compare it with a ruler across the
   black frame.
6. Repeat on a second phone. Both should show the sphere in the same
   spot, with the same continent facing the marker's bottom edge.

### Phase 2 and 3: the room and what it shares (built)

A page opened with `?room=CODE` is in a shared session. The anchor
screen shows a QR code for that address beside the marker, so the way in
is: scan the small code with the phone's camera, enter AR, scan the large
one.

| Piece | Where |
|---|---|
| The room: who leads, relaying the lead's state | `workers/rooms` (Durable Object `Room`, Worker `ayni-rooms`) |
| The door to it | `functions/api/room/[code].ts`, binding `ROOMS` |
| Messages and their validation | `src/services/roomProtocol.ts` |
| The socket, reconnecting | `src/services/roomClient.ts` |
| Leading and following | `src/services/roomSync.ts` |
| The sphere's pose in the marker's frame | `vrSession.ts` (`getRoomGlobe`, `setFollowedRoomGlobe`) |
| "You lead" / "following" | `src/ui/roomChip.ts` |
| The join QR | `src/ui/anchorPanel.ts` |

- **Who leads:** the device that has been in the room longest. When it
  leaves, the next longest takes over. The anchor's own screen does not
  join. Handing the lead to a chosen person is not built.
- **What travels:** the dataset's id, the playhead (paused, time,
  duration, rate), the layer stack (basemap, overlays and their tint,
  the real-time overlay), the browser globe's camera (centre, zoom,
  bearing, pitch) and, in AR, the sphere's orientation and scale. So a
  room works with no AR at all, on any device with a browser. The
  orientation is given in the marker's frame when the lead scanned the
  marker, so a follower who scanned the same marker sees the same side of
  the sphere from where they stand. Each device loads and decodes the
  dataset itself; a room costs a few hundred bytes a second.
- **Followers are not locked.** Whatever a follower changes is put back
  by the lead's next message, at most a second later.
- **Not shared yet:** the colour palette and range of a data-encoded
  dataset, the labels / borders / terrain toggles, the 1/2/4-globe
  layout, tours and the Orbit chat.
- **A Quest can join** a room as lead or follower for the dataset and
  playhead; without a marker scan its sphere is its own.

The room Worker is deployed by hand, before any site deploy that binds
it: `npx wrangler deploy --config workers/rooms/wrangler.toml`.

Verified with `scripts/experiments/room-sync-check.ts`: two browser
pages against a local room — roles, the follower loading the lead's
dataset, playing in step, pause and seek followed, the camera following
a drag, a layer switched on the lead appearing on the follower, and
succession when the lead leaves. The sphere's orientation between two phones needs
phones.

### Phase 4: headsets and fallbacks

- **Headsets:** two taps with the controller on two marked corners of the
  same sheet give the same frame without a camera.
- **No marker:** each person places their own sphere, with the content
  still in step.
- **Re-align:** scanning again at any time replaces the frame, for a
  bumped marker or a device that has drifted.

## Open questions

1. Is the join QR precise enough to be the marker itself? One printed
   thing to scan would be simpler than two. Phase 1's numbers decide.
2. How is the realtime stream quota keyed? A room of ten is ten viewers.
3. How much drift accumulates over a twenty-minute session, and does the
   scan need to repeat by itself?
