import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import GIF from 'gif.js.optimized'
import gifWorkerUrl from 'gif.js.optimized/dist/gif.worker.js?url'

type ScreenKey = 'empty' | 'loaded' | 'selection' | 'batch' | 'processing' | 'results'

type QueueItem = {
  id: number
  label: string
  start: number
  end: number
  gifUrl?: string
  gifSizeBytes?: number
  error?: string
}

type SpeedPreset = 0.5 | 1 | 1.5 | 2

type QualityPreset = 'Low' | 'Medium' | 'High'
type ResolutionPreset = '480p' | '720p' | 'Original'
type PlaybackMode = 'full' | 'selection'

type TimelineThumbnail = {
  time: number
  src: string
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

const loadExportVideo = (src: string) => new Promise<HTMLVideoElement>((resolve, reject) => {
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
  }
  const onLoaded = () => {
    cleanup()
    resolve(video)
  }
  const onError = () => {
    cleanup()
    reject(new Error('The source video could not be decoded for GIF conversion.'))
  }

  video.addEventListener('loadedmetadata', onLoaded, { once: true })
  video.addEventListener('error', onError, { once: true })
  video.src = src
  video.load()
})

const getDefaultSelectionRange = (videoDuration: number) => {
  const safeDuration = Number.isFinite(videoDuration) ? Math.max(0, videoDuration) : 0
  const fallbackLength = Math.min(30, safeDuration || 30)
  const end = safeDuration > 0 ? Math.min(fallbackLength, safeDuration) : fallbackLength

  return {
    start: 0,
    end,
  }
}

