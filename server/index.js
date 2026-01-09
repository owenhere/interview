const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process')

// Resolve a fetch implementation:
// 1) prefer global fetch (Node 18+),
// 2) try undici (fast, CommonJS-friendly),
// 3) fall back to dynamic import of node-fetch if installed.
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    // undici exports fetch
    const { fetch: undiciFetch } = require('undici')
    fetchFn = undiciFetch
  } catch (err) {
    // dynamic import node-fetch (ESM) if available
    fetchFn = (...args) => import('node-fetch').then(mod => mod.default(...args))
  }
}
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Support both legacy routes (/apiname) and reverse-proxy prefix routes (/backend/apiname).
// This makes it easy to deploy behind nginx with `location /backend/ { proxy_pass ... }`.
const withBackendPrefix = (route) => [route, `/backend${route}`]

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CHUNK_DIR = path.join(__dirname, 'chunks');
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || 'answer').replace(/[^a-z0-9.\-_]/gi, '_');
    cb(null, `${ts}-${safe}`);
  }
});
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100)
const upload = multer({
  storage,
  limits: {
    // Applies per multipart file. Note: many deployments will enforce a lower limit at the reverse proxy.
    fileSize: Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024,
  },
});

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.warn('WARNING: OPENAI_API_KEY not set in environment. /generate-questions will return fallback questions.');
}

// lightweight status endpoint (safe for local usage)
app.get(withBackendPrefix('/status'), (req, res) => {
  return res.json({ openAiConfigured: !!OPENAI_KEY })
})

// -------- OpenAI helpers ----------------------------------------------------

/**
 * Call OpenAI Chat Completions API with a system prompt and user content.
 * Returns the raw assistant message content as a string.
 */
async function openAiChat({ systemPrompt, userContent, maxTokens = 500 }) {
  if (!OPENAI_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
  };

  const resp = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Transcribe an audio/video file using OpenAI Whisper.
 * Returns { text, error } where error is a human-readable message (or empty string).
 */
async function transcribeFile(filePath) {
  if (!OPENAI_KEY) return { text: '', error: 'OpenAI not configured (OPENAI_API_KEY missing).' };

  try {
    let fd;
    let headers = {};

    // Prefer streaming multipart if the `form-data` package exists (best for larger files).
    try {
      const FormDataPkg = require('form-data');
      fd = new FormDataPkg();
      fd.append('file', fs.createReadStream(filePath));
      fd.append('model', 'whisper-1');
      headers = fd.getHeaders();
    } catch (e) {
      // Fallback: use Web-compatible FormData (undici) with a Blob buffer.
      // Note: undici FormData does NOT reliably support Node streams as file values.
      const buf = fs.readFileSync(filePath);
      const blob = new Blob([buf], { type: 'video/webm' });
      fd = new globalThis.FormData();
      fd.append('file', blob, path.basename(filePath));
      fd.append('model', 'whisper-1');
      headers = {};
    }

    const trResp = await fetchFn('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, ...headers },
      body: fd,
    });

    const trData = await trResp.json().catch(() => ({}));
    if (!trResp.ok) {
      const msg = trData?.error?.message || `Whisper request failed (${trResp.status})`;
      return { text: '', error: msg };
    }

    const text = trData?.text || '';
    if (!text.trim()) return { text: '', error: 'Whisper returned empty transcript (audio may be silent/unavailable).' };
    return { text, error: '' };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn('transcription failed', msg);
    return { text: '', error: msg };
  }
}

function setFileAnalysisState(fileEntry, { status, message }) {
  fileEntry.analysis = fileEntry.analysis || {}
  fileEntry.analysis.status = status
  fileEntry.analysis.message = message || ''
  fileEntry.analysis.updatedAt = new Date().toISOString()
}

// Admin settings
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpass';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'verysecret'

// DEBUG: log whether we're using the default admin password (does not print the secret)
if (process.env.ADMIN_PASSWORD) {
  console.log('ADMIN_PASSWORD provided via environment')
} else {
  console.log('ADMIN_PASSWORD not set — server using default password: "adminpass"')
}

// lightweight status endpoint to check admin password source (safe to expose locally)
app.get(withBackendPrefix('/admin/status'), (req, res) => {
  return res.json({ usingDefaultAdminPassword: (ADMIN_PASSWORD === 'adminpass'), hasEnvAdminPassword: !!process.env.ADMIN_PASSWORD })
})

// Simple records store (append to this file)
const RECORDS_FILE = path.join(__dirname, 'records.json');
if (!fs.existsSync(RECORDS_FILE)) fs.writeFileSync(RECORDS_FILE, JSON.stringify([]));

