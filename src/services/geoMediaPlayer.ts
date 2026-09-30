// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
/**
 * AYNI — plays one geo-media marker at a time: a radio station through
 * an `<audio>`, a video cam through a `<video>` (hls.js where the
 * browser has no HLS of its own), a snapshot cam through an `<img>`
 * that a poller keeps fresh. It owns the three elements and nothing of
 * the page: the panel on the browser globe and the one in the headset
 * both show these same elements.
 */
import Hls from 'hls.js'
import { logger } from '../utils/logger'
import { isHlsUrl, snapshotRefreshSeconds, type GeoMediaMarker } from './geoMedia'
import { SnapshotCamPoller } from './geoMediaSnapshotPoller'

export type GeoMediaPhase = 'idle' | 'connecting' | 'playing' | 'paused' | 'unavailable'

export interface GeoMediaPlayback {
  readonly marker: GeoMediaMarker | null
  readonly phase: GeoMediaPhase
}

/**
 * A stream that has produced nothing after this long is taken as off
 * the air. A feed whose server still hands out its master playlist
 * keeps hls.js retrying for about a minute before it gives up, and a
 * radio host that accepts the connection and sends nothing never does.
 */
export const GEO_MEDIA_START_TIMEOUT_MS = 15_000

export interface GeoMediaPlayerOptions {
  onChange(playback: GeoMediaPlayback): void
  startTimeoutMs?: number
  /** Tests stand in for the snapshot fetches. */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const IDLE: GeoMediaPlayback = { marker: null, phase: 'idle' }

export class GeoMediaPlayer {
  readonly audio: HTMLAudioElement
  readonly video: HTMLVideoElement
  readonly image: HTMLImageElement
  private hls: Hls | null = null
  private poller: SnapshotCamPoller | null = null
  private pictureUrl: string | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  // Bumped by every play and stop, so a start that was superseded while
  // it was still connecting cannot report on the stream that replaced it.
  private generation = 0
  private state: GeoMediaPlayback = IDLE
  private readonly unavailable = new Set<string>()
  private readonly startTimeoutMs: number

  constructor(private readonly options: GeoMediaPlayerOptions) {
    this.startTimeoutMs = options.startTimeoutMs ?? GEO_MEDIA_START_TIMEOUT_MS
    this.audio = document.createElement('audio')
    this.audio.preload = 'none'
    this.video = document.createElement('video')
    this.video.preload = 'none'
    this.video.playsInline = true
    // The headset draws the cam as a WebGL texture, which a frame
    // fetched without CORS would taint.
    this.video.crossOrigin = 'anonymous'
    this.image = document.createElement('img')
    this.image.alt = ''
    for (const element of [this.audio, this.video]) {
      element.addEventListener('playing', () => this.onElementPlaying(element))
      element.addEventListener('waiting', () => this.onElementWaiting(element))
      element.addEventListener('error', () => this.onElementError(element))
      element.addEventListener('ended', () => { if (this.activeElement() === element) this.stop() })
    }
  }

  get playback(): GeoMediaPlayback {
    return this.state
  }

  /** True once a marker failed to play in this visit, or stopped answering. */
  isUnavailable(markerId: string): boolean {
    return this.unavailable.has(markerId)
  }

  get muted(): boolean {
    return this.audio.muted
  }

  setMuted(muted: boolean): void {
    this.audio.muted = muted
    this.video.muted = muted
  }