const screens: { key: ScreenKey; label: string }[] = [
  { key: 'empty', label: '01 Empty state' },
  { key: 'loaded', label: '02 Video loaded' },
  { key: 'selection', label: '05 Fine selection' },
  { key: 'batch', label: '07 Batch extraction' },
  { key: 'processing', label: '09 Processing' },
  { key: 'results', label: '10 GIF result' },
]

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
  const [timelineThumbnails, setTimelineThumbnails] = useState<TimelineThumbnail[]>([])
  const [selectionFrame, setSelectionFrame] = useState<string | null>(null)
  const [clipLengthSeconds, setClipLengthSeconds] = useState(10)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [processingProgress, setProcessingProgress] = useState(0)
  const [processingLabel, setProcessingLabel] = useState('')
  const [processingCount, setProcessingCount] = useState({ current: 0, total: 0 })
  const cancelProcessingRef = useRef(false)
  const activeGifRef = useRef<{ abort: () => void } | null>(null)
  const [timelineWindowStart, setTimelineWindowStart] = useState(0)
  const [timelineWindowEnd, setTimelineWindowEnd] = useState(0)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueScrollTop, setQueueScrollTop] = useState(0)

  const selectionDuration = Math.max(0, selectionEnd - selectionStart)

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
    if (screen === 'processing') {
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
        id: Date.now() + index,
        label: `GIF ${String(queue.length + index + 1).padStart(2, '0')}`,
        start: itemStart,
        end: itemEnd,
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
      if (Math.abs(video.currentTime - value) < 0.001) {
        resolve()
        return
      }

      const timeout = window.setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out seeking to ${formatPreciseTime(value)}.`))
      }, 15000)
      const cleanup = () => {
        window.clearTimeout(timeout)
        video.removeEventListener('seeked', handleSeeked)
        video.removeEventListener('error', handleError)
      }
      const handleSeeked = () => {
        cleanup()
        resolve()
      }
      const handleError = () => {
        cleanup()
        reject(new Error('The video could not seek to a frame for GIF conversion.'))
      }

      video.addEventListener('seeked', handleSeeked, { once: true })
      video.addEventListener('error', handleError, { once: true })
      try {
        video.currentTime = value
      } catch (error) {
        cleanup()
        reject(error)
      }
    })

  const createGifFromRange = async (item: QueueItem, video: HTMLVideoElement, reportProgress: (value: number) => void): Promise<QueueItem> => {
    const start = Math.min(item.start, item.end)
    const end = Math.max(item.start, item.end)
    const clipDuration = Math.max(0.05, end - start)
    const qualityMap: Record<QualityPreset, number> = {
      Low: 20,
      Medium: 12,
      High: 10,
    }
    const widthLimit: Record<ResolutionPreset, number> = {
      '480p': 854,
      '720p': 1280,
      Original: video.videoWidth || 1280,
    }
    const baseWidth = Math.max(320, Math.min(video.videoWidth || 1280, widthLimit[renderResolution]))
    const width = Math.max(320, Math.round(baseWidth))
    const height = Math.max(180, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width))
    const frameRate = renderFps
    const sampleFrames = Math.max(1, Math.min(300, Math.ceil(clipDuration * frameRate)))
    const frameDelay = (clipDuration * 1000) / sampleFrames
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('Could not create a canvas for GIF conversion.')
    }

    canvas.width = width
    canvas.height = height

    const gif = new GIF({
      workers: 2,
      quality: qualityMap[qualityPreset],
      workerScript: gifWorkerUrl,
      width,
      height,
      repeat: 0,
    })
    activeGifRef.current = gif

    for (let index = 0; index < sampleFrames; index += 1) {
      if (cancelProcessingRef.current) throw new Error('Cancelled by user.')
      const time = Math.min(start + ((index / sampleFrames) * clipDuration), Math.max(0, video.duration - 0.01))
      await seekVideoToTime(video, time)
      context.drawImage(video, 0, 0, width, height)
      gif.addFrame(canvas, { copy: true, delay: frameDelay })
      reportProgress(((index + 1) / sampleFrames) * 0.5)
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      gif.on('finished', (result: Blob) => resolve(result))
      gif.on('abort', () => reject(new Error('GIF export aborted')))
      gif.on('error', (error: Error) => reject(error))
      gif.on('progress', (progress: number) => {
        reportProgress(0.5 + progress * 0.5)
      })
      gif.render()
    })

    return {
      ...item,
      gifUrl: URL.createObjectURL(blob),
      gifSizeBytes: blob.size,
      error: undefined,
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
        id: Date.now(),
        label: `GIF ${String(currentQueue.length + 1).padStart(2, '0')}`,
        start: safeStart,
        end: safeEnd,
      },
    ])
    setQueueScrollTop(0)

    setScreen('batch')
  }

  const startProcessingQueue = async (retryFailed = false, onlyItemId?: number) => {
    const itemsToProcess = retryFailed
      ? queue.filter((item) => item.error && (onlyItemId === undefined || item.id === onlyItemId))
      : queue
    if (!itemsToProcess.length || !videoUrl || screen === 'processing') {
      return
    }

    cancelProcessingRef.current = false
    setProcessingCount({ current: 0, total: itemsToProcess.length })
    setProcessingLabel('Preparing video…')
    setProcessingProgress(0)
    setScreen('processing')
    let exportVideo: HTMLVideoElement | null = null

    try {
      exportVideo = await loadExportVideo(videoUrl)
      const processedQueue: QueueItem[] = []

      for (let index = 0; index < itemsToProcess.length; index += 1) {
        if (cancelProcessingRef.current) break
        const item = itemsToProcess[index]
        setProcessingCount({ current: index + 1, total: itemsToProcess.length })
        setProcessingLabel(item.label)
        let processedItem: QueueItem
        try {
          processedItem = await createGifFromRange(item, exportVideo, (itemProgress) => {
            setProcessingProgress(((index + itemProgress) / itemsToProcess.length) * 100)
          })
        } catch (error) {
          processedItem = {
            ...item,
            error: cancelProcessingRef.current ? 'Cancelled by user.' : error instanceof Error ? error.message : 'This clip could not be converted.',
          }
        }
        processedQueue.push(processedItem)
        setProcessingProgress(((index + 1) / itemsToProcess.length) * 100)
        if (cancelProcessingRef.current) break
      }

      const processedById = new Map(processedQueue.map((item) => [item.id, item]))
      setQueue((currentQueue) => currentQueue.map((item) => {
        const processedItem = processedById.get(item.id)
        if (!processedItem) {
          if (cancelProcessingRef.current && itemsToProcess.some((pendingItem) => pendingItem.id === item.id)) {
            return { ...item, error: item.error || 'Cancelled by user.' }
          }
          return item
        }
        if (item.gifUrl && processedItem.gifUrl && item.gifUrl !== processedItem.gifUrl) URL.revokeObjectURL(item.gifUrl)
        return processedItem
      }))
      setScreen('results')
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'The source video could not be prepared for conversion.')
      setScreen('loaded')
    } finally {
      activeGifRef.current = null
      if (exportVideo) {
        exportVideo.pause()
        exportVideo.removeAttribute('src')
        exportVideo.load()
      }
    }
  }

  const cancelProcessing = () => {
    cancelProcessingRef.current = true
    activeGifRef.current?.abort()
  }

  const downloadAllGifs = () => {
    const completed = queue.filter((item) => item.gifUrl)
    completed.forEach((item) => {
      const link = document.createElement('a')
      link.href = item.gifUrl as string
      link.download = `${item.label}.gif`
      document.body.appendChild(link)
      link.click()
      link.remove()
    })
  }

  const startNewProject = () => {
    videoRef.current?.pause()
    queue.forEach((item) => {
      if (item.gifUrl) URL.revokeObjectURL(item.gifUrl)
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
            <button
              className="primary-btn"
              type="button"
              disabled={!videoUrl || selectionDuration <= 0}
              onClick={addCurrentSelectionToQueue}
            >
              Add as one GIF
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
              {[5, 9, 10, 12, 15].map((seconds) => (
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
                  <p className="empty-queue-text">No GIFs queued yet.</p>
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
              <button className="primary-btn queue-button" type="button" disabled={!queue.length} onClick={startProcessingQueue}>
                Convert Selected
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (screen === 'processing') {
      const progressValue = Math.round(processingProgress)

      return (
        <div className="screen-panel processing-panel processing-overlay" role="status" aria-live="polite">
          <div
            className="progress-ring"
            role="progressbar"
            aria-label="GIF conversion progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressValue}
            style={{ background: `conic-gradient(#22c55e 0 ${progressValue}%, rgba(148, 163, 184, 0.16) ${progressValue}% 100%)` }}
          >
            <div className="progress-inner">{progressValue}%</div>
          </div>
          <div className="processing-copy">
            <h3>Processing GIFs</h3>
            <p>{processingLabel ? `Now converting ${processingLabel}` : 'Preparing your video…'}</p>
            <p>GIF {processingCount.current} of {processingCount.total}</p>
          </div>
          <button className="ghost-btn" type="button" onClick={cancelProcessing}>Cancel conversion</button>
        </div>
      )
    }

    if (screen === 'results') {
      const completedCount = queue.filter((item) => item.gifUrl).length
      const failedCount = queue.filter((item) => item.error).length

      return (
        <div className="screen-panel results-panel">
          <div className="results-header">
            <div>
              <span className="mini-label">GIF Collection</span>
              <h3>{completedCount > 0 ? `${completedCount} GIF${completedCount === 1 ? '' : 's'} ready to save` : 'No GIFs ready to save'}{failedCount > 0 ? ` · ${failedCount} need attention` : ''}</h3>
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
            {queue.some((item) => item.gifUrl) ? (
              <button className="primary-btn" type="button" onClick={downloadAllGifs}>Download All GIFs</button>
            ) : null}
            {queue.some((item) => item.error) ? (
              <button className="ghost-btn" type="button" onClick={() => void startProcessingQueue(true)}>Retry Failed</button>
            ) : null}
          </div>

          <div className="result-grid">
            {queue.length > 0 ? (
              queue.map((item, index) => (
                <div className="result-card" key={item.id}>
                  {item.gifUrl ? (
                    <img className="mini-thumb" src={item.gifUrl} alt={item.label} />
                  ) : (
                    <div className="mini-thumb" />
                  )}
                  <strong>{item.label}</strong>
                  <span>{formatTime(item.end - item.start)}</span>
                  {item.gifUrl && typeof item.gifSizeBytes === 'number' ? <span className="result-file-size">{formatFileSize(item.gifSizeBytes)}</span> : null}
                  <small>#{index + 1}</small>
                  {item.gifUrl ? (
                    <a className="download-link" href={item.gifUrl} download={`${item.label}.gif`}>
                      Download GIF
                    </a>
                  ) : item.error ? (
                    <>
                      <span className="render-error">Conversion failed: {item.error}</span>
                      <button className="small-btn" type="button" onClick={() => void startProcessingQueue(true, item.id)}>Retry this GIF</button>
                    </>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="result-card empty-result-card">
                <strong>No GIFs generated yet</strong>
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
            <button className="primary-btn" type="button" disabled={!videoUrl || selectionDuration <= 0} onClick={addCurrentSelectionToQueue}>Add as one GIF</button>
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
            <button className="nav-button active" type="button" disabled={screen === 'processing'} onClick={startNewProject}>New</button>
            <button className="nav-button" type="button" disabled={screen === 'processing'} onClick={() => uploadInputRef.current?.click()}>Open</button>
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
              <label className={`ghost-btn upload-label ${screen === 'processing' ? 'disabled-label' : ''}`} htmlFor="video-upload" aria-disabled={screen === 'processing'}>
                Change video
              </label>
              <button className="primary-btn" type="button" disabled={!queue.length || screen === 'processing'} onClick={startProcessingQueue}>
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
                disabled={screen === 'processing'}
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