// Optional Cloudinary setup (set CLOUDINARY_URL or CLOUDINARY_* env vars)
let cloudinaryClient = null;
try {
  const cloudinary = require('cloudinary').v2
  if (process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    })
    cloudinaryClient = cloudinary
    console.log('Cloudinary configured')
  }
} catch (err) {
  console.warn('Cloudinary not configured or package missing')
}

const jwt = require('jsonwebtoken')

// Build an absolute public URL from an incoming request.
// This avoids frontend-origin mismatches for media URLs in dev/prod/proxy setups.
function getPublicOrigin(req) {
  const xfProto = req.headers['x-forwarded-proto']
  const xfHost = req.headers['x-forwarded-host']
  const proto = String(xfProto || req.protocol || 'http').split(',')[0].trim()
  const host = String(xfHost || req.get('host') || '').split(',')[0].trim()
  if (!host) return ''
  return `${proto}://${host}`
}

function toAbsoluteUrl(req, maybeRelativeUrl) {
  const u = String(maybeRelativeUrl || '')
  if (!u) return u
  if (/^https?:\/\//i.test(u)) return u
  const origin = getPublicOrigin(req)
  if (!origin) return u
  return u.startsWith('/') ? `${origin}${u}` : `${origin}/${u}`
}

// ---- Optional ffmpeg helpers (for reliable chunk assembly + MP4 output) -----

function isFfmpegLikelyAvailable() {
  // Allow explicitly disabling in environments where spawn is restricted.
  if (String(process.env.ENABLE_FFMPEG || '').toLowerCase() === 'false') return false
  // If explicitly enabled, try anyway.
  // Otherwise, do a lightweight best-effort check when the feature is used.
  return true
}

function runFfmpeg(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { cwd })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true })
      const e = new Error(`ffmpeg exited with code ${code}`)
      e.stderr = stderr
      reject(e)
    })
  })
}

async function tryAssembleToMp4WithFfmpeg({ chunkPaths, outPathMp4 }) {
  // Use ffmpeg concat demuxer for proper media concatenation.
  // Works when the chunk files are valid media segments.
  const listPath = path.join(path.dirname(outPathMp4), `ffconcat-${Date.now()}.txt`)
  try {
    const contents = chunkPaths
      .map(p => `file '${String(p).replace(/'/g, "'\\''")}'`)
      .join('\n')
    fs.writeFileSync(listPath, contents)

    // Re-encode to H.264/AAC MP4 for maximum compatibility.
    // -map 0:a? makes audio optional (won't fail if no audio track).
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outPathMp4,
    ])

    return { ok: true }
  } finally {
    try { fs.unlinkSync(listPath) } catch (e) {}
  }
}

// Interview session templates created by admin (e.g. "C#", "React", etc.)
const INTERVIEWS_FILE = path.join(__dirname, 'interviews.json')
if (!fs.existsSync(INTERVIEWS_FILE)) fs.writeFileSync(INTERVIEWS_FILE, JSON.stringify([]))

function readJsonArray(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    return []
  }
}

function writeJsonArray(filePath, arr) {
  fs.writeFileSync(filePath, JSON.stringify(arr || [], null, 2))
}

function readRecords() {
  try {
    return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
  } catch (e) {
    return []
  }
}

function findSession(records, sessionId) {
  return (records || []).find(r => r && (r.id === sessionId || r.sessionId === sessionId)) || null
}

function requireAdmin(req, res) {
  const auth = req.headers.authorization || ''
  const m = auth.match(/^Bearer (.+)$/)
  if (!m) {
    res.status(401).json({ error: 'Missing token' })
    return null
  }
  const token = m[1]
  try {
    jwt.verify(token, ADMIN_SECRET)
    return token
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' })
    return null
  }
}

