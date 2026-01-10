const { Pool } = require('pg')

let pool = null

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is required (PostgreSQL connection string).')
    }
    pool = new Pool({ connectionString })
  }
  return pool
}

async function initDb() {
  const p = getPool()
  // basic connectivity check
  await p.query('select 1 as ok')

  // Schema: sessions + files + conversation
  await p.query(`
    create table if not exists interview_sessions (
      id text primary key,
      session_id text,
      name text,
      created_at timestamptz,
      last_uploaded_at timestamptz,
      metadata jsonb not null default '{}'::jsonb
    );
  `)

  await p.query(`
    create table if not exists interview_files (
      id text primary key,
      session_id text not null references interview_sessions(id) on delete cascade,
      filename text not null,
      path text,
      question text,
      index integer,
      source text,
      uploaded_at timestamptz,
      remote_url text,
      thumbnail_path text,
      analysis jsonb not null default '{}'::jsonb
    );
  `)

  await p.query(`create index if not exists idx_interview_files_session_uploaded on interview_files(session_id, uploaded_at desc);`)

  await p.query(`
    create table if not exists interview_conversation (
      id bigserial primary key,
      session_id text not null references interview_sessions(id) on delete cascade,
      role text not null,
      text text not null,
      at timestamptz not null
    );
  `)
  await p.query(`create index if not exists idx_interview_conversation_session_at on interview_conversation(session_id, at);`)

  // Simple key/value metadata (used for one-time migrations)
  await p.query(`
    create table if not exists app_meta (
      key text primary key,
      value text,
      updated_at timestamptz not null default now()
    );
  `)
}

function compactObject(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'undefined') continue
    if (v === null) continue
    out[k] = v
  }
  return out
}

async function upsertSession({ id, sessionId, name, createdAt, lastUploadedAt, metadataPatch }) {
  const p = getPool()
  const meta = compactObject(metadataPatch || {})
  const metaJson = JSON.stringify(meta)
  const created = createdAt ? new Date(createdAt) : new Date()
  const lastUp = lastUploadedAt ? new Date(lastUploadedAt) : null
  await p.query(
    `
      insert into interview_sessions (id, session_id, name, created_at, last_uploaded_at, metadata)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      on conflict (id) do update set
        session_id = coalesce(excluded.session_id, interview_sessions.session_id),
        name = coalesce(nullif(excluded.name, ''), interview_sessions.name),
        created_at = coalesce(interview_sessions.created_at, excluded.created_at),
        last_uploaded_at = coalesce(excluded.last_uploaded_at, interview_sessions.last_uploaded_at),
        metadata = coalesce(interview_sessions.metadata, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb)
    `,
    [String(id), String(sessionId || id), name ? String(name) : '', created, lastUp, metaJson]
  )
}

async function getSession(id) {
  const p = getPool()
  const { rows } = await p.query(
    `select id, session_id, name, created_at, last_uploaded_at, metadata from interview_sessions where id = $1`,
    [String(id)]
  )
  return rows[0] || null
}

async function listSessionsPage({ offset = 0, limit = 10, summary = true } = {}) {
  const p = getPool()
  const off = Math.max(0, Number.parseInt(offset, 10) || 0)
  const lim = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 10))

  const totalRes = await p.query(`select count(*)::int as total from interview_sessions`)
  const total = totalRes.rows?.[0]?.total ?? 0

  // For summary, fetch last file for preview/thumbnail. For non-summary, caller should fetch full details separately.
  const { rows } = await p.query(
    `
      select
        s.id,
        s.session_id,
        s.name,
        s.created_at,
        s.last_uploaded_at,
        s.metadata,
        coalesce(f.files_count, 0)::int as files_count,
        lf.remote_url as last_remote_url,
        lf.path as last_path,
        lf.thumbnail_path as last_thumbnail_path
      from interview_sessions s
      left join lateral (
        select count(*) as files_count
        from interview_files ff
        where ff.session_id = s.id
      ) f on true
      left join lateral (
        select remote_url, path, thumbnail_path
        from interview_files lf
        where lf.session_id = s.id
        order by lf.uploaded_at desc nulls last, lf.id desc
        limit 1
      ) lf on true
      order by coalesce(s.last_uploaded_at, s.created_at) desc nulls last, s.id desc
      offset $1 limit $2
    `,
    [off, lim]
  )

  const sessions = rows.map(r => ({
    id: r.id,
    sessionId: r.session_id || r.id,
    name: r.name || r.metadata?.name || 'Unknown',
    metadata: r.metadata || {},
    createdAt: r.created_at,
    lastUploadedAt: r.last_uploaded_at,
    filesCount: r.files_count,
    lastFile: {
      remoteUrl: r.last_remote_url || '',
      path: r.last_path || '',
      thumbnailPath: r.last_thumbnail_path || '',
    },
    // For admin list endpoint parity
    files: summary ? [] : null,
    conversation: [],
  }))

  return { sessions, total, offset: off, limit: lim }
}