  /**
   * Start a marker, replacing whatever was on. Must be reached from the
   * user's own tap or click for the browser to allow sound.
   */
  play(marker: GeoMediaMarker): void {
    const generation = ++this.generation
    this.reset()
    this.unavailable.delete(marker.id)
    this.setState({ marker, phase: 'connecting' })
    logger.info(`[GeoMedia] playing ${marker.id} as ${marker.kind}`)

    if (marker.kind === 'image') {
      this.startSnapshots(marker, generation)
      return
    }
    const element = marker.kind === 'video' ? this.video : this.audio
    try {
      if (isHlsUrl(marker.streamUrl) && Hls.isSupported()) {
        const hls = new Hls()
        this.hls = hls
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal && generation === this.generation) this.fail(`hls-${data.type || 'fatal'}`)
        })
        hls.loadSource(marker.streamUrl)
        hls.attachMedia(element)
      } else {
        // A plain stream, or an HLS one on a browser that plays HLS itself.
        element.src = marker.streamUrl
      }
    } catch (error) {
      this.fail(`attach-failed:${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.armStartTimer(generation)
    void element.play().catch((error: unknown) => {
      // A newer play or a stop interrupts this one; that is not a failure.
      if (generation !== this.generation) return
      this.fail(`play-failed:${error instanceof Error ? error.name : String(error)}`)
    })
  }

  /** Hold the current marker: sound stops, a snapshot cam keeps its last picture. */
  pause(): void {
    const { marker, phase } = this.state
    if (!marker || (phase !== 'playing' && phase !== 'connecting')) return
    // The start this interrupts must not be reported as a failed one.
    this.generation += 1
    this.clearStartTimer()
    if (marker.kind === 'image') {
      this.poller?.pause()
    } else if (marker.kind === 'audio') {
      // Nothing to keep on screen, so the connection is dropped too.
      this.reset()
    } else {
      // The last frame stays up; the stream stops downloading behind it.
      this.video.pause()
      this.hls?.stopLoad()
    }
    this.setState({ marker, phase: 'paused' })
  }

  /**
   * Pick a held marker up again. A live stream is joined afresh instead
   * of continued from where it stopped: what it was saying then is gone.
   */
  resume(): void {
    const { marker, phase } = this.state
    if (!marker || phase !== 'paused') return
    if (marker.kind === 'image' && this.poller) {
      this.poller.resume()
      this.setState({ marker, phase: 'playing' })
      return
    }
    this.play(marker)
  }

  /** End playback and forget the marker. */
  stop(): void {
    this.generation += 1
    this.reset()
    this.setState(IDLE)
  }

  dispose(): void {
    this.generation += 1
    this.reset()
    this.state = IDLE
  }

  private activeElement(): HTMLMediaElement | null {
    const kind = this.state.marker?.kind
    return kind === 'video' ? this.video : kind === 'audio' ? this.audio : null
  }

  private setState(next: GeoMediaPlayback): void {
    this.state = next
    this.options.onChange(next)
  }

  private startSnapshots(marker: GeoMediaMarker, generation: number): void {
    const poller = new SnapshotCamPoller({
      url: marker.streamUrl,
      refreshSeconds: marker.refreshSeconds ?? snapshotRefreshSeconds(undefined),
      onFrame: picture => {
        if (this.poller === poller) this.showPicture(picture)
      },
      onFailure: reason => {
        if (this.poller === poller) this.fail(reason)
      },
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    })
    this.poller = poller
    poller.start().then(
      () => {
        if (generation !== this.generation || this.state.phase !== 'connecting') return
        this.setState({ marker, phase: 'playing' })
      },
      (error: unknown) => {
        if (generation !== this.generation) return
        this.fail(error instanceof Error ? error.message : String(error))
      },
    )
  }

  private showPicture(picture: Blob): void {
    const previous = this.pictureUrl
    this.pictureUrl = URL.createObjectURL(picture)
    this.image.src = this.pictureUrl
    if (previous) URL.revokeObjectURL(previous)
  }

  private onElementPlaying(element: HTMLMediaElement): void {
    const { marker, phase } = this.state
    if (!marker || this.activeElement() !== element || phase !== 'connecting') return
    this.clearStartTimer()
    this.setState({ marker, phase: 'playing' })
  }

  /** A stream that runs dry is connecting again, and gets as long to come back as it got to start. */
  private onElementWaiting(element: HTMLMediaElement): void {
    const { marker, phase } = this.state
    if (!marker || this.activeElement() !== element || phase !== 'playing') return
    this.setState({ marker, phase: 'connecting' })
    this.armStartTimer(this.generation)
  }

  /**
   * An element's error belongs to the marker only while that element is
   * the one playing it. One raised by a stream that was just replaced
   * arrives after the switch, when the element carries no error.
   */
  private onElementError(element: HTMLMediaElement): void {
    if (this.activeElement() !== element || !element.error) return
    const phase = this.state.phase
    if (phase !== 'connecting' && phase !== 'playing') return
    this.fail(`media-error:${element.error.code}`)
  }

  private armStartTimer(generation: number): void {
    this.clearStartTimer()
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      if (generation === this.generation) this.fail('start-timeout')
    }, this.startTimeoutMs)
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
  }

  private fail(reason: string): void {
    const marker = this.state.marker
    if (!marker) return
    logger.warn(`[GeoMedia] ${marker.id} is unavailable (${reason})`)
    this.generation += 1
    this.reset()
    this.unavailable.add(marker.id)
    this.setState({ marker, phase: 'unavailable' })
  }

  /** Silences both elements, ends any HLS or snapshot session, and drops the picture. */
  private reset(): void {
    this.clearStartTimer()
    if (this.hls) {
      try { this.hls.destroy() } catch (error) { logger.warn('[GeoMedia] hls.js teardown failed', error) }
      this.hls = null
    }
    for (const element of [this.audio, this.video]) {
      element.pause()
      if (element.hasAttribute('src')) {
        element.removeAttribute('src')
        element.load()
      }
    }
    this.poller?.stop()
    this.poller = null
    if (this.pictureUrl) {
      URL.revokeObjectURL(this.pictureUrl)
      this.pictureUrl = null
      this.image.removeAttribute('src')
    }
  }
}