app.post(withBackendPrefix('/generate-questions'), async (req, res) => {
  const { num = 5, topic = 'general behavioral', stack } = req.body || {};

  if (!OPENAI_KEY) {
    // Fallback questions (used when OpenAI isn't configured)
    if (stack) {
      const fallback = [
        `Briefly introduce yourself (role, years of experience) and describe your experience with ${stack}.`,
        `Describe a recent feature you built using ${stack}. What was your approach and what trade-offs did you make?`,
        `Explain one core concept in ${stack} that you rely on often, and give a real example of how it helped you.`,
        `Tell me about a difficult bug or outage you handled in a ${stack} system. How did you debug it and prevent it from happening again?`,
        `How do you ensure quality in ${stack} projects (testing, reviews, CI, monitoring)? Give a concrete example.`,
      ].slice(0, num)
      return res.json({ questions: fallback })
    }

    const general = [
      'Please introduce yourself briefly (role, years of experience, and what you’re strongest at).',
      'Walk me through a project you owned end-to-end. What were the requirements, your design decisions, and the outcome?',
      'Describe a time you had to debug a tricky production issue. How did you diagnose it and what did you change?',
      'How do you communicate trade-offs and risks to stakeholders when you have limited time?',
      'What practices do you follow to ensure code quality and reliability? Give a concrete example.',
    ].slice(0, num)
    return res.json({ questions: general });
  }

  try {
    const effectiveTopic = stack ? `${stack} technical interview` : topic

    const structure = stack
      ? [
        `You are generating interview questions for a professional software engineering interview focused on: ${stack}.`,
        `Output MUST be valid JSON only in the shape: {"questions":["..."]}. No extra keys.`,
        `Write ${num} questions total.`,
        `Quality requirements:`,
        `- Questions must be specific, senior-friendly, and realistic; avoid generic prompts like "Tell me about yourself" unless required by structure.`,
        `- Prefer scenario-based questions that force concrete examples (design, debugging, trade-offs, testing, performance, reliability).`,
        `- Ask in a direct interviewer voice. No fluff, no preamble, no "as an AI".`,
        `- Keep each question to 1-2 sentences, clear and professional.`,
        `Structure requirements:`,
        `- Q1 MUST be an intro/background question (experience with ${stack}).`,
        `- Include at least one question about system design/architecture or API design in ${stack}.`,
        `- Include at least one question about debugging/production incident handling.`,
        `- Include at least one question about performance/scalability OR security (pick one appropriate to ${stack}).`,
        `- Include at least one question about quality (tests, CI, observability) and trade-offs.`,
      ].join('\n')
      : [
        `You are generating professional interview questions for: ${effectiveTopic}.`,
        `Output MUST be valid JSON only in the shape: {"questions":["..."]}. No extra keys.`,
        `Write ${num} questions total.`,
        `Quality requirements:`,
        `- Questions must be specific, realistic, and based on real work for a software engineer.`,
        `- Prefer scenario-based prompts requiring concrete examples (STAR).`,
        `- Cover a mix of: ownership/project deep dive, debugging, system design, collaboration/communication, and quality.`,
        `- Ask in a direct interviewer voice. Keep each question to 1-2 sentences.`,
      ].join('\n')

    const system =
      structure;
    const body = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Return only JSON: {"questions": ["q1", "q2", ...] }' }
      ],
      max_tokens: 500
    };

    const resp = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    // try to extract JSON
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      // try to find JSON substring
      const m = content.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    if (parsed && Array.isArray(parsed.questions)) {
      return res.json({ questions: parsed.questions });
    }

    // fallback: split by lines
    const guesses = content.split(/\r?\n/).filter(Boolean).slice(0, num);
    return res.json({ questions: guesses });

  } catch (err) {
    console.error('generate-questions error', err);

    // Use the same professional fallback questions as the "no OPENAI_KEY" path.
    if (stack) {
      const fallback = [
        `Briefly introduce yourself (role, years of experience) and describe your experience with ${stack}.`,
        `Describe a recent feature you built using ${stack}. What was your approach and what trade-offs did you make?`,
        `Explain one core concept in ${stack} that you rely on often, and give a real example of how it helped you.`,
        `Tell me about a difficult bug or outage you handled in a ${stack} system. How did you debug it and prevent it from happening again?`,
        `How do you ensure quality in ${stack} projects (testing, reviews, CI, monitoring)? Give a concrete example.`,
      ].slice(0, num)
      return res.json({ questions: fallback, error: err.message })
    }

    const general = [
      'Please introduce yourself briefly (role, years of experience, and what you’re strongest at).',
      'Walk me through a project you owned end-to-end. What were the requirements, your design decisions, and the outcome?',
      'Describe a time you had to debug a tricky production issue. How did you diagnose it and what did you change?',
      'How do you communicate trade-offs and risks to stakeholders when you have limited time?',
      'What practices do you follow to ensure code quality and reliability? Give a concrete example.',
    ].slice(0, num)
    return res.json({ questions: general, error: err.message })
  }
});