async function getSessionDetails(id) {
  const p = getPool()
  const sRes = await p.query(
    `select id, session_id, name, created_at, last_uploaded_at, metadata from interview_sessions where id = $1`,
    [String(id)]
  )
  const session = sRes.rows[0]
  if (!session) return null

  const fRes = await p.query(
    `select id, filename, path, question, index, source, uploaded_at, remote_url, thumbnail_path, analysis
     from interview_files
     where session_id = $1
     order by uploaded_at asc nulls last, id asc`,
    [String(id)]
  )

  const cRes = await p.query(
    `select role, text, at from interview_conversation where session_id = $1 order by at asc, id asc`,
    [String(id)]
  )

  return {
    id: session.id,
    sessionId: session.session_id || session.id,
    name: session.name || session.metadata?.name || 'Unknown',
    metadata: session.metadata || {},
    createdAt: session.created_at,
    lastUploadedAt: session.last_uploaded_at,
    files: fRes.rows.map(f => ({
      id: f.id,
      filename: f.filename,
      path: f.path,
      question: f.question,
      index: f.index,
      source: f.source,
      uploadedAt: f.uploaded_at,
      remoteUrl: f.remote_url,
      thumbnailPath: f.thumbnail_path,
      analysis: f.analysis || {},
    })),
    conversation: cRes.rows.map(c => ({ role: c.role, text: c.text, at: c.at })),
  }
}

async function insertFile({ sessionId, file }) {
  const p = getPool()
  await p.query(
    `
      insert into interview_files
        (id, session_id, filename, path, question, index, source, uploaded_at, remote_url, thumbnail_path, analysis)
      values
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      on conflict (id) do update set
        filename = excluded.filename,
        path = excluded.path,
        question = excluded.question,
        index = excluded.index,
        source = excluded.source,
        uploaded_at = excluded.uploaded_at,
        remote_url = coalesce(excluded.remote_url, interview_files.remote_url),
        thumbnail_path = coalesce(excluded.thumbnail_path, interview_files.thumbnail_path),
        analysis = coalesce(interview_files.analysis, '{}'::jsonb) || coalesce(excluded.analysis, '{}'::jsonb)
    `,
    [
      String(file.id),
      String(sessionId),
      String(file.filename),
      file.path ? String(file.path) : null,
      file.question != null ? String(file.question) : null,
      typeof file.index === 'number' ? file.index : (file.index != null ? Number(file.index) : null),
      file.source ? String(file.source) : null,
      file.uploadedAt ? new Date(file.uploadedAt) : new Date(),
      file.remoteUrl ? String(file.remoteUrl) : null,
      file.thumbnailPath ? String(file.thumbnailPath) : null,
      JSON.stringify(file.analysis || {}),
    ]
  )
}

async function updateFileFields({ sessionId, fileId, patch }) {
  const p = getPool()
  const sets = []
  const vals = [String(fileId), String(sessionId)]
  let idx = 3
  for (const [k, v] of Object.entries(patch || {})) {
    if (typeof v === 'undefined') continue
    if (k === 'analysis') {
      sets.push(`analysis = $${idx}::jsonb`)
      vals.push(JSON.stringify(v || {}))
      idx += 1
      continue
    }
    if (k === 'remote_url' || k === 'remoteUrl') {
      sets.push(`remote_url = $${idx}`)
      vals.push(v == null ? null : String(v))
      idx += 1
      continue
    }
    if (k === 'thumbnail_path' || k === 'thumbnailPath') {
      sets.push(`thumbnail_path = $${idx}`)
      vals.push(v == null ? null : String(v))
      idx += 1
      continue
    }
  }
  if (!sets.length) return
  await p.query(
    `update interview_files set ${sets.join(', ')} where id = $1 and session_id = $2`,
    vals
  )
}

async function deleteSession(id) {
  const p = getPool()
  await p.query(`delete from interview_sessions where id = $1`, [String(id)])
}

async function deleteFile({ sessionId, fileId }) {
  const p = getPool()
  await p.query(`delete from interview_files where session_id = $1 and id = $2`, [String(sessionId), String(fileId)])
}

async function getFile({ sessionId, fileId }) {
  const p = getPool()
  const { rows } = await p.query(
    `select id, session_id, filename, path, remote_url, thumbnail_path, analysis from interview_files where session_id = $1 and id = $2`,
    [String(sessionId), String(fileId)]
  )
  return rows[0] || null
}

async function insertConversationMessage({ sessionId, role, text, at }) {
  const p = getPool()
  await p.query(
    `insert into interview_conversation (session_id, role, text, at) values ($1,$2,$3,$4)`,
    [String(sessionId), String(role), String(text), at ? new Date(at) : new Date()]
  )
}

async function recomputeLastUploadedAt(sessionId) {
  const p = getPool()
  await p.query(
    `update interview_sessions
     set last_uploaded_at = (select max(uploaded_at) from interview_files where session_id = $1)
     where id = $1`,
    [String(sessionId)]
  )
}

async function getMeta(key) {
  const p = getPool()
  const { rows } = await p.query(`select value from app_meta where key = $1`, [String(key)])
  return rows[0]?.value ?? null
}

async function setMeta(key, value) {
  const p = getPool()
  await p.query(
    `insert into app_meta(key, value, updated_at) values ($1,$2,now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [String(key), value == null ? null : String(value)]
  )
}

async function countSessions() {
  const p = getPool()
  const r = await p.query(`select count(*)::int as n from interview_sessions`)
  return r.rows?.[0]?.n ?? 0
}

module.exports = {
  initDb,
  getPool,
  upsertSession,
  getSession,
  listSessionsPage,
  getSessionDetails,
  insertFile,
  updateFileFields,
  deleteSession,
  deleteFile,
  getFile,
  insertConversationMessage,
  recomputeLastUploadedAt,
  getMeta,
  setMeta,
  countSessions,
}


