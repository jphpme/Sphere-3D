// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Playback controls: play/pause, scrubbing, step, rewind, captions, and the playback loop.
 *
 * Extracted from InteractiveSphere to isolate video playback concerns.
 */

import type { HLSService } from '../services/hlsService'
import type { AppState, Dataset } from '../types'
import { logger } from '../utils/logger'
import { proxyCaptionUrl } from '../utils/captionProxy'
import { t } from '../i18n'
import { reportError } from '../analytics'
import { updateMapControlsPosition } from './mapControlsUI'

// --- Playback constants ---
/**
 * How long a dataset rests on its last frame before it starts again.
 * The owner's rule (2026-09-30, the same in the desktop apps): every
 * loop holds the last frame for 4 s; a playlist's own timing and the
 * change from one dataset to the next are not loops and keep theirs.
 */
export const LOOP_END_HOLD_MS = 4000
const VIDEO_END_THRESHOLD = 0.05
const SCRUBBER_MAX = 1000
const DEFAULT_FRAME_STEP = 1 / 30
const PLAY_START_STALL_CHECK_MS = 700
const PLAY_START_STALL_EPSILON = 0.03
const PLAY_START_NUDGE_SECONDS = 0.25

export interface PlaybackState {
  playbackUpdateId: number | null
  scrubbing: boolean
  captionTrack: TextTrack | null
  displayInterval: { intervalMs: number; showTime: boolean } | null
  loopPauseTimer: ReturnType<typeof setTimeout> | null
  /** The element the loop-end listeners are on, so they come off with the loop. */
  loopEndTarget: { video: HTMLVideoElement; onEnd: () => void } | null
}

/** Create a fresh playback state with all fields at their defaults. */
export function createPlaybackState(): PlaybackState {
  return {
    playbackUpdateId: null,
    scrubbing: false,
    captionTrack: null,
    displayInterval: null,
    loopPauseTimer: null,
    loopEndTarget: null,
  }
}

/**
 * The end of a loop: hold the last frame for `LOOP_END_HOLD_MS`, then
 * start again from the beginning. Reached from the element's own
 * `timeupdate` and `ended` events as well as the rAF loop, because a
 * headset session stops the page's animation frames and a dataset
 * would otherwise end there and stay ended. The transport still reads
 * "playing" through the hold: nobody pressed pause.
 */
function checkLoopEnd(state: PlaybackState, hlsService: HLSService, appState: AppState): void {
  const video = hlsService.getVideo()
  if (!video || state.loopPauseTimer || !appState.isPlaying) return
  if (!(video.duration > 0)) return
  const atEnd = video.ended || (!video.paused && video.currentTime >= video.duration - VIDEO_END_THRESHOLD)
  if (!atEnd) return
  video.pause()
  state.loopPauseTimer = setTimeout(() => {
    state.loopPauseTimer = null
    // Still at the end, still playing: anything else was the user's doing.
    const current = hlsService.getVideo()
    if (!current || !appState.isPlaying) return
    if (!current.ended && current.currentTime < current.duration - VIDEO_END_THRESHOLD) return
    current.currentTime = 0
    current.play().catch(() => {})
  }, LOOP_END_HOLD_MS)
}

/** True while the dataset rests on its last frame between loops. */
export function isHoldingLoopEnd(state: PlaybackState): boolean {
  return state.loopPauseTimer !== null
}

/**
 * A user action during the hold — a pause, a seek, a step — takes the
 * hold off: the next play starts from wherever the user left it (the
 * start, after a pause at the end), not from the hold's restart.
 */
export function cancelLoopHold(state: PlaybackState): boolean {
  if (!state.loopPauseTimer) return false
  clearTimeout(state.loopPauseTimer)
  state.loopPauseTimer = null
  return true
}

// --- Playback loop ---