app.post(withBackendPrefix('/upload-answer'), upload.single('video'), (req, res) => {
  const file = req.file;
  const metadata = req.body.metadata ? (() => { try { return JSON.parse(req.body.metadata) } catch { return {} } })() : {};
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  // Group uploads by sessionId so admin sees per-user sessions instead of per-chunk entries
  const sessionId = metadata.sessionId || `session-${Date.now()}`
  const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]');
  let session = records.find(r => r.id === sessionId || r.sessionId === sessionId)
  if (!session) {
    session = {
      id: sessionId,
      sessionId,
      name: metadata.name || 'Unknown',
      createdAt: new Date().toISOString(),
      files: [],
      metadata: {}
    }
    records.push(session)
  }
  session.metadata = session.metadata || {}
  // Persist candidate info
  if (metadata.email) session.metadata.email = String(metadata.email).trim()
  if (metadata.country) session.metadata.country = String(metadata.country).trim()
  if (metadata.phone) session.metadata.phone = String(metadata.phone).trim()
  if (metadata.source) session.metadata.source = String(metadata.source).trim()
  // Attach interviewId/stack to session for admin filtering & correct labeling
  if (metadata.interviewId) {
    session.metadata.interviewId = metadata.interviewId
    const interviews = readJsonArray(INTERVIEWS_FILE)
    const interview = interviews.find(i => i.id === metadata.interviewId)
    if (interview && interview.stack) session.metadata.stack = interview.stack
  }
  // Mark this session as finalized (prevents background chunk assembler from running mid-session)
  session.metadata.recordingActive = false
  session.metadata.finalizedAt = new Date().toISOString()

  const fileEntry = {
    id: Date.now().toString(),
    filename: file.filename,
    path: `/uploads/${file.filename}`,
    question: metadata.question,
    index: metadata.index,
    source: 'full',
    uploadedAt: new Date().toISOString()
  }

  // Initialize analysis state so admin UI can show accurate progress instead of "pending forever"
  if (!OPENAI_KEY) {
    setFileAnalysisState(fileEntry, { status: 'unavailable', message: 'OpenAI not configured (set OPENAI_API_KEY).' })
  } else {
    setFileAnalysisState(fileEntry, { status: 'pending', message: 'Transcription in progress.' })
  }

  const finalize = async () => {
    if (cloudinaryClient) {
      try {
        const r = await cloudinaryClient.uploader.upload(path.join(UPLOAD_DIR, file.filename), { resource_type: 'video' })
        fileEntry.remoteUrl = r.secure_url
      } catch (err) {
        console.warn('Cloudinary upload failed', err.message || err)
      }
    }
    session.files.push(fileEntry)
    session.lastUploadedAt = fileEntry.uploadedAt
    // update session name if provided
    if (metadata.name) session.name = metadata.name
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))

    // Cleanup: if chunk files exist for this session, delete them.
    // We keep chunk uploads as a resilience mechanism, but prefer the final single file for playback reliability.
    try {
      const chunkFiles = fs.readdirSync(CHUNK_DIR).filter(f => f.startsWith(`${sessionId}-chunk-`))
      for (const f of chunkFiles) {
        try { fs.unlinkSync(path.join(CHUNK_DIR, f)) } catch (e) {}
      }
    } catch (e) {}

    // After saving, attempt server-side transcription (no English level scoring)
    try {
      if (!OPENAI_KEY) return

      const tr = await transcribeFile(path.join(UPLOAD_DIR, file.filename))
      if (tr.text) {
        fileEntry.transcript = tr.text
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
      } else {
        setFileAnalysisState(fileEntry, { status: 'error', message: tr.error || 'Transcription failed.' })
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
        return
      }

      setFileAnalysisState(fileEntry, { status: 'done', message: 'Transcription complete.' })
      fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
    } catch (err) {
      console.warn('post-upload AI processing failed', err.message || err)
      setFileAnalysisState(fileEntry, { status: 'error', message: err.message || 'Transcription failed.' })
      try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2)) } catch (e) {}
    }
  }

  finalize().then(() => {
    return res.json({ ok: true, file: file.filename, metadata, fileEntry, sessionId })
  }).catch(err => {
    console.error(err)
    return res.status(500).json({ error: 'Save failed' })
  })
})

