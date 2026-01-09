import React, { useEffect, useRef, useState } from 'react'
import { Card, Button, message } from 'antd'
import '../styles/interview.css'
import { AudioOutlined, StopOutlined } from '@ant-design/icons'
import { API_BASE, generateQuestions, finalizeUpload } from '../api'

const MAX_DURATION_SECONDS = 10 * 60

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
  const mediaRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const sessionIdRef = useRef(null)
  const uploadPromiseRef = useRef(null)
  const uploadQueueRef = useRef(Promise.resolve())
  const hasChunkRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const fallback = [
      'Please introduce yourself briefly and tell me what brings you here today.',
      'Tell me about your previous company and your role there.',
      'Describe a project you worked on recently and what your responsibilities were.'
    ]

    ;(async () => {
      setLoading(true)
      try {
        const data = await generateQuestions({
          num: 3,
          topic: 'general English job interview',
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

  useEffect(() => {
    sessionIdRef.current = `${(name || 'user').replace(/\s+/g, '_')}-${Date.now()}`
  }, [name])

  useEffect(() => {
    const tryFinalizeViaBeacon = () => {
      try {
        // If we haven't produced any chunks yet, finalizing will fail ("no chunks found").
        // This can happen if the tab closes before the first MediaRecorder timeslice fires.
        if (!hasChunkRef.current) return
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

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      setMediaStream(stream)
      if (mediaRef.current) mediaRef.current.srcObject = stream
    } catch (err) {
      console.warn('Could not access camera/microphone', err)
    }
  }

  const startRecording = async () => {
    if (!mediaStream) await startCamera()
    chunksRef.current = []
    const preferred = pickBestMimeType()
    const options = {
      mimeType: preferred,
      // Lower bitrate => smaller files => more reliable on slow networks.
      // Works best with H.264/MP4 when available.
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    }
    const mr = new MediaRecorder(mediaRef.current.srcObject || mediaStream, options)
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
            message.success('Interview uploaded')
          } catch (e) {
            console.warn('upload-answer failed; falling back to chunk finalize', e)
            // Try finalize (best-effort). If it fails, user can still download the local recording.
            try {
              await finalizeUpload({ sessionId: sessionIdRef.current, name, email, country, phone, interviewId })
              // "finalized" still means the interview is successfully saved (via chunk assembly).
              message.success('Interview uploaded')
            } catch (e2) {
              setUploadError('Upload failed. Please download your recording and try again.')
              console.warn('finalize failed', e2)
            }
          }
        } catch (e) { console.warn('finalize failed', e) }
        chunksRef.current = []
        setUploading(false)
      })()
    }
    mr.onerror = (ev) => console.error('Recorder error', ev)
    // Larger timeslice => fewer network requests on slow networks.
    mr.start(5000)
    setRecording(true)
  }

  const stopRecording = async () => {
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
                    danger
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
                    type="primary"
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
              {!recording && uploading && (
                <div className="muted" style={{ marginTop: 10 }}>Uploading…</div>
              )}
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