/** Start a requestAnimationFrame loop that updates the scrubber, time label, and handles auto-looping. */
export function startPlaybackLoop(
  state: PlaybackState,
  hlsService: HLSService | null,
  videoTexture: { needsUpdate: boolean } | null,
  appState: AppState,
  updateVideoTimeLabel: (time: number) => void,
  triggerRepaint?: () => void,
  onTick?: () => void,
): void {
  stopPlaybackLoop(state)

  const endVideo = hlsService?.getVideo() ?? null
  if (hlsService && endVideo) {
    const onEnd = () => checkLoopEnd(state, hlsService, appState)
    endVideo.addEventListener('timeupdate', onEnd)
    endVideo.addEventListener('ended', onEnd)
    state.loopEndTarget = { video: endVideo, onEnd }
  }

  const loop = () => {
    // Fires every frame regardless of primary play/pause state. Used
    // by multi-viewport sync to keep sibling panels locked to the
    // primary's date; self-guards when there is nothing to correct.
    // Isolated so a transient throw (e.g. a null access during panel
    // teardown) can't abort the loop before the next rAF is scheduled —
    // that would silently freeze the scrubber, time label, and auto-loop.
    if (onTick) {
      try {
        onTick()
      } catch (e) {
        logger.warn('[App] Playback onTick failed:', e)
      }
    }

    if (hlsService) {
      const video = hlsService.getVideo()
      if (video && video.readyState >= 2) {
        if (state.scrubbing && videoTexture) {
          videoTexture.needsUpdate = true
          state.scrubbing = false
        }

        // The loop's end: hold the last frame, then start again.
        checkLoopEnd(state, hlsService, appState)

        const scrubber = document.getElementById('scrubber') as HTMLInputElement
        if (scrubber && !scrubber.matches(':active')) {
          const fraction = video.duration > 0 ? video.currentTime / video.duration : 0
          scrubber.value = String(Math.round(fraction * SCRUBBER_MAX))
        }

        updateVideoTimeLabel(video.currentTime)

        // Force MapLibre to re-render while video is playing so the
        // globe texture updates with each new video frame.
        if (!video.paused && triggerRepaint) {
          triggerRepaint()
        }
      }
    }

    state.playbackUpdateId = requestAnimationFrame(loop)
  }

  state.playbackUpdateId = requestAnimationFrame(loop)
}

/** Cancel the running playback animation frame loop. */
export function stopPlaybackLoop(state: PlaybackState): void {
  if (state.playbackUpdateId !== null) {
    cancelAnimationFrame(state.playbackUpdateId)
    state.playbackUpdateId = null
  }
  if (state.loopEndTarget) {
    const { video, onEnd } = state.loopEndTarget
    video.removeEventListener('timeupdate', onEnd)
    video.removeEventListener('ended', onEnd)
    state.loopEndTarget = null
  }
}

// --- Transport controls ---

/** Toggle between play and pause, updating the button icon and app state. */
export function togglePlayPause(
  hlsService: HLSService | null,
  appState: AppState,
  announce: (msg: string) => void,
  state?: PlaybackState,
): void {
  if (!hlsService) return

  // Resting on the last frame between loops still counts as playing:
  // the press is a pause, and it leaves the dataset on that frame.
  if (state && cancelLoopHold(state)) {
    appState.isPlaying = false
    updatePlayButton(true)
    announce(t('playback.announce.paused'))
    return
  }

  if (hlsService.paused) {
    // Paused on the last frame: play starts over, not one frame of the end.
    const video = hlsService.getVideo()
    if (video && video.duration > 0 && (video.ended || video.currentTime >= video.duration - VIDEO_END_THRESHOLD)) {
      video.currentTime = 0
    }
    hlsService.play()?.catch(e => {
      logger.warn('[App] Play failed:', e)
    })
    recoverPlaybackIfStalledAtStart(hlsService)
    appState.isPlaying = true
  } else {
    hlsService.pause()
    appState.isPlaying = false
  }
  updatePlayButton(hlsService.paused)
  announce(t(hlsService.paused ? 'playback.announce.paused' : 'playback.announce.started'))
}

/**
 * Some generated DASH timelines do not start advancing from exactly
 * t=0 until the user performs a seek. Mirror that user action with a
 * tiny automatic nudge, but only when playback is genuinely stuck at
 * the beginning after the play gesture.
 */
function recoverPlaybackIfStalledAtStart(hlsService: HLSService): void {
  const video = hlsService.getVideo()
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return

  const startedAt = video.currentTime
  if (startedAt > PLAY_START_NUDGE_SECONDS) return

  window.setTimeout(() => {
    const currentVideo = hlsService.getVideo()
    if (
      !currentVideo ||
      currentVideo.paused ||
      !Number.isFinite(currentVideo.duration) ||
      currentVideo.duration <= 0
    ) {
      return
    }

    if (currentVideo.currentTime > startedAt + PLAY_START_STALL_EPSILON) return

    const maxSeek = Math.max(0, currentVideo.duration - VIDEO_END_THRESHOLD)
    const target = Math.min(PLAY_START_NUDGE_SECONDS, maxSeek)
    if (target <= currentVideo.currentTime) return

    logger.debug('[App] Playback stalled at start; nudging playhead:', {
      from: currentVideo.currentTime,
      to: target,
    })
    currentVideo.currentTime = target
    hlsService.play()?.catch(e => {
      logger.warn('[App] Play recovery failed:', e)
    })
  }, PLAY_START_STALL_CHECK_MS)
}