// Receive chunked uploads. Stores each chunk as a separate file under chunks/.
app.post(withBackendPrefix('/upload-chunk'), upload.single('video'), (req, res) => {
  const file = req.file;
  const metadata = req.body.metadata ? (() => { try { return JSON.parse(req.body.metadata) } catch { return {} } })() : {};
  if (!file) return res.status(400).json({ error: 'No chunk uploaded' });
  const sessionId = metadata.sessionId || `session-${Date.now()}`
  // preserve index 0 (don't treat 0 as falsy) — use undefined check
  const index = (typeof metadata.index !== 'undefined' && metadata.index !== null) ? metadata.index : Date.now()
  console.log('Received /upload-chunk:', { orig: file.originalname, stored: file.filename, metadata, sessionId, index })

  // Ensure we persist session metadata early so background assembly never creates "Unknown" sessions.
  try {
    const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
    let session = records.find(r => r.id === sessionId || r.sessionId === sessionId)
    if (!session) {
      session = { id: sessionId, sessionId, name: metadata.name || 'Unknown', createdAt: new Date().toISOString(), files: [], metadata: {} }
      records.push(session)
    }
    session.metadata = session.metadata || {}
    if (metadata.name && String(metadata.name).trim()) session.name = String(metadata.name).trim()
    if (metadata.email) session.metadata.email = String(metadata.email).trim()
    if (metadata.country) session.metadata.country = String(metadata.country).trim()
    if (metadata.phone) session.metadata.phone = String(metadata.phone).trim()
    if (metadata.source) session.metadata.source = String(metadata.source).trim()
    if (metadata.interviewId) {
      session.metadata.interviewId = metadata.interviewId
      const interviews = readJsonArray(INTERVIEWS_FILE)
      const interview = interviews.find(i => i.id === metadata.interviewId)
      if (interview && interview.stack) session.metadata.stack = interview.stack
    }
    session.metadata.recordingActive = true
    session.metadata.lastChunkAt = new Date().toISOString()
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
  } catch (e) {
    // ignore persistence errors
  }
  // move chunk file into CHUNK_DIR with session prefix
  const chunkName = `${sessionId}-chunk-${index}-${file.filename}`
  const dest = path.join(CHUNK_DIR, chunkName)
  try {
    fs.renameSync(path.join(UPLOAD_DIR, file.filename), dest)
    console.log('Moved chunk to', dest)
  } catch (err) {
    // fallback to copy
    fs.copyFileSync(path.join(UPLOAD_DIR, file.filename), dest)
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)) } catch (e) {}
  }
  return res.json({ ok: true, chunk: chunkName, sessionId })
})

// Finalize upload: assemble chunks for a session into one file and create session file entry
// Helper: assemble chunks for a session into one file and return fileEntry
async function assembleChunks(sessionId, name, interviewId, candidate) {
  const files = fs.readdirSync(CHUNK_DIR).filter(f => f.startsWith(`${sessionId}-chunk-`))
  if (!files.length) throw new Error('no chunks found')
  // sort by chunk index embedded in filename: session-chunk-<index>-<orig>
  files.sort((a,b) => {
    const ai = a.split('-chunk-')[1].split('-')[0]
    const bi = b.split('-chunk-')[1].split('-')[0]
    return Number(ai) - Number(bi)
  })

  const chunkPaths = files.map(f => path.join(CHUNK_DIR, f))

  // Prefer producing MP4 for maximum compatibility, if ffmpeg is available.
  // If ffmpeg isn't available (or fails), fall back to byte concatenation (best effort).
  let outName = `${Date.now()}-${sessionId}.mp4`
  let outPath = path.join(UPLOAD_DIR, outName)
  let assembledViaFfmpeg = false

  if (isFfmpegLikelyAvailable()) {
    try {
      await tryAssembleToMp4WithFfmpeg({ chunkPaths, outPathMp4: outPath })
      assembledViaFfmpeg = true
    } catch (e) {
      // If ffmpeg is missing or concat fails, we'll fall back to naive concat.
      console.warn('ffmpeg chunk assembly failed; falling back to naive concat', e?.message || e)
      assembledViaFfmpeg = false
    }
  }

  if (!assembledViaFfmpeg) {
    outName = `${Date.now()}-${sessionId}.webm`
    outPath = path.join(UPLOAD_DIR, outName)
    const ws = fs.createWriteStream(outPath)
    for (const p of chunkPaths) {
      const buf = fs.readFileSync(p)
      ws.write(buf)
    }
    ws.end()
    await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject) })
  }

  // create session entry and attach file
  const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
  let session = records.find(r => r.id === sessionId || r.sessionId === sessionId)
  if (!session) {
    session = { id: sessionId, sessionId, name: name || 'Unknown', createdAt: new Date().toISOString(), files: [], metadata: {} }
    records.push(session)
  }
  session.metadata = session.metadata || {}
  // if we already know the session name (from upload-chunk), don't overwrite it
  if (!session.name || session.name === 'Unknown') {
    if (name) session.name = name
  }
  if (candidate) {
    if (candidate.email) session.metadata.email = String(candidate.email).trim()
    if (candidate.country) session.metadata.country = String(candidate.country).trim()
    if (candidate.phone) session.metadata.phone = String(candidate.phone).trim()
    if (candidate.source) session.metadata.source = String(candidate.source).trim()
  }
  if (interviewId) {
    session.metadata.interviewId = interviewId
    // attach stack if we can resolve it
    const interviews = readJsonArray(INTERVIEWS_FILE)
    const interview = interviews.find(i => i.id === interviewId)
    if (interview && interview.stack) session.metadata.stack = interview.stack
  }
  // Mark as finalized after assembly
  session.metadata.recordingActive = false
  session.metadata.finalizedAt = new Date().toISOString()
  const fileEntry = { id: Date.now().toString(), filename: outName, path: `/uploads/${outName}`, question: null, index: null, uploadedAt: new Date().toISOString() }
  session.files.push(fileEntry)
  session.lastUploadedAt = fileEntry.uploadedAt
  if (name) session.name = name
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))

  // remove chunk files
  for (const f of files) {
    try { fs.unlinkSync(path.join(CHUNK_DIR, f)) } catch (e) {}
  }

  // trigger transcription and assessment asynchronously
  ;(async () => {
    try {
      if (!OPENAI_KEY) {
        setFileAnalysisState(fileEntry, { status: 'unavailable', message: 'OpenAI not configured (set OPENAI_API_KEY).' })
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
        return
      }

      setFileAnalysisState(fileEntry, { status: 'pending', message: 'Transcription in progress.' })
      fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))

      const tr = await transcribeFile(outPath)
      if (tr.text) {
        fileEntry.transcript = tr.text
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))

        setFileAnalysisState(fileEntry, { status: 'done', message: 'Transcription complete.' })
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
      } else {
        setFileAnalysisState(fileEntry, { status: 'error', message: tr.error || 'Transcription failed.' })
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
      }
    } catch (err) {
      console.warn('post-assemble AI failed', err.message || err)
      setFileAnalysisState(fileEntry, { status: 'error', message: err.message || 'Transcription failed.' })
      try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2)) } catch (e) {}
    }
  })()

  return fileEntry
}

