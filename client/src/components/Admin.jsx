import React, { useEffect, useMemo, useState } from 'react'
import { Card, Button, Input, List, Typography, Space, Popconfirm, message, Drawer, Divider, Tag, Modal } from 'antd'
import { LockOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import {
  adminLogin,
  fetchRecordingsPage as apiFetchRecordingsPage,
  fetchRecordingDetails as apiFetchRecordingDetails,
  deleteRecording as apiDeleteRecording,
  deleteRecordingFile as apiDeleteRecordingFile,
  fetchStatus,
  fetchAdminInterviews,
  createAdminInterview,
  deleteAdminInterview,
} from '../api'

const { Text, Paragraph } = Typography

const ADMIN_TOKEN_KEY = 'admin_token'

export default function Admin() {
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [recordings, setRecordings] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [totalRecordings, setTotalRecordings] = useState(null)
  const [interviews, setInterviews] = useState([])
  const [newStack, setNewStack] = useState('C#')
  const [creating, setCreating] = useState(false)
  const [status, setStatus] = useState({ openAiConfigured: null })
  const [selectedId, setSelectedId] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedSession, setSelectedSession] = useState(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [linksModalOpen, setLinksModalOpen] = useState(false)
  // manual transcript removed - server will auto-transcribe uploaded recordings

  useEffect(() => {
    // Restore token after refresh
    try {
      const saved = localStorage.getItem(ADMIN_TOKEN_KEY)
      if (saved) {
        setToken(saved)
        loadInitial(saved)
        fetchInterviews(saved)
      }
    } catch (e) {
      // ignore storage errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Fetch server status (OpenAI configured or not) to show accurate "pending" messaging
    let cancelled = false
    ;(async () => {
      try {
        const data = await fetchStatus()
        if (!cancelled) setStatus(data || { openAiConfigured: null })
      } catch (e) {
        if (!cancelled) setStatus({ openAiConfigured: null })
      }
    })()
    return () => { cancelled = true }
  }, [])

  const login = async () => {
    try {
      setLoading(true)
      const data = await adminLogin(password)
      if (data.token) {
        setToken(data.token)
        try { localStorage.setItem(ADMIN_TOKEN_KEY, data.token) } catch (e) {}
        await loadInitial(data.token)
        await fetchInterviews(data.token)
        message.success('Logged in as admin')
      } else {
        message.error('Login failed')
      }
    } catch (err) {
      console.error(err)
      message.error('Login error')
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    setToken('')
    setRecordings([])
    setHasMore(true)
    setTotalRecordings(null)
    setInterviews([])
    try { localStorage.removeItem(ADMIN_TOKEN_KEY) } catch (e) {}
    message.success('Logged out')
  }

  const fetchInterviews = async (t) => {
    try {
      const data = await fetchAdminInterviews(t)
      setInterviews(data.interviews || [])
    } catch (err) {
      console.error(err)
      if (err && err.status === 401) {
        message.error('Session expired — please log in again')
        logout()
      }
    }
  }

  const createInterview = async () => {
    const stack = (newStack || '').trim()
    if (!stack) return message.error('Please enter a stack (e.g., C#)')
    try {
      setCreating(true)
      const data = await createAdminInterview({ stack }, token)
      if (data.ok) {
        message.success('Interview session created')
        await fetchInterviews(token)
      } else {
        message.error('Create failed')
      }
    } catch (err) {
      console.error(err)
      if (err && err.status === 401) {
        message.error('Session expired — please log in again')
        logout()
      } else if (err && err.status === 404) {
        message.error('Create failed (404). Server may be running an older version — restart the server.')
      } else {
        message.error(`Create error: ${err?.message || 'Unknown error'}`)
      }
    } finally {
      setCreating(false)
    }
  }

  const removeInterview = async (id) => {
    try {
      const data = await deleteAdminInterview(id, token)
      if (data.ok) {
        message.success('Interview session deleted')
        await fetchInterviews(token)
      } else {
        message.error('Delete failed')
      }
    } catch (err) {
      console.error(err)
      if (err && err.status === 401) {
        message.error('Session expired — please log in again')
        logout()
      } else if (err && err.status === 404) {
        message.error('Delete failed (404). Server may be running an older version — restart the server.')
      } else {
        message.error(`Delete error: ${err?.message || 'Unknown error'}`)
      }
    }
  }

  const getInterviewLink = (id) => `${window.location.origin}/interview/${id}`

  const copyLink = async (id) => {
    const link = getInterviewLink(id)
    try {
      await navigator.clipboard.writeText(link)
      message.success('Link copied')
    } catch (e) {
      // fallback prompt
      window.prompt('Copy this link:', link)
    }
  }

  const loadInitial = async (t) => {
    try {
      setLoading(true)
      const data = await apiFetchRecordingsPage({ offset: 0, limit: 10, summary: true }, t)
      const recs = data.recordings || []
      setRecordings(recs)
      setTotalRecordings(typeof data.total === 'number' ? data.total : null)
      setHasMore(typeof data.total === 'number' ? recs.length < data.total : (recs.length >= 10))
    } catch (err) {
      console.error(err)
      if (err && err.status === 401) {
        message.error('Session expired — please log in again')
        logout()
      } else {
        message.error('Could not load recordings')
      }
    } finally {
      setLoading(false)
    }
  }

  const loadMore = async () => {
    if (!token) return
    if (!hasMore) return
    if (loadingMore || loading) return
    try {
      setLoadingMore(true)
      const offset = recordings.length
      const data = await apiFetchRecordingsPage({ offset, limit: 5, summary: true }, token)
      const next = data.recordings || []
      const merged = [...recordings, ...next]
      setRecordings(merged)
      const total = typeof data.total === 'number' ? data.total : totalRecordings
      if (typeof total === 'number') {
        setTotalRecordings(total)
        setHasMore(merged.length < total)
      } else {
        setHasMore(next.length > 0)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingMore(false)
    }
  }

  // assessments are run automatically on the server after transcription

  const deleteSession = async (id) => {
    try {
      const data = await apiDeleteRecording(id, token)
      if (data.ok) loadInitial(token)
      else alert('Delete failed')
    } catch (err) {
      console.error(err)
      if (err && err.status === 401) {
        message.error('Session expired — please log in again')
        logout()
      } else {
        message.error('Delete error')
      }
    }
  }

  const deleteFile = async (sessionId, fileId) => {
    try {
      const data = await apiDeleteRecordingFile(sessionId, fileId, token)
      if (data.ok) {
        message.success('Recording deleted')
        await loadInitial(token)
        try {
          const d = await apiFetchRecordingDetails(sessionId, token)
          setSelectedSession(d.recording || null)
        } catch (e) {}
      } else {
        message.error('Delete failed')
      }
    } catch (err) {
      console.error(err)
      if (err && err.status === 401) {
        message.error('Session expired — please log in again')
        logout()
      } else {
        message.error(`Delete error: ${err?.message || 'Unknown error'}`)
      }
    }
  }

  const openDetails = async (rec) => {
    const sid = rec?.id
    if (!sid) return
    setSelectedId(sid)
    setDrawerOpen(true)
    setSelectedSession(null)
    setDetailsLoading(true)
    try {
      const data = await apiFetchRecordingDetails(sid, token)
      setSelectedSession(data.recording || null)
    } catch (e) {
      console.error(e)
      message.error('Could not load recording details')
    } finally {
      setDetailsLoading(false)
    }
  }

  const downloadVideo = async (url, filename) => {
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`download failed (${resp.status})`)
      const blob = await resp.blob()
      const a = document.createElement('a')
      const objectUrl = URL.createObjectURL(blob)
      a.href = objectUrl
      a.download = filename || 'recording.webm'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
      message.success('Download started')
    } catch (e) {
      message.error('Download failed')
      console.error(e)
    }
  }

  const selected = selectedSession || (selectedId ? recordings.find(r => r.id === selectedId) : null)

  const sortedInterviews = useMemo(() => {
    const arr = Array.isArray(interviews) ? [...interviews] : []
    arr.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    return arr
  }, [interviews])

  const previewLinks = useMemo(() => {
    // Keep the admin page compact; show the rest behind "More".
    return sortedInterviews.slice(0, 3)
  }, [sortedInterviews])

  // Infinite scroll: load 5 more sessions when nearing the bottom of the page.
  useEffect(() => {
    if (!token) return
    const onScroll = () => {
      if (!hasMore || loadingMore || loading) return
      const scrollPos = window.innerHeight + window.scrollY
      const threshold = document.documentElement.scrollHeight - 500
      if (scrollPos >= threshold) loadMore()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [token, hasMore, loadingMore, loading, recordings.length])

  useEffect(() => {
    // While drawer is open and transcript isn't ready yet, poll the session details (not the whole list).
    if (!drawerOpen || !token || !selectedId) return

    const needsUpdate = () => {
      const rec = selectedSession
      if (!rec) return true
      const ai = rec.files?.[0]?.analysis?.status
      if (ai === 'pending') return true
      if (status.openAiConfigured === true && !rec.files?.[0]?.analysis) return true
      return false
    }

    if (!needsUpdate()) return

    let ticks = 0
    const interval = setInterval(async () => {
      ticks += 1
      if (ticks > 30) return clearInterval(interval)
      try {
        const data = await apiFetchRecordingDetails(selectedId, token)
        setSelectedSession(data.recording || null)
      } catch (e) {}
    }, 4000)

    return () => clearInterval(interval)
  }, [drawerOpen, token, selectedId, status.openAiConfigured, selectedSession])

  if (!token) return (
    <div className="container"><Card className="card" style={{ maxWidth: 520 }}>
      <h2>Admin Login</h2>
      <Text className="muted">Enter your admin password to view recordings.</Text>

      <div style={{ marginTop: 12 }}>
        <Input.Password iconRender={visible => (visible ? <LockOutlined /> : <LockOutlined />)} value={password} onChange={e => setPassword(e.target.value)} placeholder="Admin password" />
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <Button type="primary" onClick={login} loading={loading}>Login</Button>
        <Button href="/" icon={<ArrowLeftOutlined />}>Back</Button>
      </div>
    </Card></div>
  )

  return (
    <div className="container"><Card className="card" style={{ width: '95%', maxWidth: 1100 }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'rgba(11,22,39,0.96)',
          backdropFilter: 'blur(8px)',
          padding: '12px 0',
          marginTop: -6,
          borderBottom: '1px solid rgba(148,163,184,0.18)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ marginBottom: 0 }}>Recordings</h2>
            <Text className="muted">
              {typeof totalRecordings === 'number' ? `${recordings.length} / ${totalRecordings}` : `${recordings.length} items`}
            </Text>
          </div>
          <Space>
            <Button type="primary" onClick={() => loadInitial(token)} loading={loading}>Refresh</Button>
            <Button danger onClick={logout}>Logout</Button>
          </Space>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card className="rec-card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Create Interview Session Link</div>
              <div className="muted" style={{ fontSize: 12 }}>Choose a stack (e.g., C#, Java, React). Candidates open the link to start the interview.</div>
            </div>
            <Space>
              <Input value={newStack} onChange={(e) => setNewStack(e.target.value)} placeholder="Stack (e.g., C#)" style={{ width: 240 }} />
              <Button type="primary" onClick={createInterview} loading={creating}>Create</Button>
              <Button onClick={() => fetchInterviews(token)}>Reload Links</Button>
            </Space>
          </div>

          {sortedInterviews.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <div style={{ fontWeight: 700 }}>Saved Session Links</div>
                {sortedInterviews.length > 3 ? (
                  <Button size="small" onClick={() => setLinksModalOpen(true)}>
                    More ({sortedInterviews.length})
                  </Button>
                ) : null}
              </div>
              <List
                size="small"
                dataSource={previewLinks}
                renderItem={(iv) => (
                  <List.Item
                    actions={[
                      <Button key="copy" size="small" onClick={() => copyLink(iv.id)}>Copy link</Button>,
                      <Button key="open" size="small" onClick={() => window.open(getInterviewLink(iv.id), '_blank', 'noreferrer')}>Open</Button>,
                      <Popconfirm key="del" title="Delete this interview session link?" onConfirm={() => removeInterview(iv.id)} okText="Delete" cancelText="Cancel">
                        <Button danger size="small">Delete</Button>
                      </Popconfirm>,
                    ]}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <div className="admin-link-title">{iv.stack || 'Unknown stack'}</div>
                      <a
                        className="admin-link-url"
                        href={getInterviewLink(iv.id)}
                        target="_blank"
                        rel="noreferrer"
                        title={getInterviewLink(iv.id)}
                        style={{ maxWidth: 680, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {getInterviewLink(iv.id)}
                      </a>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {iv.createdAt ? new Date(iv.createdAt).toLocaleString() : ''}
                      </div>
                    </div>
                  </List.Item>
                )}
              />
            </div>
          )}

          {sortedInterviews.length === 0 && (
            <div className="muted" style={{ marginTop: 12 }}>No interview links yet. Create one above.</div>
          )}
        </Card>
      </div>

      <Modal
        open={linksModalOpen}
        onCancel={() => setLinksModalOpen(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setLinksModalOpen(false)}>
            Close
          </Button>
        ]}
        title="All interview session links"
        width={820}
      >
        <List
          size="small"
          dataSource={sortedInterviews}
          renderItem={(iv) => (
            <List.Item
              actions={[
                <Button key="copy" size="small" onClick={() => copyLink(iv.id)}>Copy</Button>,
                <Button key="open" size="small" onClick={() => window.open(getInterviewLink(iv.id), '_blank', 'noreferrer')}>Open</Button>,
                <Popconfirm key="del" title="Delete this interview session link?" onConfirm={() => removeInterview(iv.id)} okText="Delete" cancelText="Cancel">
                  <Button danger size="small">Delete</Button>
                </Popconfirm>,
              ]}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontWeight: 700 }}>{iv.stack || 'Unknown stack'}</div>
                <div style={{ fontSize: 12 }}>
                  <a href={getInterviewLink(iv.id)} target="_blank" rel="noreferrer">{getInterviewLink(iv.id)}</a>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {iv.createdAt ? new Date(iv.createdAt).toLocaleString() : ''}
                </div>
              </div>
            </List.Item>
          )}
        />
      </Modal>

      {recordings.length === 0 && <div className="muted">No recordings yet.</div>}

      <List grid={{ gutter: 16, column: 3 }} style={{ marginTop: 12 }} dataSource={recordings} renderItem={r => (
        <List.Item>
          <Card className="rec-card" hoverable onClick={() => openDetails(r)}>
            {r.thumbnailUrl ? (
              <div style={{ marginBottom: 10 }}>
                <img
                  src={r.thumbnailUrl}
                  alt="Recording preview"
                  style={{ width: '100%', borderRadius: 10, border: '1px solid rgba(148,163,184,0.18)', background: '#000', maxHeight: 160, objectFit: 'cover' }}
                  loading="lazy"
                />
              </div>
            ) : (r.previewUrl ? (
              <div style={{ marginBottom: 10 }}>
                <video
                  src={r.previewUrl}
                  preload="metadata"
                  muted
                  playsInline
                  style={{ width: '100%', borderRadius: 10, border: '1px solid rgba(148,163,184,0.18)', background: '#000', maxHeight: 160, objectFit: 'cover' }}
                />
              </div>
            ) : null)}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.name || r.metadata?.name || 'unknown'}</div>
                <div className="muted" style={{ fontSize: 12 }}>{new Date(r.createdAt || r.lastUploadedAt || Date.now()).toLocaleString()}</div>
              </div>
              <div>
                <Space>
                  <Popconfirm title="Delete this session and all files?" onConfirm={() => deleteSession(r.id)} okText="Delete" cancelText="Cancel">
                    <Button danger size="small" onClick={(e) => { e.stopPropagation() }}>Delete</Button>
                  </Popconfirm>
                </Space>
              </div>
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              {typeof r.filesCount === 'number'
                ? `${r.filesCount} recording${r.filesCount === 1 ? '' : 's'}`
                : `${(r.files || []).length} recording${(r.files || []).length === 1 ? '' : 's'}`}
            </div>
            <div style={{ marginTop: 10 }} className="muted">
              Click to open details
            </div>
          </Card>
        </List.Item>
      )} />

      {loadingMore ? <div className="muted" style={{ marginTop: 14 }}>Loading more…</div> : null}

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={selected ? (selected.name || 'Candidate') : 'Candidate'}
        width={520}
        styles={{
          body: { background: '#0b1627', color: '#e5e7eb' },
          header: { background: '#0b1627', color: '#e5e7eb', borderBottom: '1px solid rgba(148,163,184,0.25)' },
          content: { background: '#0b1627' },
        }}
      >
        {detailsLoading ? (
          <div className="muted">Loading details…</div>
        ) : (!selected ? null : (
          <div>
            <div className="muted" style={{ marginBottom: 10 }}>
              {selected.metadata?.stack ? <Tag color="blue">{selected.metadata.stack}</Tag> : null}
              {selected.metadata?.country ? <Tag color="default">{selected.metadata.country}</Tag> : null}
              <span style={{ marginLeft: 8 }}>Session ID: {selected.id}</span>
            </div>

            <Divider style={{ borderColor: 'rgba(148,163,184,0.25)' }} />

            <div style={{ fontWeight: 700, marginBottom: 6 }}>Candidate info</div>
            <div className="muted" style={{ marginBottom: 4 }}>Email: <strong>{selected.metadata?.email || '—'}</strong></div>
            <div className="muted" style={{ marginBottom: 4 }}>Country: <strong>{selected.metadata?.country || '—'}</strong></div>
            <div className="muted" style={{ marginBottom: 4 }}>Phone: <strong>{selected.metadata?.phone || '—'}</strong></div>
            <div className="muted" style={{ marginBottom: 4 }}>Source: <strong>{selected.metadata?.source || '—'}</strong></div>

            <Divider style={{ borderColor: 'rgba(148,163,184,0.25)' }} />

            <div style={{ fontWeight: 700, marginBottom: 10 }}>Recordings</div>
            {(selected.files || []).length === 0 ? (
              <div className="muted">No files.</div>
            ) : (
              (selected.files || []).map((f) => (
                <div key={f.id} style={{ marginBottom: 14 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{f.filename}</div>
                  <video controls src={f.url} style={{ width: '100%', borderRadius: 10, background: '#000' }} />
                  <div style={{ marginTop: 8 }}>
                    <Space>
                      <Button size="small" onClick={() => downloadVideo(f.url, f.filename)}>
                        Download
                      </Button>
                      <Popconfirm
                        title="Delete this recording file?"
                        onConfirm={() => deleteFile(selected.id, f.id)}
                        okText="Delete"
                        cancelText="Cancel"
                      >
                        <Button danger size="small">
                          Delete
                        </Button>
                      </Popconfirm>
                    </Space>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Evaluation:</div>
                    {(() => {
                      const a = f.analysis || null
                      const r = a?.results || null
                      if (!status.openAiConfigured) return <div className="muted" style={{ fontSize: 12 }}>OpenAI not configured</div>
                      if (!a) return <div className="muted" style={{ fontSize: 12 }}>Pending…</div>
                      if (a.status === 'pending') return <div className="muted" style={{ fontSize: 12 }}>{a.message || 'Pending…'}</div>
                      if (a.status === 'error') return <div className="muted" style={{ fontSize: 12 }}>Error: {a.message || 'Evaluation failed'}</div>
                      if (a.status !== 'done' || !r) return <div className="muted" style={{ fontSize: 12 }}>{a.message || 'Pending…'}</div>

                      const per = Array.isArray(r.perQuestion) ? r.perQuestion : []
                      return (
                        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.95)' }}>
                          <div style={{ marginBottom: 6 }}>
                            <Tag color="geekblue">Overall: {Number.isFinite(Number(r.overallPercent)) ? Math.round(Number(r.overallPercent)) : '—'}%</Tag>
                            {r.notes ? <span className="muted" style={{ marginLeft: 8 }}>{String(r.notes)}</span> : null}
                          </div>
                          {per.length ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {per.map((pq) => (
                                <div key={`${pq.index}-${pq.percent}`} style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(148,163,184,0.18)', background: 'rgba(15,23,42,0.35)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                                    <div style={{ fontWeight: 700 }}>Q{pq.index} — {String(pq.question || '').slice(0, 120)}</div>
                                    <Tag color={Number(pq.percent) >= 75 ? 'green' : (Number(pq.percent) >= 50 ? 'gold' : 'red')}>{Math.round(Number(pq.percent) || 0)}%</Tag>
                                  </div>
                                  {pq.feedback ? <div className="muted" style={{ marginTop: 4 }}>{String(pq.feedback)}</div> : null}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="muted" style={{ fontSize: 12 }}>No per-question results.</div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              ))
            )}
          </div>
        ))}
      </Drawer>
    </Card></div>
  )
}