/** Seek to the beginning of the video and pause playback. */
export function rewind(
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  cancelLoopHold(state)
  hlsService.currentTime = 0
  hlsService.pause()
  appState.isPlaying = false
  updatePlayButton(true)
  announce(t('playback.announce.paused'))
  state.scrubbing = true
}

/** Seek to the end of the video and pause playback. */
export function fastForward(
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  cancelLoopHold(state)
  const video = hlsService.getVideo()
  if (video && video.duration) {
    video.currentTime = Math.max(0, video.duration - VIDEO_END_THRESHOLD)
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
    announce(t('playback.announce.paused'))
    state.scrubbing = true
  }
}

/** Step one display interval forward or backward, pausing if currently playing. */
export function stepFrame(
  direction: 1 | -1,
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  const video = hlsService.getVideo()
  if (!video || !video.duration) return

  if (!video.paused || cancelLoopHold(state)) {
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
    announce(t('playback.announce.paused'))
  }

  let step: number
  const dataset = appState.currentDataset
  if (state.displayInterval && dataset?.startTime && dataset?.endTime) {
    const totalMs = new Date(dataset.endTime).getTime() - new Date(dataset.startTime).getTime()
    step = (state.displayInterval.intervalMs / totalMs) * video.duration
  } else {
    step = DEFAULT_FRAME_STEP
  }

  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction * step))
  state.scrubbing = true
}

/** Handle scrubber input by seeking the video to the corresponding position. */
export function onScrub(
  value: number,
  hlsService: HLSService | null,
  state: PlaybackState,
  appState?: AppState,
): void {
  if (!hlsService) return
  const fraction = value / SCRUBBER_MAX
  const video = hlsService.getVideo()
  if (video && video.duration) {
    video.currentTime = fraction * video.duration
    state.scrubbing = true
    // A scrub during the hold plays on from where it landed.
    if (cancelLoopHold(state) && appState?.isPlaying) video.play().catch(() => {})
  }
}

/** Update the play/pause button icon and ARIA label to reflect the current state. */
export function updatePlayButton(paused: boolean): void {
  const playBtn = document.getElementById('play-btn')
  if (playBtn) {
    playBtn.textContent = paused ? '\u25B6\uFE0E' : '\u23F8\uFE0E'
    playBtn.setAttribute('aria-label', t(paused ? 'playback.play.aria' : 'playback.pause.aria'))
  }
}

// --- Captions ---

/** Toggle closed-caption track visibility and update the CC button style. */
export function toggleCaptions(state: PlaybackState): void {
  if (!state.captionTrack) return
  const ccBtn = document.getElementById('cc-btn')
  const overlay = document.getElementById('caption-overlay')
  const turning = state.captionTrack.mode !== 'showing'
  state.captionTrack.mode = turning ? 'showing' : 'hidden'
  if (ccBtn) {
    ccBtn.style.color = turning ? 'var(--color-accent)' : ''
    ccBtn.style.borderColor = turning ? 'var(--color-accent)' : ''
  }
  if (!turning && overlay) {
    overlay.textContent = ''
    overlay.style.display = 'none'
  }
}