// POST /upload-complete (explicit finalization)
app.post(withBackendPrefix('/upload-complete'), express.json(), async (req, res) => {
  const { sessionId, name, interviewId, email, country, phone, source } = req.body || {}
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

  // Guard: don't assemble while the candidate is still recording.
  // Some browsers fire visibility/unload events mid-recording; without this, we'd create partial files.
  try {
    const records = readRecords()
    const session = findSession(records, sessionId)
    if (session?.metadata?.recordingActive === true) {
      return res.status(409).json({ error: 'Recording still in progress. Please try again after recording stops.' })
    }
  } catch (e) {}

  try {
    const fileEntry = await assembleChunks(sessionId, name, interviewId, { email, country, phone, source })
    return res.json({ ok: true, sessionId, file: fileEntry })
  } catch (err) {
    console.error('upload-complete failed', err.message || err)
    return res.status(500).json({ error: err.message || 'assemble failed' })
  }
})

// Beacon-friendly GET endpoint for sendBeacon/visibilitychange (non-blocking)
app.get(withBackendPrefix('/upload-complete-beacon'), (req, res) => {
  const sessionId = req.query.sessionId
  const name = req.query.name
  const interviewId = req.query.interviewId
  const email = req.query.email
  const country = req.query.country
  const phone = req.query.phone
  const source = req.query.source
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

  // Guard: don't assemble while recording is active. Just accept the beacon and no-op.
  try {
    const records = readRecords()
    const session = findSession(records, sessionId)
    if (session?.metadata?.recordingActive === true) {
      return res.status(202).json({ ok: true, message: 'Recording active; assemble skipped' })
    }
  } catch (e) {}

  // run in background, don't block the request
  assembleChunks(sessionId, name, interviewId, { email, country, phone, source }).then(file => {
    console.log('Beacon assembled session', sessionId, '->', file.filename)
  }).catch(err => {
    // It's normal to have no chunks (e.g. tab closed before first timeslice, or final file upload path used).
    if ((err && err.message) === 'no chunks found') {
      console.log('Beacon assemble skipped (no chunks) for', sessionId)
      return
    }
    console.warn('Beacon assemble failed for', sessionId, err.message || err)
  })
  return res.status(202).json({ ok: true, message: 'Assemble triggered' })
})

// Accept POST beacons too (navigator.sendBeacon will POST a small payload)
app.post(withBackendPrefix('/upload-complete-beacon'), express.json(), (req, res) => {
  const { sessionId, name, interviewId, email, country, phone, source } = req.body || {}
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })

  // Guard: don't assemble while recording is active. Just accept the beacon and no-op.
  try {
    const records = readRecords()
    const session = findSession(records, sessionId)
    if (session?.metadata?.recordingActive === true) {
      return res.status(202).json({ ok: true, message: 'Recording active; assemble skipped' })
    }
  } catch (e) {}

  assembleChunks(sessionId, name, interviewId, { email, country, phone, source }).then(file => {
    console.log('Beacon (POST) assembled session', sessionId, '->', file.filename)
  }).catch(err => {
    if ((err && err.message) === 'no chunks found') {
      console.log('Beacon (POST) assemble skipped (no chunks) for', sessionId)
      return
    }
    console.warn('Beacon (POST) assemble failed for', sessionId, err.message || err)
  })
  return res.status(202).json({ ok: true, message: 'Assemble triggered' })
})

