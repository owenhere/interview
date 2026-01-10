import React, { useEffect, useRef, useState } from 'react'
import { Card, Button, Modal, Spin } from 'antd'
import '../styles/interview.css'
import { AudioOutlined, StopOutlined, SoundOutlined, AudioMutedOutlined } from '@ant-design/icons'
import { API_BASE, generateQuestions, finalizeUpload } from '../api'

// Total interview session timer shown in the header.
// Increase if you want longer interviews.
const MAX_DURATION_SECONDS = 15 * 60

function formatTime(totalSeconds) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function pickBestMimeType() {
  // Prefer H.264 (mp4) when supported. Fall back to WebM.
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  try {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
      for (const t of candidates) {
        if (t && MediaRecorder.isTypeSupported(t)) return t
      }
    }
  } catch (e) {}
  return 'video/webm'
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'recording.webm'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export default function Interview({ name, email, country, phone, interviewId, stack, refSource }) {
  const [questions, setQuestions] = useState([])
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [mediaStream, setMediaStream] = useState(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [lastRecording, setLastRecording] = useState(null) // { blob, filename }
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [thankYouOpen, setThankYouOpen] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [voiceLevel, setVoiceLevel] = useState(0)
  const mediaRef = useRef(null)
  const recorderRef = useRef(null)
  const screenRecorderRef = useRef(null)
  const screenStreamRef = useRef(null) // display stream (for cleanup)
  const pipRafRef = useRef(null)
  const stopReasonRef = useRef(null) // 'user' | 'timeout' | null
  const chunksRef = useRef([]) // legacy (camera chunks) - no longer uploaded
  const screenChunksRef = useRef([])
  const questionsRef = useRef([])
  const sessionIdRef = useRef(null)
  const uploadPromiseRef = useRef(null) // legacy; kept for safety
  const uploadQueueRef = useRef(Promise.resolve())
  const hasChunkRef = useRef(false)
  const cameraStoppedPromiseRef = useRef(null)
  const cameraStoppedResolveRef = useRef(null)
  const screenStoppedPromiseRef = useRef(null)
  const screenStoppedResolveRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const audioDataRef = useRef(null)
  const voiceRafRef = useRef(null)
  const lastVoiceTickRef = useRef(0)
  const speakingRef = useRef(false)
  const autoStopTriggeredRef = useRef(false)
  const recordingRef = useRef(false)
  const uploadingRef = useRef(false)
  const completedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const fallback = [
      'Please introduce yourself briefly (role, years of experience, and the kind of work you do most).',
      'Walk me through a recent project you owned end-to-end. What were the requirements, your approach, and the final impact?',
      'Describe a time you had to debug a difficult issue in production. How did you diagnose it and what did you change?',
      'How do you communicate trade-offs to non-technical stakeholders when deadlines are tight?',
      'What do you do to ensure code quality (testing, reviews, CI, monitoring)? Give a concrete example.'
    ]

    ;(async () => {
      setLoading(true)
      try {
        const data = await generateQuestions({
          num: 5,
          topic: 'professional English software engineer interview',
          stack,
        })
        if (!cancelled && Array.isArray(data.questions) && data.questions.length) {
          setQuestions(data.questions)
        } else if (!cancelled) {
          setQuestions(fallback)
        }
      } catch (err) {
        console.warn('Could not load questions from server, using fallback', err)
        if (!cancelled) setQuestions(fallback)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!recording) return
    const interval = setInterval(() => {
      setElapsedSeconds(prev => (prev >= MAX_DURATION_SECONDS ? prev : prev + 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [recording])

  useEffect(() => { recordingRef.current = !!recording }, [recording])
  useEffect(() => { uploadingRef.current = !!uploading }, [uploading])
  useEffect(() => { completedRef.current = !!thankYouOpen }, [thankYouOpen])
  useEffect(() => { questionsRef.current = Array.isArray(questions) ? questions : [] }, [questions])

  useEffect(() => {
    if (!recording) return
    if (elapsedSeconds < MAX_DURATION_SECONDS) return
    if (autoStopTriggeredRef.current) return
    autoStopTriggeredRef.current = true
    // Auto-end the interview when time runs out (same as clicking "Finish Interview").
    stopReasonRef.current = 'timeout'
    stopRecording().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedSeconds, recording])

  useEffect(() => {
    sessionIdRef.current = `${(name || 'user').replace(/\s+/g, '_')}-${Date.now()}`
  }, [name])

  useEffect(() => {
    const tryFinalizeOnHide = () => {
      try {
        // If we haven't produced any chunks yet, finalizing will fail ("no chunks found").
        // This can happen if the tab closes before the first MediaRecorder timeslice fires.
        if (!hasChunkRef.current) return
        // Do not attempt to finalize while actively recording or uploading.
        // (On some devices, visibility changes can happen mid-recording and would otherwise create partial files.)
        if (recordingRef.current) return
        if (uploadingRef.current) return
        if (completedRef.current) return
        if (recorderRef.current && recorderRef.current.state !== 'inactive') return
        const url = `${API_BASE}/upload-complete-beacon`
        const payload = JSON.stringify({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId, source: refSource, questions: questionsRef.current })
        if (navigator.sendBeacon) {
          const blob = new Blob([payload], { type: 'application/json' })
          navigator.sendBeacon(url, blob)
        } else {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', url, false)
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.send(payload)
        }
      } catch (e) { console.warn('beacon finalize failed', e) }
    }

    const tryFinalizeOnUnload = () => {
      try {
        if (!hasChunkRef.current) return
        // If we're already uploading or completed, don't re-finalize.
        if (uploadingRef.current) return
        if (completedRef.current) return

        // On unload we want best-effort finalization of chunks already uploaded.
        // Use `force:true` so the server assembles even if recordingActive is still true.
        const url = `${API_BASE}/upload-complete-beacon`
        const payload = JSON.stringify({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId, source: refSource, force: true, questions: questionsRef.current })
        if (navigator.sendBeacon) {
          const blob = new Blob([payload], { type: 'application/json' })
          navigator.sendBeacon(url, blob)
        } else {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', url, false)
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.send(payload)
        }
      } catch (e) { /* ignore */ }
    }

    const onVisibility = () => { if (document.visibilityState === 'hidden') tryFinalizeOnHide() }
    window.addEventListener('beforeunload', tryFinalizeOnUnload)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', tryFinalizeOnUnload)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [name])

  useEffect(() => {
    return () => {
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop())
      try { if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach(t => t.stop()) } catch (e) {}
      try { if (pipRafRef.current) cancelAnimationFrame(pipRafRef.current) } catch (e) {}
    }
  }, [mediaStream])

  const stopVoiceDetection = () => {
    try {
      if (voiceRafRef.current) cancelAnimationFrame(voiceRafRef.current)
    } catch (e) {}
    voiceRafRef.current = null
    analyserRef.current = null
    audioDataRef.current = null
    try {
      if (audioCtxRef.current) audioCtxRef.current.close()
    } catch (e) {}
    audioCtxRef.current = null
    speakingRef.current = false
    setSpeaking(false)
    setVoiceLevel(0)
  }

  const startVoiceDetection = async (stream) => {
    stopVoiceDetection()
    try {
      if (!stream) return
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) return

      const ctx = new AudioCtx()
      audioCtxRef.current = ctx
      // This call is safe in a user-gesture initiated flow (startRecording click)
      try { await ctx.resume() } catch (e) {}

      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.85
      source.connect(analyser)
      analyserRef.current = analyser
      audioDataRef.current = new Uint8Array(analyser.fftSize)

      const THRESHOLD = 0.035 // RMS threshold; tuned for typical laptop mics
      const tick = (t) => {
        const a = analyserRef.current
        const buf = audioDataRef.current
        if (!a || !buf) return

        a.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)

        // Update UI at ~8fps to avoid excessive re-renders
        if (!lastVoiceTickRef.current || (t - lastVoiceTickRef.current) > 120) {
          lastVoiceTickRef.current = t
          setVoiceLevel(rms)
          const isSpeakingNow = rms > THRESHOLD
          if (isSpeakingNow !== speakingRef.current) {
            speakingRef.current = isSpeakingNow
            setSpeaking(isSpeakingNow)
          }
        }

        voiceRafRef.current = requestAnimationFrame(tick)
      }

      voiceRafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      console.warn('voice detection unavailable', e)
      stopVoiceDetection()
    }
  }

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setMediaStream(stream)
      if (mediaRef.current) {
        mediaRef.current.srcObject = stream
        // Some browsers require an explicit play() even with autoPlay.
        try { await mediaRef.current.play() } catch (e) {}
      }
      return stream
    } catch (err) {
      console.warn('Could not access camera/microphone', err)
      return null
    }
  }

  const startDisplayStreamRequireMonitor = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Screen sharing is not supported in this browser.')
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 30 },
          // best-effort hint; browsers may ignore
          displaySurface: 'monitor',
        },
        audio: false,
      })

      const vt = display.getVideoTracks()[0]
      const surface = vt && vt.getSettings ? vt.getSettings().displaySurface : ''
      if (surface === 'monitor') return display

      // Not entire screen; stop and ask again.
      try { display.getTracks().forEach(t => t.stop()) } catch (e) {}
      if (attempt < 2) {
        setUploadError('Please share your Entire Screen (not a single tab/app). When prompted, choose "Entire Screen".')
      }
    }

    throw new Error('Please share your Entire Screen (not a single tab/app).')
  }

  const startScreenRecorderWithCameraPip = async ({ displayStream, cameraStream }) => {
    const screenTrack = displayStream.getVideoTracks()[0]
    if (!screenTrack) throw new Error('No screen video track available.')

    const screenVideo = document.createElement('video')
    screenVideo.muted = true
    screenVideo.playsInline = true
    screenVideo.srcObject = new MediaStream([screenTrack])

    const camVideo = document.createElement('video')
    camVideo.muted = true
    camVideo.playsInline = true
    camVideo.srcObject = cameraStream

    try { await screenVideo.play() } catch (e) {}
    try { await camVideo.play() } catch (e) {}

    const screenSettings = screenTrack.getSettings ? screenTrack.getSettings() : {}
    const width = Math.max(640, Number(screenSettings.width) || 1280)
    const height = Math.max(360, Number(screenSettings.height) || 720)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not supported.')

    const draw = () => {
      try {
        ctx.drawImage(screenVideo, 0, 0, width, height)

        const pipW = Math.round(width * 0.22)
        const pipH = Math.round(pipW * 9 / 16)
        const pad = Math.round(width * 0.02)
        const x = width - pipW - pad
        const y = height - pipH - pad

        ctx.save()
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'
        ctx.lineWidth = Math.max(2, Math.round(width * 0.002))
        const r = Math.max(8, Math.round(width * 0.008))
        ctx.beginPath()
        ctx.moveTo(x + r, y)
        ctx.arcTo(x + pipW, y, x + pipW, y + pipH, r)
        ctx.arcTo(x + pipW, y + pipH, x, y + pipH, r)
        ctx.arcTo(x, y + pipH, x, y, r)
        ctx.arcTo(x, y, x + pipW, y, r)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        ctx.clip()
        ctx.drawImage(camVideo, x, y, pipW, pipH)
        ctx.restore()
      } catch (e) {}
      pipRafRef.current = requestAnimationFrame(draw)
    }
    pipRafRef.current = requestAnimationFrame(draw)

    const outStream = canvas.captureStream(30)
    // Prefer mic audio for interview audio
    const mic = cameraStream.getAudioTracks && cameraStream.getAudioTracks()[0]
    if (mic) outStream.addTrack(mic)

    const screenPreferred = pickBestMimeType()
    const screenOptions = {
      mimeType: screenPreferred,
      videoBitsPerSecond: 1_400_000,
      audioBitsPerSecond: 64_000,
    }

    const smr = new MediaRecorder(outStream, screenOptions)
    return smr
  }

  const startRecording = async () => {
    // Reset auto-stop guard for a new recording.
    autoStopTriggeredRef.current = false
    stopReasonRef.current = null
    setThankYouOpen(false)
    let stream = mediaRef.current?.srcObject || mediaStream
    if (!stream) stream = await startCamera()
    if (!stream) {
      // Most commonly: user denied permissions or browser blocked prompt.
      setUploadError('Please allow camera & microphone access, then try again.')
      setRecording(false)
      return
    }

    // Screen share is REQUIRED (and must be "Entire Screen" best-effort).
    let display = null
    try {
      setUploadError('')
      display = await startDisplayStreamRequireMonitor()
    } catch (e) {
      setUploadError(e?.message || 'Screen sharing is required to start the interview.')
      setRecording(false)
      return
    }
    // best-effort voice detection (does not block recording)
    if (stream) startVoiceDetection(stream)

    chunksRef.current = []
    screenChunksRef.current = []
    // We no longer upload a separate "camera-only" file. Camera is embedded into the screen recording via PIP.
    recorderRef.current = null
    screenRecorderRef.current = null
    screenStreamRef.current = display
    setLastRecording(null)
    setUploadError('')

    // stop promises for coordination (upload after both camera+screen stop)
    cameraStoppedPromiseRef.current = null
    cameraStoppedResolveRef.current = null
    screenStoppedPromiseRef.current = null
    screenStoppedResolveRef.current = null

    // Start mandatory screen recorder with camera PIP (bottom-right).
    try {
      const smr = await startScreenRecorderWithCameraPip({ displayStream: display, cameraStream: stream })
      screenRecorderRef.current = smr
      screenStoppedPromiseRef.current = new Promise((resolve) => { screenStoppedResolveRef.current = resolve })
      smr.ondataavailable = (e) => {
        if (e.data && e.data.size) screenChunksRef.current.push(e.data)
      }
      smr.onstop = () => {
        try { if (screenStoppedResolveRef.current) screenStoppedResolveRef.current() } catch (e) {}
      }
      smr.onerror = (ev) => {
        console.error('Screen recorder error', ev)
        try { if (smr && smr.state !== 'inactive') smr.stop() } catch (e) {}
      }

      // If the user ends screen sharing, end the interview too.
      try {
        const vt = display.getVideoTracks()[0]
        if (vt) vt.onended = () => { stopRecording().catch(() => {}) }
      } catch (e) {}
    } catch (e) {
      try { if (display) display.getTracks().forEach(t => t.stop()) } catch (err) {}
      setUploadError(e?.message || 'Could not start screen recording. Please try again.')
      setRecording(false)
      return
    }
    // Smaller timeslice => smaller chunks (helps avoid 413 from proxies with small body limits).
    try {
      try { if (screenRecorderRef.current) screenRecorderRef.current.start(2000) } catch (e) {}
      setRecording(true)
    } catch (e) {
      console.warn('MediaRecorder start failed', e)
      setUploadError('Could not start recording. Please check permissions and try again.')
      setRecording(false)
    }
  }

  const uploadFinal = async ({ kind, mr, chunks }) => {
    const mimeType = (mr && mr.mimeType) ? mr.mimeType : 'video/webm'
    const blob = new Blob(chunks || [], { type: mimeType })
    const fd = new FormData()
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const filename = `${sessionIdRef.current || 'session'}-${kind}-${Date.now()}.${ext}`
    fd.append('video', blob, filename)
    fd.append('metadata', JSON.stringify({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId, source: refSource, questions: questionsRef.current, kind }))
    // Retry final upload a couple times for transient server load / network blips.
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(`${API_BASE}/upload-answer`, { method: 'POST', body: fd })
        try { await resp.json() } catch (e) {}
        if (!resp.ok) throw new Error(`upload-answer failed (${resp.status})`)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)))
      }
    }
    if (lastErr) throw lastErr
    return { ok: true, blob, filename }
  }

  const stopRecording = async () => {
    // Mark explicit user stop (unless already timeout).
    stopReasonRef.current = stopReasonRef.current || 'user'
    stopVoiceDetection()
    if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
      try { screenRecorderRef.current.stop() } catch (e) {}
    }
    setRecording(false)
    // Wait for both recorders to finish flushing data.
    try {
      const waits = []
      if (cameraStoppedPromiseRef.current) waits.push(cameraStoppedPromiseRef.current)
      if (screenStoppedPromiseRef.current) waits.push(screenStoppedPromiseRef.current)
      if (waits.length) await Promise.allSettled(waits)
    } catch (e) {}

    // If recording stopped without explicit "Finish" click or a timeout, do not upload.
    if (!stopReasonRef.current) {
      setUploadError('Recording stopped unexpectedly. Please try again.')
      return
    }

    setUploading(true)
    setUploadError('')
    let ok = false
    try {
      if (!screenRecorderRef.current || !screenChunksRef.current.length) {
        throw new Error('No screen recording captured.')
      }
      const r = await uploadFinal({ kind: 'screen_pip', mr: screenRecorderRef.current, chunks: screenChunksRef.current })
      setLastRecording({ blob: r.blob, filename: r.filename })
      ok = true
    } catch (e) {
      console.warn('upload-answer (screen_pip) failed', e)
      ok = false
    }

    if (ok) setThankYouOpen(true)
    else setUploadError('Upload failed. Please try again.')

    // Cleanup
    chunksRef.current = []
    screenChunksRef.current = []
    try { if (screenStreamRef.current) screenStreamRef.current.getTracks().forEach(t => t.stop()) } catch (e) {}
    screenStreamRef.current = null
    try { if (pipRafRef.current) cancelAnimationFrame(pipRafRef.current) } catch (e) {}
    pipRafRef.current = null
    setUploading(false)
    try { localStorage.setItem('interview_locked', 'true') } catch (e) {}
  }

  if (loading) return <Card className="card">Loading questions…</Card>
  if (!questions.length) return <Card className="card">No questions available.</Card>

  return (
    <div className="interview-page" role="main">
      <div className="interview-shell">
        <Modal
          open={uploading}
          centered
          closable={false}
          footer={null}
          maskClosable={false}
          width={420}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '18px 6px' }}>
            <Spin size="large" />
            <div style={{ fontWeight: 700, fontSize: 16 }}>Uploading your interview…</div>
            <div style={{ fontSize: 13, color: 'rgba(107,114,128,0.95)', textAlign: 'center' }}>
              Please keep this tab open. This may take a moment on slow networks.
            </div>
          </div>
        </Modal>

        <Modal
          open={thankYouOpen}
          onOk={() => setThankYouOpen(false)}
          onCancel={() => setThankYouOpen(false)}
          okText="Done"
          cancelButtonProps={{ style: { display: 'none' } }}
          title="Thank you for completing your interview"
        >
          <div>
            <p style={{ marginTop: 0 }}>
              Your recording has been uploaded successfully.
            </p>
            <p>
              Our team will review your interview and contact you using the email you provided.
            </p>
            <p style={{ marginBottom: 0 }}>
              You may now close this tab.
            </p>
          </div>
        </Modal>

        <header className="session-header">
          <div>
            <div className="session-title">Interview Session</div>
            <div className="session-subtitle">
              {name || 'Candidate'}
              {email ? ` (${email})` : null}
              {country ? ` • ${country}` : null}
            </div>
          </div>
          <div className="session-timer">
            <div className="session-timer-label">Total Time</div>
            <div className="session-timer-value">
              {formatTime(elapsedSeconds)} / {formatTime(MAX_DURATION_SECONDS)}
            </div>
          </div>
        </header>

        <main className="session-layout">
          <section className="session-main">
            <Card className="session-card">
              <div className="session-card-title">Camera Preview</div>
              <div className="camera-wrapper">
                <video ref={mediaRef} autoPlay playsInline muted className="video-preview" />
                <div className="camera-status-pill">
                  {recording ? 'Recording' : 'Ready'}
                </div>
                {recording ? (
                  (() => {
                    // Normalize RMS into a 0..1 "volume" for UI.
                    // Typical RMS values on laptop mics are small (often < 0.12).
                    const volume = Math.max(0, Math.min(1, (voiceLevel - 0.02) / 0.10))
                    const iconScale = speaking ? (0.95 + volume * 0.65) : 0.95
                    const meterWidth = 44 // px
                    const meterFill = Math.round(meterWidth * volume)
                    return (
                      <div className={`voice-status-pill ${speaking ? 'speaking' : 'silent'}`} title={`Mic level: ${(voiceLevel * 100).toFixed(1)}%`}>
                    <span className="voice-dot" />
                    <span className="voice-icon" style={{ transform: `scale(${iconScale})` }}>
                      {speaking ? <SoundOutlined /> : <AudioMutedOutlined />}
                    </span>
                    <span>{speaking ? 'Speaking' : 'Silent'}</span>
                    <span className="voice-meter" aria-hidden="true">
                      <span className="voice-meter-fill" style={{ width: `${meterFill}px` }} />
                    </span>
                  </div>
                    )
                  })()
                ) : null}
              </div>
            </Card>
            <Card className="session-card">
              <div className="session-card-title">Interview Description</div>
              <p className="session-copy">
                We are a software development company, and we are looking for a software developer.
                You will answer a short set of questions on camera. Take a moment to get comfortable
                with your setup before you begin.
              </p>
              <div className="session-meta">
                <span>Total Questions: {questions.length}</span>
                <span>Current: {index + 1}</span>
              </div>
            </Card>
          </section>

          <section className="session-side">
            

            <Card className="session-card ready-card">
              <div className="session-card-title">{recording ? 'Current Question' : 'Ready to Start?'}</div>
              {!recording ? (
                <p className="session-copy">
                  Once you start recording, the questions will appear here. Make sure your camera and
                  microphone are working properly, then click the button below when you are ready.
                </p>
              ) : (
                <p className="session-question-text">
                  {questions[index]}
                </p>
              )}

              {!recording ? (
                <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                  Screen sharing is required. When prompted, choose <strong>Entire Screen</strong> (not a tab or app window).
                </div>
              ) : null}

              <div className="controls-row">
                {!recording ? (
                  <Button
                    type="primary"
                    icon={<AudioOutlined />}
                    size="large"
                    block
                    onClick={startRecording}
                  >
                  Start Interview
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    danger
                    className="finish-button"
                    icon={<StopOutlined />}
                    size="large"
                    block
                    onClick={stopRecording}
                  >
                   Finish Interview
                  </Button>
                )}
              </div>

              {recording && (
                <div className="question-nav">
                  <Button onClick={() => setIndex(i => Math.max(0, i - 1))} disabled={index === 0}>
                    Previous
                  </Button>
                  <Button
                    onClick={() => setIndex(i => Math.min(i + 1, questions.length - 1))}
                    disabled={index === questions.length - 1}
                  >
                    Next
                  </Button>
                </div>
              )}

              <div className="progress-bar">
                <div
                  className="progress-inner"
                  style={{ width: `${Math.round(((index + 1) / questions.length) * 100)}%` }}
                />
              </div>
              {!recording && uploadError && (
                <div className="muted" style={{ marginTop: 10, color: '#ef4444' }}>{uploadError}</div>
              )}
            </Card>
          </section>
        </main>
      </div>
    </div>
  )
}
