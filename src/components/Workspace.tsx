import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import GIF from 'gif.js.optimized'
import gifWorkerUrl from 'gif.js.optimized/dist/gif.worker.js?url'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import {
  getAdaptiveConcurrencyLimit,
  getNextQueuedJob,
  getRetryDecision,
  shouldDegradeQueue,
  type RuntimeHealthState,
} from '../lib/scheduler'

type ScreenKey = 'empty' | 'loaded' | 'selection' | 'batch' | 'processing' | 'results'

const screens: { key: ScreenKey; label: string }[] = [
  { key: 'empty', label: 'Upload' },
  { key: 'loaded', label: 'Preview' },
  { key: 'selection', label: 'Trim' },
  { key: 'batch', label: 'Queue' },
  { key: 'processing', label: 'Convert' },
  { key: 'results', label: 'Results' },
]

type QueueItem = {
  id: string
  label: string
  start: number
  end: number
  gifUrl?: string
  gifSizeBytes?: number
  mp4Url?: string
  mp4SizeBytes?: number
  outputFormat?: ExportFormat
  previewSrc?: string
  status: 'waiting' | 'processing' | 'ready' | 'failed' | 'cancelled'
  progress: number
  error?: string
  attempts: number
}

type SpeedPreset = 0.5 | 1 | 1.5 | 2

type QualityPreset = 'Low' | 'Medium' | 'High'
type ResolutionPreset = '480p' | '720p' | 'Original'
type PlaybackMode = 'full' | 'selection'
type ExportFormat = 'gif' | 'mp4'

type ExportPolicy = {
  workers: number
  fps: number
  quality: QualityPreset
  resolution: ResolutionPreset
  sampleScale: number
  retries: number
}

type TimelineThumbnail = {
  time: number
  src: string
}

type ReadyExport = {
  format: ExportFormat
  url: string
  sizeBytes?: number
}

const getReadyExport = (item: QueueItem): ReadyExport | undefined => {
  if (item.outputFormat === 'mp4' && item.mp4Url) {
    return { format: 'mp4', url: item.mp4Url, sizeBytes: item.mp4SizeBytes }
  }
  if (item.outputFormat !== 'mp4' && item.gifUrl) {
    return { format: 'gif', url: item.gifUrl, sizeBytes: item.gifSizeBytes }
  }
  if (item.mp4Url) return { format: 'mp4', url: item.mp4Url, sizeBytes: item.mp4SizeBytes }
  if (item.gifUrl) return { format: 'gif', url: item.gifUrl, sizeBytes: item.gifSizeBytes }
  return undefined
}

const formatTime = (value: number) => {
  if (!Number.isFinite(value) || value < 0) {
    return '00:00'
  }

  const totalSeconds = Math.max(0, Math.floor(value))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

const formatPreciseTime = (value: number) => {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const wholeSeconds = Math.floor(safeValue)
  const milliseconds = Math.floor((safeValue - wholeSeconds) * 1000)
  return `${formatTime(wholeSeconds)}.${String(milliseconds).padStart(3, '0')}`
}

const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Size unavailable'
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return fallback
}

const getAdaptiveExportPolicy = (
  item: QueueItem,
  video: HTMLVideoElement,
  activeJobs: number,
  queueLength: number,
  preferredQuality: QualityPreset,
  preferredFps: number,
  preferredResolution: ResolutionPreset,
  runtimeHealth: RuntimeHealthState = { totalFailures: 0, totalRecoveries: 0, degradedMode: false },
): ExportPolicy => {
  const duration = Math.max(0.1, Math.abs(item.end - item.start))
  const width = video.videoWidth || 1280
  const height = video.videoHeight || 720
  const pixelVolume = width * height
  const queuePressure = clamp(queueLength / 8, 0, 1)
  const jobPressure = clamp(activeJobs / 4, 0, 1)
  const resolutionPressure = clamp(pixelVolume / 1_500_000, 0, 1)
  const durationPressure = clamp(duration / 20, 0, 1)
  const hardwareCpu = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  const perClipWorkerBudget = clamp(Math.floor(hardwareCpu / Math.max(1, activeJobs)), 1, 2)
  const devicePressure = hardwareCpu <= 4 ? 0.12 : 0
  const failurePressure = clamp(runtimeHealth.totalFailures * 0.18, 0, 0.45)
  const degradedBias = runtimeHealth.degradedMode ? 0.2 : 0

  const risk = clamp(
    durationPressure * 0.35
      + resolutionPressure * 0.35
      + queuePressure * 0.15
      + jobPressure * 0.15
      + devicePressure
      + failurePressure
      + degradedBias,
    0,
    1,
  )

  const resolutionRank: Record<ResolutionPreset, number> = { '480p': 0, '720p': 1, Original: 2 }
  const lowerResolution = (resolution: ResolutionPreset): ResolutionPreset => (
    resolutionRank[resolution] >= 2 ? '720p' : '480p'
  )

  if (risk < 0.35) {
    return {
      workers: perClipWorkerBudget,
      fps: preferredFps,
      quality: preferredQuality,
      resolution: preferredResolution,
      sampleScale: 1,
      retries: 1,
    }
  }

  if (risk < 0.7) {
    return {
      workers: Math.min(perClipWorkerBudget, clamp(Math.floor(hardwareCpu / 2), 1, 2)),
      fps: preferredFps,
      quality: preferredQuality,
      resolution: lowerResolution(preferredResolution),
      sampleScale: 1,
      retries: 2,
    }
  }

  return {
    workers: 1,
    fps: preferredFps,
    quality: preferredQuality === 'Low' ? 'Low' : 'Medium',
    resolution: '480p',
    sampleScale: 1,
    retries: 2,
  }
}

const getFallbackPolicy = (policy: ExportPolicy): ExportPolicy => ({
  ...policy,
  workers: 1,
  fps: policy.fps,
  quality: policy.quality === 'Low' ? 'Low' : 'Medium',
  resolution: policy.resolution === 'Original' ? '720p' : '480p',
  sampleScale: 1,
  retries: 0,
})

const loadExportVideo = (src: string, signal?: AbortSignal) => new Promise<HTMLVideoElement>((resolve, reject) => {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true

  const timeout = window.setTimeout(() => {
    cleanup()
    reject(new Error('Timed out while preparing the source video for GIF conversion.'))
  }, 30000)
  const cleanup = () => {
    window.clearTimeout(timeout)
    video.removeEventListener('loadedmetadata', onLoaded)
    video.removeEventListener('error', onError)
    signal?.removeEventListener('abort', onAbort)
  }
  const onLoaded = () => {
    cleanup()
    resolve(video)
  }
  const onError = () => {
    cleanup()
    reject(new Error('The source video could not be decoded for GIF conversion.'))
  }
  const onAbort = () => {
    cleanup()
    video.removeAttribute('src')
    video.load()
    reject(new Error('Cancelled by user.'))
  }

  if (signal?.aborted) {
    onAbort()
    return
  }

  video.addEventListener('loadedmetadata', onLoaded, { once: true })
  video.addEventListener('error', onError, { once: true })
  signal?.addEventListener('abort', onAbort, { once: true })
  video.src = src
  video.load()
})

const mp4Encoder = new FFmpeg()
let mp4EncoderLoad: Promise<void> | null = null
let mp4EncoderQueue: Promise<void> = Promise.resolve()