/** Fetch an SRT caption file, parse it, and attach cues to the video element. */
export async function loadCaptions(
  video: HTMLVideoElement,
  captionUrl: string,
  state: PlaybackState,
): Promise<void> {
  try {
    const fetchUrl = proxyCaptionUrl(captionUrl)

    const response = await fetch(fetchUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const srt = await response.text()

    const cues = parseSRT(srt)
    if (cues.length === 0) {
      logger.warn('[App] Caption file contained no parseable cues')
      return
    }

    // Third arg is the LANGUAGE OF THE CAPTIONS themselves (BCP-47),
    // not the UI language — SOS captions are English regardless of the
    // viewer's locale, so this stays 'en'. Only the human-readable
    // label routes through t().
    const track = video.addTextTrack('captions', t('playback.captions.label'), 'en')
    track.mode = 'hidden'
    for (const cue of cues) {
      track.addCue(new VTTCue(cue.start, cue.end, cue.text))
    }

    track.addEventListener('cuechange', () => {
      const overlay = document.getElementById('caption-overlay')
      if (!overlay) return
      const activeCues = track.activeCues
      if (!activeCues || activeCues.length === 0 || track.mode !== 'showing') {
        overlay.textContent = ''
        overlay.style.display = 'none'
      } else {
        overlay.textContent = Array.from(activeCues).map(c => (c as VTTCue).text).join('\n')
        overlay.style.display = 'block'
      }
    })

    state.captionTrack = track

    const ccBtn = document.getElementById('cc-btn')
    if (ccBtn) ccBtn.classList.remove('hidden')

    logger.info(`[App] Loaded ${cues.length} caption cues`)
  } catch (error) {
    // Surface the failure to telemetry (Tier A) so we can measure
    // how often the Vimeo caption proxy fails — silent today, was
    // indistinguishable from "this dataset has no captions". The
    // info panel's "Captions available" badge remains visible on
    // failure so the user still knows captions exist for this row.
    // See `docs/WEB_CATALOG_FEATURES_PLAN.md` §5.2.
    logger.warn('[App] Failed to load captions:', error)
    reportError('caption', error)
  }
}

function parseSRT(srt: string): Array<{ start: number; end: number; text: string }> {
  const cues: Array<{ start: number; end: number; text: string }> = []
  const blocks = srt.trim().split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/)
    let timingIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { timingIdx = i; break }
    }
    if (timingIdx < 0) continue
    const parts = lines[timingIdx].split('-->')
    if (parts.length !== 2) continue
    const start = parseSRTTime(parts[0].trim())
    const end = parseSRTTime(parts[1].trim())
    const text = lines.slice(timingIdx + 1).join('\n').trim()
    if (text) cues.push({ start, end, text })
  }
  return cues
}

function parseSRTTime(t: string): number {
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000
}

// --- Time seeking ---

/**
 * Validate a setTime request without performing the seek. Used by
 * the chat panel to surface failures inline the moment a set-time
 * action streams in (instead of waiting for the deferred execution
 * after a load click). Same set of failure conditions as
 * {@link seekToDate}, side-effect-free — the success path doesn't
 * touch `video.currentTime` or pause playback. Reuses the same
 * translated error keys so the inline-on-stream copy and the
 * post-execution announce stay consistent.
 */
export function checkSeekToDate(
  isoDate: string,
  hlsService: HLSService | null,
  appState: AppState,
): { ok: true } | { ok: false; message: string } {
  if (!hlsService) {
    return { ok: false, message: t('playback.error.noVideoDataset') }
  }
  const video = hlsService.getVideo()
  if (!video || !video.duration) {
    return { ok: false, message: t('playback.error.videoNotReady') }
  }
  const dataset = appState.currentDataset
  if (!dataset?.startTime || !dataset?.endTime) {
    return { ok: false, message: t('playback.error.noTimeRange') }
  }
  const targetDate = new Date(isoDate)
  if (isNaN(targetDate.getTime())) {
    return { ok: false, message: t('playback.error.invalidDate') }
  }
  const start = new Date(dataset.startTime).getTime()
  const end = new Date(dataset.endTime).getTime()
  const totalMs = end - start
  if (totalMs <= 0) {
    return { ok: false, message: t('playback.error.invalidTimeRange') }
  }
  const targetMs = targetDate.getTime()
  if (targetMs < start || targetMs > end) {
    const startStr = dataset.startTime!.split('T')[0]
    const endStr = dataset.endTime!.split('T')[0]
    return {
      ok: false,
      message: t('playback.error.dateOutsideRange', { date: isoDate, start: startStr, end: endStr }),
    }
  }
  return { ok: true }
}

/**
 * Seek a video dataset to a specific date within its time range.
 * Returns a result indicating success/failure with a human-readable message.
 */
