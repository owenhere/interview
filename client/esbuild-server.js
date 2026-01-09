const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

async function start() {
  function loadDotEnv() {
    // Minimal .env loader (no dependency) for dev-time config.
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
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
          process.env[key] = val
        }
      }
    }
  }

  function envOrDefault(key, fallback) {
    // Important: allow empty string values (e.g. API_BASE="") when needed.
    return Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : fallback
  }

  loadDotEnv()

  const API_BASE = envOrDefault('API_BASE', 'http://localhost:4000')
  const API_PREFIX = envOrDefault('API_PREFIX', '/backend')

  const clients = new Set()
  const liveReloadPlugin = {
    name: 'live-reload',
    setup(build) {
      build.onEnd(() => {
        for (const res of clients) {
          try { res.write('data: reload\n\n') } catch (e) {}
        }
      })
    },
  }

  const ctx = await esbuild.context({
    entryPoints: ['src/main.jsx'],
    bundle: true,
    outdir: 'public',
    entryNames: 'app',
    sourcemap: true,
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'css' },
    define: {
      'process.env.NODE_ENV': '"development"',
      // Allow configuring the backend URL via environment at build time.
      'process.env.API_BASE': JSON.stringify(API_BASE),
      'process.env.API_PREFIX': JSON.stringify(API_PREFIX),
    },
    plugins: [liveReloadPlugin],
  })

  await ctx.watch()
  // serve static files from public on port 5173 with SPA fallback
  const http = require('http')
  const handler = require('serve-handler')
  const serve = http.createServer((req, res) => {
    if (req.url === '/esbuild') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    return handler(req, res, {
    // prevent aggressive caching during development so CSS/JS edits show up immediately
    headers: [
      {
        source: '**/*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ],
    public: 'public',
    rewrites: [ { source: '/**', destination: '/index.html' } ]
    })
  })
  const PORT = process.env.PORT || 5173
  serve.listen(PORT, () => console.log(`esbuild dev server running at http://localhost:${PORT}`))
}

start().catch(err => { console.error(err); process.exit(1) })