const createMp4FromRange = (sourceUrl: string, sourceName: string, start: number, end: number, reportProgress: (progress: number) => void) => {
  const encode = async () => {
    if (!mp4EncoderLoad) {
      const baseUrl = import.meta.env.BASE_URL
      mp4EncoderLoad = (async () => {
        const coreResponse = await fetch(`${baseUrl}ffmpeg/ffmpeg-core.js`)
        if (!coreResponse.ok) throw new Error('Could not load the MP4 encoder script.')
        const coreBlobUrl = URL.createObjectURL(await coreResponse.blob())
        try {
          await mp4Encoder.load({
            coreURL: coreBlobUrl,
            wasmURL: `${baseUrl}ffmpeg/ffmpeg-core.wasm`,
          })
        } finally {
          URL.revokeObjectURL(coreBlobUrl)
        }
      })().catch((error: unknown) => {
        mp4EncoderLoad = null
        throw error
      })
    }
    await mp4EncoderLoad
    reportProgress(0.05)

    const response = await fetch(sourceUrl)
    if (!response.ok) throw new Error('Could not read the source video for MP4 export.')
    const input = new Uint8Array(await response.arrayBuffer())
    const sourceExtension = sourceName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
    const supportedExtensions = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv', 'mkv', 'avi'])
    const inputName = `source.${sourceExtension && supportedExtensions.has(sourceExtension) ? sourceExtension : 'mp4'}`
    const outputName = `clip-${Date.now()}.mp4`
    const onProgress = ({ progress }: { progress: number }) => reportProgress(0.1 + Math.max(0, Math.min(1, progress)) * 0.85)
    let lastEncoderError = ''
    const onLog = ({ message }: { message: string }) => {
      if (/error|failed|unknown|invalid|not found/i.test(message)) lastEncoderError = message.trim()
    }

    mp4Encoder.on('progress', onProgress)
    mp4Encoder.on('log', onLog)
    try {
      await mp4Encoder.writeFile(inputName, input)
      const exitCode = await mp4Encoder.exec([
        '-ss', Math.max(0, start).toFixed(3),
        '-i', inputName,
        '-t', Math.max(0.05, end - start).toFixed(3),
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputName,
      ])
      if (exitCode !== 0) throw new Error(`MP4 encoding failed${lastEncoderError ? `: ${lastEncoderError}` : '. Try a shorter clip or another source video.'}`)
      const output = await mp4Encoder.readFile(outputName)
      if (typeof output === 'string' || !output.byteLength) throw new Error('The MP4 encoder produced an empty file.')
      reportProgress(1)
      return new Blob([new Uint8Array(output)], { type: 'video/mp4' })
    } finally {
      mp4Encoder.off('progress', onProgress)
      mp4Encoder.off('log', onLog)
      await Promise.allSettled([mp4Encoder.deleteFile(inputName), mp4Encoder.deleteFile(outputName)])
    }
  }

  const queuedEncode = mp4EncoderQueue.then(encode)
  mp4EncoderQueue = queuedEncode.then(() => undefined, () => undefined)
  return queuedEncode
}

const getDefaultSelectionRange = (videoDuration: number) => {
  const safeDuration = Number.isFinite(videoDuration) ? Math.max(0, videoDuration) : 0
  const fallbackLength = Math.min(30, safeDuration || 30)
  const end = safeDuration > 0 ? Math.min(fallbackLength, safeDuration) : fallbackLength

  return {
    start: 0,
    end,
  }
}