// Background scanner: assemble stale chunk groups after a short inactivity window
setInterval(() => {
  try {
    const files = fs.readdirSync(CHUNK_DIR)
    const groups = {}
    for (const f of files) {
      const m = f.match(/^(.*?)-chunk-/)
      if (!m) continue
      const sid = m[1]
      groups[sid] = groups[sid] || []
      groups[sid].push(f)
    }
    const now = Date.now()
    for (const sid of Object.keys(groups)) {
      // If we have a session record, avoid assembling while recording is active or if already finalized.
      try {
        const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
        const session = records.find(r => r.id === sid || r.sessionId === sid)
        if (session && session.metadata) {
          if (session.metadata.recordingActive === true) continue
          if (session.metadata.finalizedAt) continue
        }
      } catch (e) {
        // ignore
      }

      // check most recent mtime of group's files
      let latest = 0
      for (const fn of groups[sid]) {
        const st = fs.statSync(path.join(CHUNK_DIR, fn))
        const mtime = st.mtimeMs || st.mtime.getTime()
        if (mtime > latest) latest = mtime
      }
      // if no chunk activity for 30 seconds, attempt assembly
      if (now - latest > 30_000) {
        console.log('Background assembler: assembling stale session', sid)
        assembleChunks(sid)
          .then(f => console.log('Background assembled', sid, f && f.filename))
          .catch(e => {
            if ((e && e.message) === 'no chunks found') return
            console.warn('Background assemble failed', sid, e.message || e)
          })
      }
    }
  } catch (err) { /* ignore scanning errors */ }
}, 20_000)

// ---------------- Interview sessions (admin-managed) ------------------------

// Public: fetch interview session info by id (used by client session links)
app.get(['/interviews/:id', '/backend/interviews/:id'], (req, res) => {
  const id = req.params.id
  const interviews = readJsonArray(INTERVIEWS_FILE)
  const interview = interviews.find(i => i.id === id)
  if (!interview) return res.status(404).json({ error: 'Not found' })
  return res.json({ interview: { id: interview.id, stack: interview.stack, createdAt: interview.createdAt, title: interview.title || '' } })
})

// Admin: list interview sessions
app.get(withBackendPrefix('/admin/interviews'), (req, res) => {
  if (!requireAdmin(req, res)) return
  const interviews = readJsonArray(INTERVIEWS_FILE)
  return res.json({ interviews })
})

