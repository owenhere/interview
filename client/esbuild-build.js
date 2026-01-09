const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

function loadDotEnv() {
  // Minimal .env loader (no dependency) for build-time config.
  // Priority: .env.local then .env (values already set in process.env win).
  const cwd = process.cwd()
  const files = ['.env.local', '.env']
  for (const f of files) {
    const p = path.join(cwd, f)
    if (!fs.existsSync(p)) continue
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (!key) continue
      // remove optional surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      // Allow .env to override empty values (common when env var exists but is blank)
      if (!Object.prototype.hasOwnProperty.call(process.env, key) || process.env[key] === '') {
        process.env[key] = val
      }
    }
  }
}

loadDotEnv()

function envOrDefault(key, fallback) {
  // Important: allow empty string values (e.g. API_BASE="") for same-origin deploys.
  return Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : fallback
}

const API_BASE = envOrDefault('API_BASE', '')
const API_PREFIX = envOrDefault('API_PREFIX', '/backend')

esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  outdir: 'public',
  entryNames: 'app',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
    // In production, default to same-origin (API_BASE="") and prefix /backend for reverse proxy.
    'process.env.API_BASE': JSON.stringify(API_BASE),
    'process.env.API_PREFIX': JSON.stringify(API_PREFIX),
  },
}).then(() => console.log('Built to public/app.js')).catch(err => { console.error(err); process.exit(1) })
