const esbuild = require('esbuild')

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