// Admin: create interview session (stack/topic)
app.post(withBackendPrefix('/admin/interviews'), express.json(), (req, res) => {
  if (!requireAdmin(req, res)) return
  console.log('admin/interviews', req.body)
  const { stack, title } = req.body || {}
  if (!stack || !String(stack).trim()) return res.status(400).json({ error: 'stack required' })
  const safeStack = String(stack).trim()
  const id = `iv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const interview = {
    id,
    stack: safeStack,
    title: title ? String(title).trim() : '',
    createdAt: new Date().toISOString(),
  }
  const interviews = readJsonArray(INTERVIEWS_FILE)
  interviews.unshift(interview)
  writeJsonArray(INTERVIEWS_FILE, interviews)
  return res.json({ ok: true, interview })
})

// Admin: delete interview session
app.delete(['/admin/interviews/:id', '/backend/admin/interviews/:id'], (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = req.params.id
  const interviews = readJsonArray(INTERVIEWS_FILE)
  const idx = interviews.findIndex(i => i.id === id)
  if (idx === -1) return res.status(404).json({ error: 'Not found' })
  interviews.splice(idx, 1)
  writeJsonArray(INTERVIEWS_FILE, interviews)
  return res.json({ ok: true })
})

// Converse endpoint: receive user text and return assistant reply.
app.post(withBackendPrefix('/converse'), express.json(), async (req, res) => {
  const { sessionId, text } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text required' })

  const systemPrompt = `You are Ava, a friendly and professional female recruiter. Speak like a recruiter: ask follow-up questions, provide feedback, and answer candidate questions concisely and politely. Keep tone warm and encouraging.`

  try {
    const body = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      max_tokens: 500
    }

    if (!OPENAI_KEY) {
      // fallback reply when API key not configured
      const fallback = "Hi — I'm your virtual recruiter. I can't access the AI service right now, but imagine I would answer helpfully."
      return res.json({ reply: fallback })
    }

    const resp = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(body)
    })

    const data = await resp.json()
    const reply = data?.choices?.[0]?.message?.content || "I'm sorry, I couldn't generate a response."

    // Optionally append conversation to records.json under the session entry
    try {
      if (sessionId) {
        const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
        let entry = records.find(r => r.id === sessionId || r.sessionId === sessionId)
        if (!entry) {
          entry = { id: sessionId, sessionId, name: 'Unknown', createdAt: new Date().toISOString(), files: [] }
          records.push(entry)
        }
        entry.conversation = entry.conversation || []
        entry.conversation.push({ role: 'user', text, at: new Date().toISOString() })
        entry.conversation.push({ role: 'assistant', text: reply, at: new Date().toISOString() })
        fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
      }
    } catch (err) {
      console.warn('Could not persist conversation', err.message || err)
    }

    return res.json({ reply })
  } catch (err) {
    console.error('converse error', err)
    return res.status(500).json({ error: 'converse failed' })
  }
})

// Admin login - returns JWT
app.post(withBackendPrefix('/admin/login'), express.json(), (req, res) => {
  const { password } = req.body || {}
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' })
  const token = jwt.sign({ admin: true }, ADMIN_SECRET, { expiresIn: '12h' })
  return res.json({ ok: true, token })
})

// List recordings (protected) - return sessions with files
app.get(withBackendPrefix('/admin/recordings'), (req, res) => {
  const auth = req.headers.authorization || ''
  const m = auth.match(/^Bearer (.+)$/)
  if (!m) return res.status(401).json({ error: 'Missing token' })
  const token = m[1]
  try {
    jwt.verify(token, ADMIN_SECRET)
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
  const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
  // For local files, return a URL that works behind nginx `/backend/` proxy.
  // We serve uploads at both `/uploads` and `/backend/uploads` on the node server.
  const uploadsPrefix = '/backend'
  const list = records.map(s => ({
    id: s.id,
    sessionId: s.sessionId || s.id,
    name: s.name || s.metadata?.name || 'Unknown',
    metadata: s.metadata || {},
    createdAt: s.createdAt || s.uploadedAt,
    lastUploadedAt: s.lastUploadedAt,
    files: (s.files || []).map(f => ({
      id: f.id,
      filename: f.filename,
      question: f.question,
      index: f.index,
      uploadedAt: f.uploadedAt,
      // Always return an absolute URL so the admin <video> element loads from the backend
      // even when the frontend is served from a different origin (e.g. preview server).
      url: f.remoteUrl || toAbsoluteUrl(req, `${uploadsPrefix}${f.path}`),
      transcript: f.transcript,
      analysis: f.analysis,
    })),
    conversation: s.conversation || []
  }))
  return res.json({ recordings: list })
})

// Delete a session and associated files (protected)
app.delete(['/admin/recordings/:id', '/backend/admin/recordings/:id'], (req, res) => {
  const auth = req.headers.authorization || ''
  const m = auth.match(/^Bearer (.+)$/)
  if (!m) return res.status(401).json({ error: 'Missing token' })
  const token = m[1]
  try { jwt.verify(token, ADMIN_SECRET) } catch (err) { return res.status(401).json({ error: 'Invalid token' }) }

  const id = req.params.id
  const records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8') || '[]')
  const idx = records.findIndex(r => r.id === id || r.sessionId === id)
  if (idx === -1) return res.status(404).json({ error: 'Not found' })
  const session = records[idx]
  // remove files from disk
  try {
    (session.files || []).forEach(f => {
      const p = path.join(UPLOAD_DIR, f.filename)
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p) } catch (e) { console.warn('Could not delete', p, e.message || e) }
      }
    })
  } catch (err) { console.warn('delete files error', err.message || err) }

  // remove session from records
  records.splice(idx, 1)
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2))
  return res.json({ ok: true })
})

// Serve uploads statically
app.use(['/uploads', '/backend/uploads'], express.static(UPLOAD_DIR))

// Map common upload-size errors to 413 with a clear message.
// Note: if you're behind a reverse proxy (nginx/traefik/cloudflare), the proxy may reject requests
// before they reach Node. In that case, you must increase the proxy's max body size too.
app.use((err, req, res, next) => {
  try {
    if (err && (err.code === 'LIMIT_FILE_SIZE' || err.status === 413)) {
      return res.status(413).json({
        error: 'Request Entity Too Large',
        message: `Upload rejected (too large). Increase proxy max body size and/or set MAX_UPLOAD_MB (current: ${MAX_UPLOAD_MB}).`,
      })
    }
  } catch (e) {}
  return next(err)
})

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
