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

export default function Interview({ name, email, country, phone, interviewId, stack }) {
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
  const chunksRef = useRef([])
  const sessionIdRef = useRef(null)
  const uploadPromiseRef = useRef(null)
  const uploadQueueRef = useRef(Promise.resolve())
  const hasChunkRef = useRef(false)
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

  useEffect(() => {
    if (!recording) return
    if (elapsedSeconds < MAX_DURATION_SECONDS) return
    if (autoStopTriggeredRef.current) return
    autoStopTriggeredRef.current = true
    // Auto-end the interview when time runs out (same as clicking "Finish Interview").
    stopRecording().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedSeconds, recording])

  useEffect(() => {
    sessionIdRef.current = `${(name || 'user').replace(/\s+/g, '_')}-${Date.now()}`
  }, [name])

  useEffect(() => {
    const tryFinalizeViaBeacon = () => {
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
        const payload = JSON.stringify({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId })
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
    const onVisibility = () => { if (document.visibilityState === 'hidden') tryFinalizeViaBeacon() }
    window.addEventListener('beforeunload', tryFinalizeViaBeacon)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', tryFinalizeViaBeacon)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [name])

  useEffect(() => {
    return () => {
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop())
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
      if (mediaRef.current) mediaRef.current.srcObject = stream
      return stream
    } catch (err) {
      console.warn('Could not access camera/microphone', err)
      return null
    }
  }

  const startRecording = async () => {
    // Reset auto-stop guard for a new recording.
    autoStopTriggeredRef.current = false
    let stream = mediaRef.current?.srcObject || mediaStream
    if (!stream) stream = await startCamera()
    // best-effort voice detection (does not block recording)
    if (stream) startVoiceDetection(stream)

    chunksRef.current = []
    const preferred = pickBestMimeType()
    const options = {
      mimeType: preferred,
      // Lower bitrate => smaller files => more reliable on slow networks.
      // Works best with H.264/MP4 when available.
      // Keep chunks small enough for common reverse-proxy limits (often ~1MB).
      videoBitsPerSecond: 800_000,
      audioBitsPerSecond: 64_000,
    }
    const mr = new MediaRecorder(stream || mediaRef.current.srcObject || mediaStream, options)
    recorderRef.current = mr
    let chunkIndex = 0
    setLastRecording(null)
    setUploadError('')
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunksRef.current.push(e.data)
        hasChunkRef.current = true
        const thisIndex = chunkIndex++
        // Upload chunks sequentially to avoid flooding slow networks with parallel requests.
        uploadQueueRef.current = uploadQueueRef.current.then(async () => {
          const fd = new FormData()
          const ext = (mr.mimeType || '').includes('mp4') ? 'mp4' : 'webm'
          const filename = `${sessionIdRef.current || 'session'}-chunk-${Date.now()}.${ext}`
          fd.append('video', e.data, filename)
          // include candidate details so the server can persist metadata early
          fd.append('metadata', JSON.stringify({ sessionId: sessionIdRef.current, index: thisIndex, interviewId, name, email, country, phone }))
          // simple retry (2 attempts) for flaky networks
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const resp = await fetch(`${API_BASE}/upload-chunk`, { method: 'POST', body: fd })
              try { await resp.json() } catch (e) {}
              if (!resp.ok) throw new Error(`upload-chunk failed (${resp.status})`)
              return
            } catch (err) {
              // 413 usually means the server/proxy rejected the request size.
              if (String(err?.message || '').includes('(413)')) {
                setUploadError('Upload failed (413: file too large). Please contact the admin to increase server upload limit or try again on a stronger connection.')
              }
              if (attempt === 1) console.warn('chunk upload failed', err)
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            }
          }
        })
      }
    }
    mr.onstop = () => {
      uploadPromiseRef.current = (async () => {
        try {
          setUploading(true)
          setUploadError('')
          let uploadSucceeded = false
          // Prefer uploading one final file for reliable playback.
          // Chunk assembly by byte concatenation can produce a corrupted WebM container in some browsers.
          try {
            const mimeType = (mr && mr.mimeType) ? mr.mimeType : 'video/webm'
            const blob = new Blob(chunksRef.current, { type: mimeType })
            const fd = new FormData()
            const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
            const filename = `${sessionIdRef.current || 'session'}-${Date.now()}.${ext}`
            fd.append('video', blob, filename)
            fd.append('metadata', JSON.stringify({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId }))
            const resp = await fetch(`${API_BASE}/upload-answer`, { method: 'POST', body: fd })
            // server returns JSON; ignore parsing failures (e.g. if server errors)
            try { await resp.json() } catch (e) {}
            if (!resp.ok) throw new Error(`upload-answer failed (${resp.status})`)
            setLastRecording({ blob, filename })
            uploadSucceeded = true
          } catch (e) {
            console.warn('upload-answer failed; falling back to chunk finalize', e)
            // Try finalize (best-effort). If it fails, user can still download the local recording.
            try {
              const r = await finalizeUpload({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId })
              if (r && r.ok) uploadSucceeded = true
            } catch (e2) {
              setUploadError('Upload failed. Please download your recording and try again.')
              console.warn('finalize failed', e2)
            }
          }

          if (uploadSucceeded) {
            // Show a friendly confirmation modal after successful upload.
            setThankYouOpen(true)
          }
        } catch (e) { console.warn('finalize failed', e) }
        chunksRef.current = []
        setUploading(false)
      })()
    }
    mr.onerror = (ev) => console.error('Recorder error', ev)
    // Smaller timeslice => smaller chunks (helps avoid 413 from proxies with small body limits).
    mr.start(2000)
    setRecording(true)
  }

  const stopRecording = async () => {
    stopVoiceDetection()
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    setRecording(false)
    try { if (uploadPromiseRef.current) await uploadPromiseRef.current } catch (e) { console.warn(e) }
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
