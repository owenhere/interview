const esbuild = require('esbuild')

async function start() {
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
      'process.env.API_BASE': JSON.stringify(process.env.API_BASE || 'http://localhost:4000'),
      // Default to /backend so production can reverse-proxy easily.
      'process.env.API_PREFIX': JSON.stringify(process.env.API_PREFIX || '/backend'),
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
