const fs = require('fs')
const path = require('path')
const db = require('./db')

function safeArray(x) {
  return Array.isArray(x) ? x : []
}

async function migrateRecordsJsonToPostgres({ recordsJsonPath }) {
  const filePath = recordsJsonPath || path.join(__dirname, 'records.json')
  if (!fs.existsSync(filePath)) {
    return { ok: true, skipped: true, reason: 'records.json not found', sessions: 0, files: 0, messages: 0 }
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  const sessions = (() => {
    try {
      const parsed = JSON.parse(raw || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch (e) {
      return []
    }
  })()

  if (!sessions.length) {
    return { ok: true, skipped: true, reason: 'records.json empty', sessions: 0, files: 0, messages: 0 }
  }

  let migratedFiles = 0
  let migratedMessages = 0

  for (const s of sessions) {
    const id = String(s?.id || s?.sessionId || '')
    if (!id) continue

    const createdAt = s?.createdAt || s?.uploadedAt || new Date().toISOString()
    const lastUploadedAt = s?.lastUploadedAt || null
    const name = s?.name || 'Unknown'
    const metadataPatch = (s && typeof s.metadata === 'object' && s.metadata) ? s.metadata : {}

    await db.upsertSession({
      id,
      sessionId: s?.sessionId || id,
      name,
      createdAt,
      lastUploadedAt,
      metadataPatch,
    })

    for (const f of safeArray(s.files)) {
      const fileId = String(f?.id || '')
      const filename = String(f?.filename || '')
      if (!fileId || !filename) continue

      await db.insertFile({
        sessionId: id,
        file: {
          id: fileId,
          filename,
          path: f?.path || (filename ? `/uploads/${filename}` : null),
          question: f?.question ?? null,
          index: (typeof f?.index === 'number') ? f.index : (f?.index != null ? Number(f.index) : null),
          source: f?.source || null,
          uploadedAt: f?.uploadedAt || null,
          remoteUrl: f?.remoteUrl || null,
          thumbnailPath: f?.thumbnailPath || null,
          analysis: f?.analysis || {},
        }
      })
      migratedFiles += 1
    }

    for (const m of safeArray(s.conversation)) {
      const role = String(m?.role || '').trim()
      const text = String(m?.text || '').trim()
      if (!role || !text) continue
      await db.insertConversationMessage({
        sessionId: id,
        role,
        text,
        at: m?.at || new Date().toISOString(),
      })
      migratedMessages += 1
    }
  }

  return { ok: true, skipped: false, sessions: sessions.length, files: migratedFiles, messages: migratedMessages }
}

module.exports = { migrateRecordsJsonToPostgres }