export function seekToDate(
  isoDate: string,
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
): { success: boolean; message: string } {
  if (!hlsService) {
    return { success: false, message: t('playback.error.noVideoDataset') }
  }

  const video = hlsService.getVideo()
  if (!video || !video.duration) {
    return { success: false, message: t('playback.error.videoNotReady') }
  }

  const dataset = appState.currentDataset
  if (!dataset?.startTime || !dataset?.endTime) {
    return { success: false, message: t('playback.error.noTimeRange') }
  }

  const targetDate = new Date(isoDate)
  if (isNaN(targetDate.getTime())) {
    return { success: false, message: t('playback.error.invalidDate') }
  }

  const start = new Date(dataset.startTime).getTime()
  const end = new Date(dataset.endTime).getTime()
  const totalMs = end - start
  if (totalMs <= 0) {
    return { success: false, message: t('playback.error.invalidTimeRange') }
  }

  // Check if date falls outside the dataset's time range
  const targetMs = targetDate.getTime()
  if (targetMs < start || targetMs > end) {
    const startStr = dataset.startTime!.split('T')[0]
    const endStr = dataset.endTime!.split('T')[0]
    return {
      success: false,
      message: t('playback.error.dateOutsideRange', { date: isoDate, start: startStr, end: endStr }),
    }
  }

  const fraction = (targetMs - start) / totalMs

  video.currentTime = fraction * video.duration
  state.scrubbing = true

  // Pause if playing so user can inspect the moment
  if (!video.paused || cancelLoopHold(state)) {
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
  }

  return { success: true, message: t('playback.seekingTo', { date: isoDate }) }
}

// --- Info panel positioning ---

/**
 * Whether the transport, once it has stepped aside for the browse panel
 * (`--panel-push-bar`, set by globePanelOffset.ts), lands on the info
 * panel in the other bottom corner. Measured from where it will rest,
 * not where it is mid-slide.
 */
export function transportMeetsInfoPanel(
  controls: { left: number; right: number },
  slid: number,
  push: number,
  info: { left: number; right: number },
  gap: number,
): boolean {
  const left = controls.left - slid + push
  const right = controls.right - slid + push
  return left < info.right + gap && right > info.left - gap
}

/**
 * Observe the info panel and shift #playback-controls up over it where
 * the two would otherwise share the bottom edge: on portrait mobile
 * (≤600px width) while the panel is expanded, and on a desktop window
 * too narrow to hold both side by side once the browse panel has pushed
 * the transport over.
 */
export function initPlaybackPositioning(): void {
  const infoPanel = document.getElementById('info-panel')
  if (!infoPanel || typeof ResizeObserver === 'undefined') return

  const update = () => {
    const controls = document.getElementById('playback-controls')
    if (!controls) return
    const isPortraitMobile = window.innerWidth <= 600
      && window.matchMedia('(orientation: portrait)').matches
    const info = infoPanel.getBoundingClientRect()
    const infoShown = !infoPanel.classList.contains('hidden') && info.width > 0
    const push = parseFloat(document.documentElement.style.getPropertyValue('--panel-push-bar')) || 0
    const box = controls.getBoundingClientRect()
    const slid = parseFloat(getComputedStyle(controls).translate ?? '') || 0
    const pushedOnto = push !== 0 && infoShown && box.width > 0
      && transportMeetsInfoPanel(box, slid, push, info, 8)
    const next = (infoPanel.classList.contains('expanded') && isPortraitMobile) || pushedOnto
      ? `${Math.round(info.height) + 12}px`
      : '0.75rem'
    if (controls.style.bottom === next) return
    controls.style.bottom = next
    // The Tools bar rests on the transport, wherever that now is.
    updateMapControlsPosition()
  }

  new ResizeObserver(update).observe(infoPanel)
  // The push is a custom property on the root; the info panel is shown
  // and hidden by class.
  const changes = new MutationObserver(update)
  changes.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  changes.observe(infoPanel, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('resize', update)
}

// --- Playback state reset ---

/** Reset playback state, clear the loop timer, hide captions, and reset the CC button. */
export function resetPlaybackState(state: PlaybackState): void {
  state.displayInterval = null
  if (state.loopPauseTimer) {
    clearTimeout(state.loopPauseTimer)
    state.loopPauseTimer = null
  }
  state.captionTrack = null
  const ccBtn = document.getElementById('cc-btn')
  if (ccBtn) {
    ccBtn.classList.add('hidden')
    ccBtn.style.color = ''
    ccBtn.style.borderColor = ''
  }
  const overlay = document.getElementById('caption-overlay')
  if (overlay) {
    overlay.textContent = ''
    overlay.style.display = 'none'
  }
}