function Workspace() {
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [screen, setScreen] = useState<ScreenKey>('empty')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoName, setVideoName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [sourceDimensions, setSourceDimensions] = useState({ width: 1280, height: 720 })
  const [isPlaying, setIsPlaying] = useState(false)
  const [selectionStart, setSelectionStart] = useState(0)
  const [selectionEnd, setSelectionEnd] = useState(0)
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | 'move' | null>(null)
  const timelineDragRef = useRef<{ kind: 'start' | 'end' | 'move'; anchorTime: number; start: number; end: number } | null>(null)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('full')
  const [playbackSpeed, setPlaybackSpeed] = useState<SpeedPreset>(1)
  const [loopMode, setLoopMode] = useState(true)
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>('High')
  const [renderFps, setRenderFps] = useState(15)
  const [renderResolution, setRenderResolution] = useState<ResolutionPreset>('720p')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('gif')
  const [timelineThumbnails, setTimelineThumbnails] = useState<TimelineThumbnail[]>([])
  const [selectionFrame, setSelectionFrame] = useState<string | null>(null)
  const [clipLengthSeconds, setClipLengthSeconds] = useState(10)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [processingLabel, setProcessingLabel] = useState('')
  const [processingCount, setProcessingCount] = useState({ current: 0, total: 0 })
  const cancelProcessingRef = useRef(false)
  const processingActiveRef = useRef(false)
  const activeGifRefsRef = useRef<Map<string, { abort: () => void }>>(new Map())
  const activePreparationRefsRef = useRef<Map<string, AbortController>>(new Map())
  const activeGifRef = useRef<{ abort: () => void } | null>(null)
  const runtimeHealthRef = useRef<RuntimeHealthState>({ totalFailures: 0, totalRecoveries: 0, degradedMode: false })
  const [timelineWindowStart, setTimelineWindowStart] = useState(0)
  const [timelineWindowEnd, setTimelineWindowEnd] = useState(0)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueScrollTop, setQueueScrollTop] = useState(0)

  const selectionDuration = Math.max(0, selectionEnd - selectionStart)

  const getQueueStatusCounts = () => {
    const counts = { waiting: 0, processing: 0, ready: 0, failed: 0, cancelled: 0 }
    queue.forEach((item) => {
      counts[item.status] += 1
    })
    return counts
  }

  const getTimelinePreview = (time: number) => {
    const closest = timelineThumbnails.reduce<TimelineThumbnail | null>((best, thumbnail) => (
      !best || Math.abs(thumbnail.time - time) < Math.abs(best.time - time) ? thumbnail : best
    ), null)
    return closest?.src || selectionFrame || undefined
  }

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    video.playbackRate = playbackSpeed
    video.loop = playbackMode === 'full' && loopMode
  }, [playbackSpeed, loopMode, playbackMode, videoUrl])

  const captureCurrentFrame = () => {
    const video = videoRef.current
    if (!video || !videoUrl || !Number.isFinite(video.duration) || video.duration <= 0) return
    const qualityScale = { Low: 0.45, Medium: 0.7, High: 1 } as const
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(320, Math.floor((video.videoWidth || 1280) * qualityScale[qualityPreset]))
    canvas.height = Math.max(180, Math.floor((video.videoHeight || 720) * qualityScale[qualityPreset]))
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    setSelectionFrame(canvas.toDataURL('image/jpeg', 0.9))
  }

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl)
      }
    }
  }, [videoUrl])

  useEffect(() => {
    if (!videoUrl || duration <= 0) {
      return
    }

    let cancelled = false
    const source = document.createElement('video')
    source.preload = 'auto'
    source.muted = true
    source.playsInline = true
    source.src = videoUrl

    const waitFor = (eventName: string) => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out while loading timeline ${eventName}`))
      }, 10000)
      const cleanup = () => {
        window.clearTimeout(timeout)
        source.removeEventListener(eventName, onSuccess)
        source.removeEventListener('error', onError)
      }
      const onSuccess = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error('Could not read video frames')) }
      source.addEventListener(eventName, onSuccess, { once: true })
      source.addEventListener('error', onError, { once: true })
    })

    const generateThumbnails = async () => {
      try {
        await waitFor('loadedmetadata')
        const start = Math.max(0, Math.min(timelineWindowStart, duration))
        const end = Math.max(start, Math.min(timelineWindowEnd || duration, duration))
        const count = Math.min(48, Math.max(12, Math.ceil((end - start) / 8)))
        const canvas = document.createElement('canvas')
        canvas.width = 144
        canvas.height = 81
        const context = canvas.getContext('2d')
        if (!context) return
        const frames: TimelineThumbnail[] = []

        for (let index = 0; index < count; index += 1) {
          if (cancelled) return
          const time = start + ((index + 0.5) / count) * (end - start)
          const seeked = waitFor('seeked')
          source.currentTime = Math.min(time, Math.max(0, duration - 0.01))
          await seeked
          context.drawImage(source, 0, 0, canvas.width, canvas.height)
          frames.push({ time, src: canvas.toDataURL('image/jpeg', 0.68) })
          if (!cancelled) setTimelineThumbnails([...frames])
        }
      } catch {
        if (!cancelled) setTimelineThumbnails([])
      }
    }

    void generateThumbnails()
    return () => {
      cancelled = true
      source.removeAttribute('src')
      source.load()
    }
  }, [videoUrl, duration, timelineWindowStart, timelineWindowEnd])

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (processingActiveRef.current) {
      event.target.value = ''
      return
    }
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    const browserFriendlyVideoTypes = ['mp4', 'mov', 'm4v', 'm4a', 'webm', 'ogv', 'mkv']
    const isLikelyVideo = file.type.startsWith('video/') || browserFriendlyVideoTypes.includes(extension)

    if (!isLikelyVideo) {
      setUploadError('This file is not a supported video format. Please choose an MP4, MOV, M4V, or WebM file.')
      event.target.value = ''
      return
    }

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl)
    }
    queue.forEach((item) => {
      if (item.gifUrl) URL.revokeObjectURL(item.gifUrl)
      if (item.mp4Url) URL.revokeObjectURL(item.mp4Url)
    })
    setUploadError(null)

    const objectUrl = URL.createObjectURL(file)
    setVideoUrl(objectUrl)
    setVideoName(file.name)
    setCurrentTime(0)
    setDuration(0)
    setSelectionStart(0)
    setSelectionEnd(0)
    setTimelineWindowStart(0)
    setTimelineWindowEnd(0)
    setQueue([])
    setQueueScrollTop(0)
    setTimelineThumbnails([])
    setScreen('loaded')
    setIsPlaying(false)
    event.target.value = ''
  }

  const handleVideoError = () => {
    const video = videoRef.current
    const browserMessage = video?.error?.message || 'The browser could not decode this file.'

    queue.forEach((item) => {
      if (item.gifUrl) URL.revokeObjectURL(item.gifUrl)
      if (item.mp4Url) URL.revokeObjectURL(item.mp4Url)
    })
    setUploadError(`This video cannot be previewed in the browser: ${browserMessage}. Please convert it to MP4 or WebM and upload again.`)
    setScreen('empty')
    setVideoUrl(null)
    setCurrentTime(0)
    setDuration(0)
    setSelectionStart(0)
    setSelectionEnd(0)
    setTimelineWindowStart(0)
    setTimelineWindowEnd(0)
    setTimelineThumbnails([])
    setQueue([])
    setQueueScrollTop(0)
    setIsPlaying(false)
  }

  const handleLoadedMetadata = () => {
    const video = videoRef.current

    if (!video) {
      return
    }

    video.playbackRate = playbackSpeed
    video.loop = playbackMode === 'full' && loopMode
    const safeDuration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0
    const defaultSelection = getDefaultSelectionRange(safeDuration)

    setDuration(safeDuration)
    setSourceDimensions({ width: video.videoWidth || 1280, height: video.videoHeight || 720 })
    setSelectionStart(defaultSelection.start)
    setSelectionEnd(defaultSelection.end)
    setTimelineWindowStart(0)
    setTimelineWindowEnd(safeDuration || 1)
    setCurrentTime(0)
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current

    if (!video) {
      return
    }

    if (playbackMode === 'selection' && (video.currentTime < selectionStart || video.currentTime >= selectionEnd)) {
      video.currentTime = selectionStart
      setCurrentTime(selectionStart)
      return
    }

    setCurrentTime(video.currentTime)
  }

  const changePlaybackMode = (mode: PlaybackMode) => {
    setPlaybackMode(mode)
    const video = videoRef.current
    if (mode === 'selection' && video && (video.currentTime < selectionStart || video.currentTime >= selectionEnd)) {
      video.currentTime = selectionStart
      setCurrentTime(selectionStart)
    }
  }

  const togglePlayback = async () => {
    const video = videoRef.current

    if (!video || !videoUrl) {
      return
    }

    if (video.paused) {
      if (playbackMode === 'selection' && (video.currentTime < selectionStart || video.currentTime >= selectionEnd)) {
        video.currentTime = selectionStart
        setCurrentTime(selectionStart)
      }
      try {
        await video.play()
        setIsPlaying(true)
      } catch {
        setIsPlaying(false)
      }
      return
    }

    video.pause()
    setIsPlaying(false)
  }

  const stepVideo = (seconds: number) => {
    const video = videoRef.current

    if (!video) {
      return
    }

    const lowerBound = playbackMode === 'selection' ? selectionStart : 0
    const upperBound = playbackMode === 'selection' ? Math.max(selectionStart, selectionEnd - 0.01) : video.duration || 0
    const nextTime = Math.min(Math.max(video.currentTime + seconds, lowerBound), upperBound)
    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const setSelectionAnchor = (type: 'start' | 'end') => {
    const minimumLength = Math.min(0.05, duration)
    if (type === 'start') {
      setSelectionStart(currentTime)
      if (currentTime >= selectionEnd) {
        setSelectionEnd(Math.min(duration, currentTime + minimumLength))
      }
      setTimeout(() => captureCurrentFrame(), 0)
      return
    }

    setSelectionEnd(currentTime)
    if (currentTime <= selectionStart) {
      setSelectionStart(Math.max(0, currentTime - minimumLength))
    }
    setTimeout(() => captureCurrentFrame(), 0)
  }

  const zoomToSelection = () => {
    const start = Math.min(selectionStart, selectionEnd)
    const end = Math.max(selectionStart, selectionEnd)
    const padding = Math.max(8, (end - start) * 0.35)

    setTimelineWindowStart(Math.max(0, start - padding))
    setTimelineWindowEnd(Math.min(duration || end + padding, end + padding))
    setZoomLevel(2)
  }

  const resetTimelineView = () => {
    setTimelineWindowStart(0)
    setTimelineWindowEnd(duration || 0)
    setZoomLevel(1)
  }

  const buildBatchSegments = () => {
    const start = Math.min(selectionStart, selectionEnd)
    const end = Math.max(selectionStart, selectionEnd)
    const segmentLength = clipLengthSeconds
    const generated: QueueItem[] = []

    if (!videoUrl || end <= start) return

    for (let index = 0; start + index * segmentLength < end; index += 1) {
      const itemStart = start + index * segmentLength
      const itemEnd = Math.min(itemStart + segmentLength, end)

      generated.push({
        id: crypto.randomUUID(),
        label: `GIF ${String(queue.length + index + 1).padStart(2, '0')}`,
        start: itemStart,
        end: itemEnd,
        previewSrc: getTimelinePreview(itemStart),
        status: 'waiting',
        progress: 0,
        attempts: 0,
      })
    }

    setQueue((currentQueue) => [...currentQueue, ...generated])
    setQueueScrollTop(0)
    setScreen('batch')
  }

  const seekToTime = (value: number) => {
    const video = videoRef.current

    if (!video) {
      return
    }

    const lowerBound = playbackMode === 'selection' ? selectionStart : 0
    const upperBound = playbackMode === 'selection' ? Math.max(selectionStart, selectionEnd - 0.01) : video.duration || 0
    const nextTime = Math.min(Math.max(value, lowerBound), upperBound)
    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const seekVideoToTime = (video: HTMLVideoElement, value: number) =>
    new Promise<void>((resolve, reject) => {
      if (!video || !Number.isFinite(value)) {
        reject(new Error('The requested media time is invalid.'))
        return
      }

      const maxTime = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : 0
      const safeValue = Math.min(Math.max(value, 0), maxTime)

      const finish = (callback: () => void) => {
        cleanup()
        callback()
      }

      const cleanup = () => {
        window.clearTimeout(timeoutId)
        video.removeEventListener('seeked', handleSeeked)
        video.removeEventListener('error', handleError)
        video.removeEventListener('loadeddata', handleLoadedData)
      }

      const handleLoadedData = () => {
        if (video.readyState >= 1 && Number.isFinite(video.duration)) {
          finish(() => resolve())
        }
      }

      const handleSeeked = () => {
        if (Math.abs(video.currentTime - safeValue) < 0.05) {
          finish(() => resolve())
        }
      }

      const handleError = () => {
        finish(() => reject(new Error('The video could not seek to a frame for GIF conversion.')))
      }

      const timeoutId = window.setTimeout(() => {
        if (Number.isFinite(video.duration) && Math.abs(video.currentTime - safeValue) < 0.05) {
          finish(() => resolve())
          return
        }
        finish(() => reject(new Error(`Timed out seeking to ${formatPreciseTime(safeValue)}.`)))
      }, 20000)

      if (video.readyState < 1 || !Number.isFinite(video.duration)) {
        video.addEventListener('loadeddata', handleLoadedData, { once: true })
        video.addEventListener('error', handleError, { once: true })
        return
      }

      video.pause()
      video.addEventListener('seeked', handleSeeked, { once: true })
      video.addEventListener('error', handleError, { once: true })

      try {
        video.currentTime = safeValue
      } catch (error) {
        finish(() => reject(error))
      }
    })

  const createGifFromRange = async (
    item: QueueItem,
    video: HTMLVideoElement,
    reportProgress: (value: number, previewSrc?: string) => void,
    policy: ExportPolicy = {
      workers: 2,
      fps: renderFps,
      quality: qualityPreset,
      resolution: renderResolution,
      sampleScale: 1,
      retries: 1,
    },
    retryLevel = 0,
  ): Promise<QueueItem> => {
    const start = Math.min(item.start, item.end)
    const end = Math.max(item.start, item.end)
    const clipDuration = Math.max(0.05, end - start)
    const qualityMap: Record<QualityPreset, number> = {
      Low: 20,
      Medium: 12,
      High: 5,
    }
    const widthLimit: Record<ResolutionPreset, number> = {
      '480p': 854,
      '720p': 1280,
      Original: video.videoWidth || 1280,
    }
    const baseWidth = Math.max(320, Math.min(video.videoWidth || 1280, widthLimit[policy.resolution]))
    const width = Math.max(320, Math.round(baseWidth))
    const height = Math.max(180, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width))
    const frameRate = policy.fps
    const sampleFrames = Math.max(1, Math.min(300, Math.ceil(clipDuration * frameRate * policy.sampleScale)))
    const frameDelay = (clipDuration * 1000) / sampleFrames
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('Could not create a canvas for GIF conversion.')
    }

    canvas.width = width
    canvas.height = height

    const gif = new GIF({
      workers: policy.workers,
      quality: qualityMap[policy.quality],
      workerScript: gifWorkerUrl,
      width,
      height,
      repeat: 0,
    })
    activeGifRefsRef.current.set(item.id, gif)
    activeGifRef.current = gif

    try {
      for (let index = 0; index < sampleFrames; index += 1) {
        if (cancelProcessingRef.current) throw new Error('Cancelled by user.')
        const rawTime = start + ((index / sampleFrames) * clipDuration)
        const safeClipTime = Number.isFinite(video.duration)
          ? Math.min(Math.max(rawTime, 0), Math.max(0, video.duration - 0.05))
          : Math.max(0, rawTime)
        await seekVideoToTime(video, safeClipTime)
        if (cancelProcessingRef.current) throw new Error('Cancelled by user.')
        context.drawImage(video, 0, 0, width, height)
        gif.addFrame(canvas, { copy: true, delay: frameDelay })
        let previewSrc: string | undefined
        if (index === 0) {
          const previewCanvas = document.createElement('canvas')
          const previewWidth = Math.min(360, width)
          const previewHeight = Math.max(1, Math.round((height / width) * previewWidth))
          previewCanvas.width = previewWidth
          previewCanvas.height = previewHeight
          previewCanvas.getContext('2d')?.drawImage(video, 0, 0, previewWidth, previewHeight)
          previewSrc = previewCanvas.toDataURL('image/jpeg', 0.78)
        }
        reportProgress(((index + 1) / sampleFrames) * 0.4, previewSrc)
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error('GIF encoding took too long. Try a lower resolution or FPS and retry.'))
          gif.abort()
        }, Math.max(60000, sampleFrames * 3000))
        const finish = (callback: () => void) => {
          window.clearTimeout(timeout)
          callback()
        }
        gif.on('finished', (result: Blob) => finish(() => resolve(result)))
        gif.on('abort', () => finish(() => reject(new Error('GIF export aborted'))))
        gif.on('error', (error: Error) => finish(() => reject(error)))
        gif.on('progress', (progress: number) => {
          reportProgress(0.4 + progress * 0.6)
        })
        gif.render()
      })

      return {
        ...item,
        gifUrl: URL.createObjectURL(blob),
        gifSizeBytes: blob.size,
        status: 'ready',
        progress: 100,
        error: undefined,
      }
    } catch (error) {
      runtimeHealthRef.current.totalFailures += 1
      runtimeHealthRef.current.degradedMode = true
      setProcessingLabel('Adaptive safety mode…')

      if (!cancelProcessingRef.current && retryLevel < policy.retries) {
        runtimeHealthRef.current.totalRecoveries += 1
        const nextPolicy = getFallbackPolicy(policy)
        return createGifFromRange(item, video, reportProgress, nextPolicy, retryLevel + 1)
      }
      throw error
    } finally {
      activeGifRefsRef.current.delete(item.id)
      if (activeGifRef.current === gif) {
        activeGifRef.current = null
      }
    }
  }

  useEffect(() => {
    if (!draggingHandle) return

    const updateFromPointer = (event: PointerEvent) => {
      const drag = timelineDragRef.current
      const track = trackRef.current
      if (!drag || !track) return

      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
      const windowStart = timelineWindowStart || 0
      const windowEnd = timelineWindowEnd || duration || 1
      const nextValue = windowStart + ratio * (windowEnd - windowStart)
      const minimumLength = Math.min(0.05, duration)

      if (drag.kind === 'start') {
        setSelectionStart(Math.min(Math.max(nextValue, 0), drag.end - minimumLength))
      } else if (drag.kind === 'end') {
        setSelectionEnd(Math.max(Math.min(nextValue, duration), drag.start + minimumLength))
      } else {
        const length = drag.end - drag.start
        const nextStart = Math.min(Math.max(drag.start + nextValue - drag.anchorTime, 0), Math.max(0, duration - length))
        setSelectionStart(nextStart)
        setSelectionEnd(nextStart + length)
      }
    }

    const stopDragging = () => {
      timelineDragRef.current = null
      setDraggingHandle(null)
    }

    window.addEventListener('pointermove', updateFromPointer)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    return () => {
      window.removeEventListener('pointermove', updateFromPointer)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }
  }, [draggingHandle, duration, timelineWindowStart, timelineWindowEnd])

  const handleTimelinePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!trackRef.current) {
      return
    }

    const rect = trackRef.current.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    const windowStart = timelineWindowStart || 0
    const windowEnd = timelineWindowEnd || duration || 1
    const clickTime = windowStart + ratio * (windowEnd - windowStart)

    const startX = ((selectionStart - windowStart) / (windowEnd - windowStart)) * rect.width
    const endX = ((selectionEnd - windowStart) / (windowEnd - windowStart)) * rect.width
    const distanceToStart = Math.abs(ratio * rect.width - startX)
    const distanceToEnd = Math.abs(ratio * rect.width - endX)
    const hitRadius = Math.max(18, Math.min(26, rect.width * 0.04))
    const insideSelection = clickTime >= selectionStart && clickTime <= selectionEnd
    let kind: 'start' | 'end' | 'move' | null = null

    if (distanceToStart <= hitRadius || distanceToEnd <= hitRadius) {
      kind = distanceToStart <= distanceToEnd ? 'start' : 'end'
    } else if (insideSelection) {
      kind = 'move'
    }

    if (kind) {
      event.preventDefault()
      trackRef.current.setPointerCapture?.(event.pointerId)
      timelineDragRef.current = { kind, anchorTime: clickTime, start: selectionStart, end: selectionEnd }
      setDraggingHandle(kind)
      return
    }

    seekToTime(clickTime)
  }

  const addCurrentSelectionToQueue = () => {
    const safeStart = Math.min(selectionStart, selectionEnd)
    const safeEnd = Math.max(selectionStart, selectionEnd)

    if (!videoUrl || safeEnd <= safeStart) return

    setQueue((currentQueue) => [
      ...currentQueue,
      {
        id: crypto.randomUUID(),
        label: `Clip ${String(currentQueue.length + 1).padStart(2, '0')}`,
        start: safeStart,
        end: safeEnd,
        outputFormat: exportFormat,
        previewSrc: getTimelinePreview(safeStart),
        status: 'waiting',
        progress: 0,
        attempts: 0,
      },
    ])
    setQueueScrollTop(0)

    setScreen('batch')
  }

  const chooseExportFormat = (format: ExportFormat) => {
    setExportFormat(format)
    setQueue((currentQueue) => currentQueue.map((item) => (
      item.status === 'waiting' || item.status === 'failed' || item.status === 'cancelled'
        ? { ...item, outputFormat: format, error: undefined, attempts: 0 }
        : item
    )))
  }

  const startProcessingQueue = async (retryFailed = false, onlyItemId?: string) => {
    const itemsToProcess = retryFailed
      ? queue.filter((item) => item.error && (onlyItemId === undefined || item.id === onlyItemId))
      : queue
    if (!itemsToProcess.length || !videoUrl || processingActiveRef.current) {
      return
    }

    const activeBatchLimit = 4
    const getCurrentMaxWorkers = () => {
      const hardwareCpu = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
      const adaptiveLimit = getAdaptiveConcurrencyLimit(Math.min(itemsToProcess.length, activeBatchLimit), runtimeHealthRef.current, hardwareCpu)
      return Math.min(adaptiveLimit, Math.max(1, Math.min(activeBatchLimit, itemsToProcess.length)))
    }

    let maxConcurrentWorkers = getCurrentMaxWorkers()

    cancelProcessingRef.current = false
    processingActiveRef.current = true
    runtimeHealthRef.current = { totalFailures: 0, totalRecoveries: 0, degradedMode: false }
    setProcessingCount({ current: 0, total: itemsToProcess.length })
    setProcessingLabel('Preparing video…')
    setScreen('processing')
    setQueue((currentQueue) => currentQueue.map((item) => (
      itemsToProcess.some((target) => target.id === item.id)
        ? { ...item, status: 'waiting', progress: 0, error: undefined }
        : item
    )))

    const finishedIds = new Set<string>()
    const stagedItems = [...itemsToProcess]
    const runningItems = new Set<string>()

    const updateProcessingMetrics = () => {
      const completedCount = itemsToProcess.filter((item) => finishedIds.has(item.id)).length
      const activeCount = runningItems.size
      const progressValue = Math.min(itemsToProcess.length, completedCount + activeCount)
      setProcessingCount({ current: progressValue, total: itemsToProcess.length })

      const activeLabel = itemsToProcess.find((item) => runningItems.has(item.id))?.label
      if (activeLabel) {
        setProcessingLabel(activeLabel)
      }
    }

    const runNext = () => {
      maxConcurrentWorkers = getCurrentMaxWorkers()

      if (cancelProcessingRef.current) {
        if (runningItems.size === 0) {
          processingActiveRef.current = false
          setQueue((currentQueue) => currentQueue.map((item) => (
            stagedItems.some((staged) => staged.id === item.id) && item.status === 'waiting'
              ? { ...item, status: 'cancelled', error: 'Cancelled by user.' }
              : item
          )))
          setScreen('results')
        }
        return
      }

      if (runningItems.size >= maxConcurrentWorkers) {
        return
      }

      const item = getNextQueuedJob(stagedItems, runningItems, finishedIds)
      if (!item) {
        if (runningItems.size === 0) {
          processingActiveRef.current = false
          setScreen('results')
        }
        return
      }

      const stagedIndex = stagedItems.findIndex((queuedItem) => queuedItem.id === item.id)
      if (stagedIndex >= 0) {
        stagedItems.splice(stagedIndex, 1)
      }

      runningItems.add(item.id)
      updateProcessingMetrics()
      setQueue((currentQueue) => currentQueue.map((queuedItem) => (
        queuedItem.id === item.id ? { ...queuedItem, status: 'processing', progress: 0, error: undefined } : queuedItem
      )))

      void (async () => {
        let processedItem: QueueItem
        let lastProgressUpdate = 0
        let workerVideo: HTMLVideoElement | null = null
        const preparationController = new AbortController()
        activePreparationRefsRef.current.set(item.id, preparationController)

        try {
          workerVideo = await loadExportVideo(videoUrl, preparationController.signal)
          const adaptivePolicy = getAdaptiveExportPolicy(
            item,
            workerVideo,
            runningItems.size,
            queue.length,
            qualityPreset,
            renderFps,
            renderResolution,
            runtimeHealthRef.current,
          )

          const onProgress = (itemProgress: number, previewSrc?: string) => {
            const now = performance.now()
            if (itemProgress < 1 && now - lastProgressUpdate < 80 && !previewSrc) return
            lastProgressUpdate = now
            setQueue((currentQueue) => currentQueue.map((queuedItem) => (
              queuedItem.id === item.id
                ? { ...queuedItem, progress: Math.round(itemProgress * 100), previewSrc: previewSrc || queuedItem.previewSrc }
                : queuedItem
            )))
          }
          if ((item.outputFormat || exportFormat) === 'mp4') {
            const blob = await createMp4FromRange(videoUrl, videoName, item.start, item.end, (progress) => onProgress(progress))
            processedItem = { ...item, mp4Url: URL.createObjectURL(blob), mp4SizeBytes: blob.size, status: 'ready', progress: 100, error: undefined }
          } else {
            processedItem = await createGifFromRange(item, workerVideo, onProgress, adaptivePolicy)
          }
        } catch (error) {
          runtimeHealthRef.current.totalFailures += 1
          if (shouldDegradeQueue(runtimeHealthRef.current, itemsToProcess.length)) {
            runtimeHealthRef.current.degradedMode = true
            setProcessingLabel('Adaptive safety mode…')
          }

          const nextAttempts = (item.attempts ?? 0) + 1
          const retryDecision = getRetryDecision(item.attempts ?? 0)
          const retryAllowed = !cancelProcessingRef.current && retryDecision.retryAllowed

          if (retryAllowed) {
            runtimeHealthRef.current.totalRecoveries += 1
            const retriedItem: QueueItem = {
              ...item,
              attempts: nextAttempts,
              status: 'waiting',
              progress: 0,
              error: undefined,
            }

            stagedItems.push(retriedItem)
            setQueue((currentQueue) => currentQueue.map((queuedItem) => (
              queuedItem.id === item.id ? retriedItem : queuedItem
            )))
            runningItems.delete(item.id)
            updateProcessingMetrics()
            if (!cancelProcessingRef.current) {
              runNext()
            }
            return
          }

          processedItem = {
            ...item,
            attempts: item.attempts ?? 0,
            status: cancelProcessingRef.current ? 'cancelled' : 'failed',
            progress: cancelProcessingRef.current ? item.progress : 0,
            error: cancelProcessingRef.current ? 'Cancelled by user.' : getErrorMessage(error, 'This clip could not be converted.'),
          }
        } finally {
          activePreparationRefsRef.current.delete(item.id)
          if (workerVideo) {
            workerVideo.pause()
            workerVideo.removeAttribute('src')
            workerVideo.load()
          }
        }

        if (item.gifUrl && processedItem.gifUrl && item.gifUrl !== processedItem.gifUrl) URL.revokeObjectURL(item.gifUrl)
        if (item.mp4Url && processedItem.mp4Url && item.mp4Url !== processedItem.mp4Url) URL.revokeObjectURL(item.mp4Url)
        setQueue((currentQueue) => currentQueue.map((queuedItem) => (
          queuedItem.id === item.id
            ? { ...processedItem, previewSrc: queuedItem.previewSrc || processedItem.previewSrc, progress: processedItem.status === 'ready' ? 100 : queuedItem.progress }
            : queuedItem
        )))

        finishedIds.add(item.id)
        runningItems.delete(item.id)
        updateProcessingMetrics()

        runNext()
      })()
    }

    try {
      for (let workerIndex = 0; workerIndex < Math.min(maxConcurrentWorkers, itemsToProcess.length); workerIndex += 1) {
        runNext()
      }

      if (itemsToProcess.length === 0) {
        setScreen('results')
      }
    } catch (error) {
      processingActiveRef.current = false
      setUploadError(error instanceof Error ? error.message : 'The source video could not be prepared for conversion.')
      setQueue((currentQueue) => currentQueue.map((item) => (
        itemsToProcess.some((target) => target.id === item.id)
          ? { ...item, status: 'failed', error: error instanceof Error ? error.message : 'The source video could not be prepared for conversion.' }
          : item
      )))
      setScreen('results')
    }
  }

  const cancelProcessing = () => {
    cancelProcessingRef.current = true
    activePreparationRefsRef.current.forEach((controller) => controller.abort())
    activeGifRefsRef.current.forEach((gif) => gif.abort())
    activeGifRef.current?.abort()
  }

  const downloadAllGifs = () => {
    queue.forEach((item) => {
      const output = getReadyExport(item)
      if (!output) return
      const link = document.createElement('a')
      link.href = output.url
      link.download = `${item.label}.${output.format}`
      document.body.appendChild(link)
      link.click()
      link.remove()
    })
  }

  const startNewProject = () => {
    if (processingActiveRef.current) {
      return
    }

    videoRef.current?.pause()
    queue.forEach((item) => {
      if (item.gifUrl) URL.revokeObjectURL(item.gifUrl)
      if (item.mp4Url) URL.revokeObjectURL(item.mp4Url)
    })
    setVideoUrl(null)
    setVideoName('')
    setUploadError(null)
    setCurrentTime(0)
    setDuration(0)
    setIsPlaying(false)
    setSelectionStart(0)
    setSelectionEnd(0)
    setSelectionFrame(null)
    setTimelineThumbnails([])
    setTimelineWindowStart(0)
    setTimelineWindowEnd(0)
    setQueue([])
    setZoomLevel(1)
    setPlaybackMode('full')
    setScreen('empty')
    if (uploadInputRef.current) uploadInputRef.current.value = ''
  }

  const rangeStart = timelineWindowStart || 0
  const rangeEnd = timelineWindowEnd || duration || 1
  const visibleDuration = Math.max(1, rangeEnd - rangeStart)
  const visibleSelectionStart = Math.max(selectionStart, rangeStart)
  const visibleSelectionEnd = Math.min(selectionEnd, rangeEnd)
  const visibleSelectionLeftPercent = ((visibleSelectionStart - rangeStart) / visibleDuration) * 100
  const visibleSelectionWidthPercent = Math.max(0, ((visibleSelectionEnd - visibleSelectionStart) / visibleDuration) * 100)
  const queueRowStride = 55
  const queueVirtualStart = queue.length > 100 ? Math.max(0, Math.floor(queueScrollTop / queueRowStride) - 3) : 0
  const queueVirtualEnd = queue.length > 100
    ? Math.min(queue.length, Math.ceil((queueScrollTop + 260) / queueRowStride) + 3)
    : queue.length
  const sourceWidth = sourceDimensions.width
  const sourceHeight = sourceDimensions.height
  const requestedFrameCappedCount = queue.filter((item) => Math.ceil(Math.max(0.05, item.end - item.start) * renderFps) > 300).length
  const largestRawFrameMemory = queue.reduce((largest, item) => {
    const maxWidth = renderResolution === 'Original' ? sourceWidth : renderResolution === '720p' ? 1280 : 854
    const width = Math.max(320, Math.min(sourceWidth, maxWidth))
    const height = Math.max(180, Math.round((sourceHeight / Math.max(sourceWidth, 1)) * width))
    const frameCount = Math.max(1, Math.min(300, Math.ceil(Math.max(0.05, item.end - item.start) * renderFps)))
    return Math.max(largest, width * height * 4 * frameCount)
  }, 0)

  const AnimatedGifPreview = ({
    gifUrl,
    posterSrc,
    alt,
    className,
  }: {
    gifUrl?: string
    posterSrc?: string
    alt: string
    className?: string
  }) => {
    const source = posterSrc || gifUrl

    if (!source) {
      return <div className={className} />
    }

    return <img className={className} src={source} alt={alt} loading="lazy" decoding="async" />
  }

  const renderScreen = () => {
    if (screen === 'empty') {
      return (
        <div className="screen-panel empty-panel">
          <div className="empty-state-card">
            <div className="empty-icon">↑</div>
            <h2>Open a video to begin</h2>
            <p>Drop a local file or choose a source from your device to start making GIFs.</p>
            <label className="primary-btn empty-button" htmlFor="video-upload">
              Choose Video
            </label>
          </div>
        </div>
      )
    }

    if (screen === 'selection') {
      return (
        <div className="screen-panel editor-panel">
          <div className="editor-header-row">
            <div>
              <span className="mini-label">Selected range</span>
              <h3>{formatTime(selectionStart)} - {formatTime(selectionEnd)}</h3>
            </div>
            <div className="chip-group" role="group" aria-label="Export format">
              <button type="button" className={`video-chip ${exportFormat === 'gif' ? 'active' : ''}`} aria-pressed={exportFormat === 'gif'} onClick={() => chooseExportFormat('gif')}>GIF</button>
              <button type="button" className={`video-chip ${exportFormat === 'mp4' ? 'active' : ''}`} aria-pressed={exportFormat === 'mp4'} onClick={() => chooseExportFormat('mp4')}>MP4 · silent</button>
            </div>
            <button className="primary-btn" type="button" disabled={!videoUrl || selectionDuration <= 0} onClick={addCurrentSelectionToQueue}>
              Add {exportFormat === 'gif' ? 'GIF' : 'MP4'}
            </button>
          </div>

          <div className="selection-preview">
            <div className="selection-frame">
              {selectionFrame ? <img src={selectionFrame} alt="Current selection frame" /> : <div className="selection-frame-placeholder">No frame available</div>}
            </div>
            <div className="selection-meta-box">
              <span>Duration</span>
              <strong>{formatTime(selectionDuration)}</strong>
            </div>
          </div>

          <div className="selection-tools">
            <button className="small-btn" type="button" onClick={() => setSelectionAnchor('start')}>Set start</button>
            <button className="small-btn" type="button" onClick={() => setSelectionAnchor('end')}>Set end</button>
            <button className="small-btn" type="button" onClick={zoomToSelection}>Zoom to Selection</button>
            <label className="clip-length-control" htmlFor="clip-length-select">Clip length</label>
            <select
              id="clip-length-select"
              className="clip-length-select"
              value={clipLengthSeconds}
              onChange={(event) => setClipLengthSeconds(Number(event.target.value))}
            >
              {Array.from({ length: 15 }, (_, index) => index + 1).map((seconds) => (
                <option key={seconds} value={seconds}>{seconds} seconds</option>
              ))}
            </select>
            <button
              className="small-btn"
              type="button"
              disabled={!videoUrl || selectionDuration <= 0}
              onClick={buildBatchSegments}
            >
              Split into GIFs
            </button>
          </div>
          <p className="clip-length-hint">Split clips are added to the existing queue. A shorter final clip is kept when needed.</p>
        </div>
      )
    }

    if (screen === 'batch') {
      return (
        <div className="screen-panel batch-panel">
          <div className="batch-grid">
            <div className="batch-card preview-card">
              <div className="batch-preview" />
              <div className="queue-list" onScroll={(event) => setQueueScrollTop(event.currentTarget.scrollTop)}>
                {queue.length === 0 ? (
                  <p className="empty-queue-text">No clips queued yet.</p>
                ) : (
                  <>
                    {queueVirtualStart > 0 ? (
                      <div className="queue-list-spacer" style={{ height: `${queueVirtualStart * queueRowStride - 9}px` }} />
                    ) : null}
                    {queue.slice(queueVirtualStart, queueVirtualEnd).map((item) => (
                      <div className="queue-item" key={item.id}>
                        <span>{item.label}</span>
                        <strong>{formatTime(item.end - item.start)}</strong>
                      </div>
                    ))}
                    {queueVirtualEnd < queue.length ? (
                      <div className="queue-list-spacer" style={{ height: `${(queue.length - queueVirtualEnd) * queueRowStride - 9}px` }} />
                    ) : null}
                  </>
                )}
              </div>
            </div>

            <div className="batch-card form-card">
              <div className="setting-row export-format-setting">
                <strong>Export format</strong>
                <div className="chip-group" role="group" aria-label="Export format">
                  <button
                    type="button"
                    className={`video-chip ${exportFormat === 'gif' ? 'active' : ''}`}
                    aria-pressed={exportFormat === 'gif'}
                    onClick={() => chooseExportFormat('gif')}
                  >GIF</button>
                  <button
                    type="button"
                    className={`video-chip ${exportFormat === 'mp4' ? 'active' : ''}`}
                    aria-pressed={exportFormat === 'mp4'}
                    onClick={() => chooseExportFormat('mp4')}
                  >MP4 · silent</button>
                </div>
              </div>
              <p className="export-format-help">MP4 exports are silent. Looping after sharing depends on the recipient’s app; previews loop here. FPS, resolution, and quality settings below apply to GIF exports.</p>
              <div className="setting-row">
                <label htmlFor="quality-select">GIF quality</label>
                <select id="quality-select" value={qualityPreset} onChange={(event) => setQualityPreset(event.target.value as QualityPreset)}>
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="fps-select">FPS</label>
                <select id="fps-select" value={renderFps} onChange={(event) => setRenderFps(Number(event.target.value))}>
                  <option value={8}>8</option>
                  <option value={12}>12</option>
                  <option value={15}>15</option>
                  <option value={24}>24</option>
                </select>
              </div>
              <div className="setting-row">
                <label htmlFor="resolution-select">Resolution</label>
                <select id="resolution-select" value={renderResolution} onChange={(event) => setRenderResolution(event.target.value as ResolutionPreset)}>
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                  <option value="Original">Original</option>
                </select>
              </div>
              <div className="setting-row">
                <label>Loop</label>
                <span>{loopMode ? 'Forward' : 'Once'}</span>
              </div>
              {requestedFrameCappedCount > 0 ? (
                <p className="conversion-warning">{requestedFrameCappedCount} clip(s) exceed the 300-frame safety cap. Their effective FPS will be reduced to preserve clip duration.</p>
              ) : null}
              {largestRawFrameMemory > 256 * 1024 * 1024 ? (
                <p className="conversion-warning">The largest clip may require about {formatFileSize(largestRawFrameMemory)} of raw frame memory. Lower resolution, FPS, or clip length to reduce browser memory use.</p>
              ) : null}
              <button className="primary-btn queue-button" type="button" disabled={!queue.length} onClick={() => void startProcessingQueue()}>
                Convert Selected
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (screen === 'processing') {
      return (
        <div className="screen-panel processing-panel" aria-live="polite">
          <div className="processing-header">
            <div className="processing-copy">
              <h3>Converting clip exports</h3>
              <p>{processingLabel ? `Now processing ${processingLabel}` : 'Preparing your video…'} · Clip {processingCount.current} of {processingCount.total}</p>
            </div>
            <button className="ghost-btn" type="button" onClick={cancelProcessing}>Cancel conversion</button>
          </div>
          <div className="processing-clip-list">
            {queue.map((item, index) => {
              const statusLabel = {
                waiting: 'Staged',
                processing: `Processing · ${Math.round(item.progress)}%`,
                ready: 'Completed',
                failed: 'Conversion failed',
                cancelled: 'Cancelled',
              }[item.status]

              return (
                <article className="processing-clip-card" key={item.id}>
                  {item.gifUrl || item.previewSrc ? (
                    <AnimatedGifPreview
                      className="processing-clip-preview"
                      gifUrl={item.gifUrl}
                      posterSrc={item.previewSrc}
                      alt={`${item.label} preview`}
                    />
                  ) : (
                    <div className="processing-clip-preview preview-placeholder">Frame preview appears when processing starts</div>
                  )}
                  <div className="processing-clip-meta">
                    <strong>{item.label}</strong>
                    <span>Clip {index + 1} · {formatPreciseTime(item.end - item.start)}</span>
                  </div>
                  {getReadyExport(item) ? (
                    <div className="processing-clip-actions">
                      <a className="download-link" href={getReadyExport(item)!.url} download={`${item.label}.${getReadyExport(item)!.format}`}>
                        Download {getReadyExport(item)!.format.toUpperCase()}
                      </a>
                      <span className="result-file-size">{formatFileSize(getReadyExport(item)!.sizeBytes || 0)}</span>
                    </div>
                  ) : null}
                  {item.error ? <span className="render-error">{item.error}</span> : null}
                  <div className="processing-clip-status">{statusLabel}</div>
                  <div
                    className="clip-progress-track"
                    role="progressbar"
                    aria-label={`${item.label} conversion progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progress)}
                  >
                    <div className="clip-progress-fill" style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }} />
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      )
    }

    if (screen === 'results') {
      const completedCount = queue.filter((item) => getReadyExport(item)).length
      const failedCount = queue.filter((item) => item.error).length
      const queueSummary = getQueueStatusCounts()
      const allFinished = queue.length > 0 && queue.every((item) => ['ready', 'failed', 'cancelled'].includes(item.status))
      const partialResultsAvailable = completedCount > 0 && !allFinished
      const readySummary = completedCount > 0
        ? `${completedCount} clip export${completedCount === 1 ? '' : 's'} ready to save`
        : 'No clip exports ready to save'

      return (
        <div className="screen-panel results-panel">
          <div className="results-header">
            <div>
              <span className="mini-label">Clip Collection</span>
              <h3>
                {partialResultsAvailable ? `${readySummary} · ${queueSummary.processing + queueSummary.waiting} still processing` : readySummary}
                {failedCount > 0 && !partialResultsAvailable ? ` · ${failedCount} need attention` : ''}
              </h3>
            </div>
            <button
              className="ghost-btn"
              type="button"
              onClick={() => {
                setScreen('loaded')
                resetTimelineView()
              }}
            >
              Create Another
            </button>
          </div>

          <div className="results-actions">
            {allFinished && completedCount > 0 ? (
              <button className="primary-btn" type="button" onClick={downloadAllGifs}>Download All Files</button>
            ) : null}
            {queue.some((item) => item.error) ? (
              <button className="ghost-btn" type="button" onClick={() => void startProcessingQueue(true)}>Retry Failed</button>
            ) : null}
          </div>

          <div className="result-grid">
            {queue.length > 0 ? (
              queue.map((item, index) => {
                const output = getReadyExport(item)
                return <div className="result-card" key={item.id}>
                  {output?.format === 'mp4' ? (
                    <video className="mini-thumb" src={output.url} muted loop autoPlay playsInline />
                  ) : output?.format === 'gif' ? (
                    <AnimatedGifPreview
                      className="mini-thumb"
                      gifUrl={output.url}
                      posterSrc={item.previewSrc}
                      alt={item.label}
                    />
                  ) : item.previewSrc ? (
                    <img className="mini-thumb" src={item.previewSrc} alt={`${item.label} frame preview`} loading="lazy" decoding="async" />
                  ) : (
                    <div className="mini-thumb" />
                  )}
                  <strong>{item.label}</strong>
                  <span>{formatTime(item.end - item.start)}</span>
                  {output?.sizeBytes !== undefined ? <span className="result-file-size">{formatFileSize(output.sizeBytes)}</span> : null}
                  <div className="clip-progress-track result-progress-track" aria-label={`${item.label} status: ${item.status}`}>
                    <div className="clip-progress-fill" style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }} />
                  </div>
                  <small>#{index + 1}</small>
                  {output ? (
                    <>
                      <a className="download-link" href={output.url} download={`${item.label}.${output.format}`}>
                        Download {output.format.toUpperCase()}
                      </a>
                      {item.error ? (
                        <>
                          <span className="render-error">Previous export kept. Latest attempt: {item.error}</span>
                          <button className="small-btn" type="button" onClick={() => void startProcessingQueue(true, item.id)}>Retry this clip</button>
                        </>
                      ) : null}
                    </>
                  ) : item.error ? (
                    <>
                      <span className="render-error">Conversion failed: {item.error}</span>
                      <button className="small-btn" type="button" onClick={() => void startProcessingQueue(true, item.id)}>Retry this clip</button>
                    </>
                  ) : null}
                </div>
              })
            ) : (
              <div className="result-card empty-result-card">
                <strong>No clip exports yet</strong>
                <span>Add a clip to the queue first.</span>
              </div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="screen-panel editor-panel">
        <div className="studio-body">
          <div className="video-panel">
            <div className="video-header">
              <span>Preview</span>
              <span className="video-duration">{formatTime(duration)}</span>
            </div>

            <div className="video-wrapper">
              {videoUrl ? (
                <video
                  ref={videoRef}
                  className="video-preview"
                  src={videoUrl}
                  playsInline
                  preload="auto"
                  controls={false}
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  onError={handleVideoError}
                  onEnded={() => {
                    const video = videoRef.current
                    if (playbackMode === 'selection' && video) {
                      video.currentTime = selectionStart
                      void video.play().catch(() => setIsPlaying(false))
                      return
                    }
                    setIsPlaying(false)
                  }}
                  onPause={() => setIsPlaying(false)}
                  onPlay={() => setIsPlaying(true)}
                />
              ) : (
                <div className="video-placeholder">
                  <div className="placeholder-icon">▶</div>
                  <span>{uploadError ? 'Unsupported video file' : 'Upload a video to begin'}</span>
                </div>
              )}
            </div>

            {uploadError ? (
              <div className="upload-error-banner">{uploadError}</div>
            ) : null}

            <div className="video-controls-row">
              <div className="playback-mode-controls" role="group" aria-label="Preview playback mode">
                <button
                  type="button"
                  className={`video-chip ${playbackMode === 'full' ? 'active' : ''}`}
                  aria-pressed={playbackMode === 'full'}
                  onClick={() => changePlaybackMode('full')}
                >
                  Full video
                </button>
                <button
                  type="button"
                  className={`video-chip ${playbackMode === 'selection' ? 'active' : ''}`}
                  aria-pressed={playbackMode === 'selection'}
                  onClick={() => changePlaybackMode('selection')}
                >
                  Selected section
                </button>
              </div>

              <div className="player-controls">
                <button className="mini-btn" type="button" onClick={() => stepVideo(-5)}>⏮</button>
                <button className="mini-btn" type="button" onClick={togglePlayback}>{isPlaying ? '⏸' : '▶'}</button>
                <button className="mini-btn" type="button" onClick={() => stepVideo(5)}>⏭</button>
                <div className="playback-time">{formatTime(currentTime)} / {formatTime(duration)}</div>
              </div>

              <div className="video-settings-bar" aria-label="Video settings">
                <div className="chip-group">
                  {[0.5, 1, 1.5, 2].map((speed) => (
                    <button
                      key={speed}
                      type="button"
                      className={`video-chip ${playbackSpeed === speed ? 'active' : ''}`}
                      onClick={() => setPlaybackSpeed(speed as SpeedPreset)}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
                <button type="button" className={`video-chip ${loopMode ? 'active' : ''}`} onClick={() => setLoopMode((value) => !value)}>
                  {loopMode ? 'Loop on' : 'Loop off'}
                </button>
                <div className="chip-group small-gap">
                  {(['Low', 'Medium', 'High'] as QualityPreset[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`video-chip ${qualityPreset === preset ? 'active' : ''}`}
                      onClick={() => setQualityPreset(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="seek-bar-wrap">
              <input
                type="range"
                max={playbackMode === 'selection' ? selectionEnd : duration || 0}
                min={playbackMode === 'selection' ? selectionStart : 0}
                step={0.01}
                value={currentTime}
                onChange={(event) => seekToTime(Number(event.target.value))}
                disabled={!videoUrl}
              />
            </div>
          </div>
        </div>

        <div className="timeline-panel">
          <div className="timeline-header">
            <span>Timeline</span>
            <div className="timeline-controls">
              <button className="small-btn" type="button" onClick={() => setSelectionAnchor('start')}>Set start</button>
              <button className="small-btn" type="button" onClick={() => setSelectionAnchor('end')}>Set end</button>
              <button className="small-btn" type="button" onClick={zoomToSelection}>Zoom to Selection</button>
              <button className="small-btn" type="button" onClick={resetTimelineView}>Reset view</button>
              <span className="timeline-zoom">Zoom: {zoomLevel}x</span>
            </div>
          </div>

          <div className="selection-inline-bar">
            <div className="selection-stats">
              <span className="selection-stat"><strong>Start</strong> {formatPreciseTime(selectionStart)}</span>
              <span className="selection-stat"><strong>End</strong> {formatPreciseTime(selectionEnd)}</span>
              <span className="selection-stat highlight"><strong>Duration</strong> {formatTime(selectionDuration)}</span>
            </div>
            <div className="chip-group" role="group" aria-label="Export format">
              <button type="button" className={`video-chip ${exportFormat === 'gif' ? 'active' : ''}`} aria-pressed={exportFormat === 'gif'} onClick={() => chooseExportFormat('gif')}>GIF</button>
              <button type="button" className={`video-chip ${exportFormat === 'mp4' ? 'active' : ''}`} aria-pressed={exportFormat === 'mp4'} onClick={() => chooseExportFormat('mp4')}>MP4 · silent</button>
            </div>
            <button className="primary-btn" type="button" disabled={!videoUrl || selectionDuration <= 0} onClick={addCurrentSelectionToQueue}>Add {exportFormat === 'gif' ? 'GIF' : 'MP4'}</button>
          </div>

          <div
            ref={trackRef}
            className="timeline-track"
            onPointerDown={handleTimelinePointerDown}
            aria-label={videoUrl ? 'Video timeline. Click to seek or drag the selection handles.' : 'Upload a video to show its timeline.'}
          >
            {timelineThumbnails.length > 0 ? (
              <div className="track-thumbnails" aria-hidden="true">
                {timelineThumbnails.map((thumbnail) => (
                  <img key={thumbnail.time} src={thumbnail.src} alt="" draggable={false} />
                ))}
              </div>
            ) : null}
            <div className="track-highlight" />
            <div
              className="track-selection"
              style={{
                left: `${Math.max(0, Math.min(visibleSelectionLeftPercent, 100))}%`,
                width: `${Math.max(0, Math.min(visibleSelectionWidthPercent, 100 - visibleSelectionLeftPercent))}%`,
                display: visibleSelectionEnd > visibleSelectionStart ? 'block' : 'none',
              }}
            />
            <div className="track-markers">
              <span>{formatTime(rangeStart)}</span>
              <span>{formatTime(rangeStart + visibleDuration * 0.25)}</span>
              <span>{formatTime(rangeStart + visibleDuration * 0.5)}</span>
              <span>{formatTime(rangeStart + visibleDuration * 0.75)}</span>
              <span>{formatTime(rangeEnd)}</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <main className="workspace">
      <div className="studio-shell">
        <aside className="studio-sidebar">
          <div className="brand-block">
            <div className="brand-mark">GIF</div>
            <span className="brand-name">GIF Studio</span>
          </div>

          <nav className="sidebar-nav" aria-label="Main navigation">
            <button className="nav-button active" type="button" disabled={processingActiveRef.current} onClick={startNewProject}>New</button>
            <button className="nav-button" type="button" disabled={processingActiveRef.current} onClick={() => uploadInputRef.current?.click()}>Open</button>
          </nav>

          <label className="upload-trigger" htmlFor="video-upload">
            <span>Select video</span>
            <input ref={uploadInputRef} id="video-upload" type="file" accept="video/*" onChange={handleFileChange} />
          </label>
        </aside>

        <section className="studio-main">
          <header className="studio-toolbar">
            <div className="file-meta">
              <span className="meta-label">Project</span>
              <strong>{videoName || 'No video selected'}</strong>
            </div>

            <div className="toolbar-actions">
              <label className={`ghost-btn upload-label ${processingActiveRef.current ? 'disabled-label' : ''}`} htmlFor="video-upload" aria-disabled={processingActiveRef.current}>
                Change video
              </label>
              <button className="primary-btn" type="button" disabled={!queue.length || processingActiveRef.current} onClick={() => void startProcessingQueue()}>
                Convert All
              </button>
            </div>
          </header>

          <div className="screen-tabs">
            {screens.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`tab-btn ${screen === item.key ? 'active' : ''}`}
                disabled={processingActiveRef.current || (item.key === 'processing' && screen !== 'processing')}
                onClick={() => setScreen(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {renderScreen()}
        </section>
      </div>
    </main>
  )
}

export default Workspace

