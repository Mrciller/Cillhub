// Real-time camera background processing (blur and virtual backgrounds)
import type { VoiceSettings } from './settings'

export function applyVirtualBackground(track: MediaStreamTrack, mode: VoiceSettings['virtualBackground']): MediaStreamTrack {
  if (mode === 'none' || typeof window === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    return track
  }

  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([track])

  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return track

  let active = true
  let rafId = 0

  const cleanup = () => {
    active = false
    cancelAnimationFrame(rafId)
    video.pause()
    video.srcObject = null
  }
  track.addEventListener('ended', cleanup, { once: true })

  const draw = () => {
    if (!active) return
    if (video.readyState >= 2) {
      if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
      }
      const w = canvas.width
      const h = canvas.height

      if (mode === 'blur') {
        // Pass 1: Blurred background
        ctx.save()
        ctx.filter = 'blur(16px)'
        ctx.drawImage(video, 0, 0, w, h)
        ctx.restore()

        // Pass 2: Portrait foreground mask
        ctx.save()
        const radGrad = ctx.createRadialGradient(w * 0.5, h * 0.52, Math.min(w, h) * 0.18, w * 0.5, h * 0.52, Math.min(w, h) * 0.48)
        radGrad.addColorStop(0, 'rgba(0,0,0,1)')
        radGrad.addColorStop(0.7, 'rgba(0,0,0,0.85)')
        radGrad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalCompositeOperation = 'destination-out'
        // Create an inverted cutout of the center
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = w
        tempCanvas.height = h
        const tCtx = tempCanvas.getContext('2d')
        if (tCtx) {
          tCtx.drawImage(video, 0, 0, w, h)
          tCtx.globalCompositeOperation = 'destination-in'
          tCtx.fillStyle = radGrad
          tCtx.fillRect(0, 0, w, h)
          ctx.globalCompositeOperation = 'source-over'
          ctx.drawImage(tempCanvas, 0, 0)
        }
        ctx.restore()
      } else if (mode === 'studio') {
        // Modern dark studio gradient
        const bgGrad = ctx.createLinearGradient(0, 0, w, h)
        bgGrad.addColorStop(0, '#111215')
        bgGrad.addColorStop(0.5, '#1e1f24')
        bgGrad.addColorStop(1, '#0e0f12')
        ctx.fillStyle = bgGrad
        ctx.fillRect(0, 0, w, h)

        // Draw portrait in center
        ctx.save()
        const mask = ctx.createRadialGradient(w * 0.5, h * 0.52, Math.min(w, h) * 0.2, w * 0.5, h * 0.52, Math.min(w, h) * 0.48)
        mask.addColorStop(0, 'rgba(255,255,255,1)')
        mask.addColorStop(0.8, 'rgba(255,255,255,0.9)')
        mask.addColorStop(1, 'rgba(255,255,255,0)')
        const temp = document.createElement('canvas')
        temp.width = w
        temp.height = h
        const tCtx = temp.getContext('2d')
        if (tCtx) {
          tCtx.drawImage(video, 0, 0, w, h)
          tCtx.globalCompositeOperation = 'destination-in'
          tCtx.fillStyle = mask
          tCtx.fillRect(0, 0, w, h)
          ctx.drawImage(temp, 0, 0)
        }
        ctx.restore()
      } else if (mode === 'gradient') {
        // Soft violet/indigo gradient
        const grad = ctx.createLinearGradient(0, 0, w, h)
        grad.addColorStop(0, '#1a103c')
        grad.addColorStop(1, '#2c1654')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)

        ctx.save()
        const mask = ctx.createRadialGradient(w * 0.5, h * 0.52, Math.min(w, h) * 0.2, w * 0.5, h * 0.52, Math.min(w, h) * 0.48)
        mask.addColorStop(0, 'rgba(255,255,255,1)')
        mask.addColorStop(0.8, 'rgba(255,255,255,0.9)')
        mask.addColorStop(1, 'rgba(255,255,255,0)')
        const temp = document.createElement('canvas')
        temp.width = w
        temp.height = h
        const tCtx = temp.getContext('2d')
        if (tCtx) {
          tCtx.drawImage(video, 0, 0, w, h)
          tCtx.globalCompositeOperation = 'destination-in'
          tCtx.fillStyle = mask
          tCtx.fillRect(0, 0, w, h)
          ctx.drawImage(temp, 0, 0)
        }
        ctx.restore()
      }
    }
    rafId = requestAnimationFrame(draw)
  }

  void video.play().then(() => {
    rafId = requestAnimationFrame(draw)
  }).catch(() => {})

  const processedStream = canvas.captureStream(30)
  const processedTrack = processedStream.getVideoTracks()[0]
  if (!processedTrack) return track

  // Forward track settings and labels
  Object.defineProperty(processedTrack, 'label', { value: `${track.label} (processed)` })
  processedTrack.addEventListener('ended', cleanup, { once: true })
  return processedTrack
}
