# 2026 Virtual SOS Workshop — Presentation Proposal

> **Status:** draft for review · **Submission deadline:** June 5, 2026
> **Workshop:** 2026 SOS Users Collaborative Network Virtual Workshop
> (Mon–Wed, Aug 24–26, 2026, 2:00–5:00 PM Eastern)
> **Theme:** *Spheres of Impact: Technology, Education, and Community for Common Ground*
> **Proposed format:** 25-minute Breakout session / small-group discussion
> (≈18 min demo + ≈7 min hands-on discussion)
> **Submitting account:** eric.j.hackathorn@noaa.gov

This document holds the answers to paste into the Google Form, followed
by the supporting session plan. Each form field is reproduced verbatim
with its constraints so the answer can be copied directly.

---

## Form answers (copy-paste ready)

### Presentation title *

> **TerraViz: A Science On a Sphere in Every Pocket — AI-Guided, Offline-Ready, and Yours to Self-Host**

_Alternates if a shorter title is preferred:_

- *Same Data, No Museum Required: Taking the SOS Catalog to Web, Desktop, and VR*
- *Meet Orbit: An AI Docent for the SOS Catalog*

### Presentation description *

> _Please write a brief description of your presentation and the audience
> it targets. If selected, this description will appear in the workshop
> program. (1600 character limit, ~200 words.)_

TerraViz brings the Science On a Sphere catalog to any device — phone,
laptop, museum kiosk, or VR headset — with no sphere required. Live at
terraviz.zyra-project.org and free to install on Windows, macOS, and
Linux, it streams the same SOS datasets you already know onto an
interactive WebGL globe.

This hands-on breakout demonstrates three things SOS sites have asked
for. First, Orbit, an AI digital docent: visitors simply ask a question,
and Orbit explains the science and loads the dataset by conversation —
with an optional local LLM so it runs fully offline at no cloud cost.
Second, multi-globe comparison and guided tours that turn SOS data into
classroom and kiosk narratives. Third, offline desktop use and
self-hosting, so any site can put its own data on the globe.

Open the app on your own phone and follow along. We'll close with a group
discussion on where AI helps — or gets in the way — in SOS exhibits, and
what you'd put on a globe of your own. Aimed at SOS site operators,
educators, and anyone curious about extending SOS beyond the sphere room.

### What format do you plan to use for this talk?

> _(i.e. PowerPoint, live SOS theater, or pre-recorded video, etc.)_

Live, screen-shared demo of the TerraViz web app (terraviz.zyra-project.org),
with attendees invited to open it on their own devices and follow along.
A short pre-recorded backup clip of the Orbit AI docent and a multi-globe
tour will be on hand in case of connectivity issues. No slides required,
though a one-slide title/links card will be shown at the start and end.
Optionally a Meta Quest headset for a brief VR/AR cameo if the platform
allows. The session closes with a live, poll-prompted group discussion.

### Is there anything else you would like to tell us about your presentation?

TerraViz is open source (Apache 2.0) and already live and in public use,
so this is a working tool rather than a concept. It directly addresses
this year's AI-in-the-catalog goal with a shipping example (the Orbit
docent), and the self-hosting model invites SOS sites to publish their
own data — a concrete path to the community/belonging objective. The core
demo is browser-only and needs nothing more than screen share with audio
and a stable connection; everything else (VR, desktop) is optional. Happy
to be reformatted as a lightning talk or 15-minute SOS Showcase if that
fits the program better.

### Do you have co-presenters? *

> _Select Yes if you have already confirmed a list of co-presenters._

**No** — _(change to **Yes** and list collaborators if any are confirmed
before submission; one proposal per presentation)._

---

## Supporting material (not submitted — for our own prep)

### Run of show (~25 min)

| Time | Segment | What happens |
|---|---|---|
| 0:00–1:30 | Hook | Open terraviz.zyra-project.org live; invite attendees to open it too. "Same SOS data, no sphere required." |
| 1:30–7:00 | Orbit, the AI docent | Ask Orbit a question; it explains the science and loads the dataset onto the globe. Note the offline/local-LLM option. |
| 7:00–12:00 | Multi-globe + tours | 2/4 synced globes; run the Climate Futures tour (SSP1 vs. SSP5) as a storytelling example. |
| 12:00–16:00 | Offline desktop + self-hosting | Offline downloads for low-connectivity sites; "NOAA's catalog is the seed, not the ceiling." |
| 16:00–18:00 | (Optional) VR/AR cameo | Globe at human scale on a headset, if available. |
| 18:00–25:00 | Polls + group discussion | See interactivity plan below. |

### Interactivity plan (required by the form)

- **Hands-on, live:** attendees open the URL on their own phones/laptops,
  load a dataset, then ask Orbit a question and watch it load data by
  conversation.
- **Polls (1–2 quick questions):** e.g. *"Does your site have reliable
  internet for visitor-facing tools?"* and *"Would an AI guide help or
  worry you?"* — used to steer the discussion.
- **Group discussion (final ~7 min):** *What would you put on the globe
  if you could self-host? Where does AI help vs. get in the way in your
  exhibits?*

### How the session maps to the workshop goals

| Workshop goal | How the session delivers |
|---|---|
| Showcase the versatility of SOS technology | Same SOS datasets on web, desktop, mobile, and VR/AR |
| Tools & resources for understanding SOS data | Orbit explains datasets conversationally; multi-globe enables side-by-side comparison |
| **AI in catalog / interactive exhibit / education** | Orbit (hybrid local + LLM docent) is a live, production example |
| Educational & technical training | Walkthrough plus a path to self-host an instance |
| Sense of belonging / community | Open source; community translations; self-hosting invites sites to participate, not just consume |
| Inform future NOAA direction | Demonstrates a federation model for extending the SOS catalog |

### A/V & tech needs

- Screen share **with audio** (for an HLS video dataset).
- Stable internet connection (pre-recorded backup clip mitigates risk).
- Optional: a Meta Quest headset for the VR/AR cameo.

### Reference links

| Resource | URL |
|---|---|
| Live web app | https://terraviz.zyra-project.org |
| Interactive poster | https://poster.terraviz.zyra-project.org |
| Source code | https://github.com/zyra-project/terraviz |
| DOI (citation) | https://doi.org/10.5281/zenodo.20043181 |

---

## Follow-up idea: a separate poster-style capture of this session

After the workshop we may turn this presentation — plus any feedback,
polls, and discussion captured during the breakout — into its own
**separate** poster-style page. This would be a distinct presentation,
*not* added to the existing interactive poster (`poster/`). It would
borrow the same build approach as a reference — the existing poster is
built by `poster/scripts/build_poster.py` from section fragments under
`poster/sections/` (see [`docs/POSTER_PLAN.md`](POSTER_PLAN.md)) — but
live in its own directory with its own sections and assets.

Sketch of what that separate capture page could include:

- The proposal abstract and run-of-show above.
- A short results section: poll outcomes, notable questions, and themes
  from the group discussion.
- Embedded screenshots / the WebXR `.glb` model already used by the poster.
- Links back to the live app and the recorded session, if one exists.

This is a **future**, **standalone** deliverable, scoped here only so the
intent isn't lost. Build it after Aug 26, 2026, once feedback exists to
capture — as its own poster/presentation, separate from `poster/`.
