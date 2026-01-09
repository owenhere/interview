const esbuild = require('esbuild')

esbuild.build({
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: true,
  outdir: 'public',
  entryNames: 'app',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.API_BASE': JSON.stringify(process.env.API_BASE || 'http://localhost:4000'),
    'process.env.API_PREFIX': JSON.stringify(process.env.API_PREFIX || '/backend'),
  },
}).then(() => console.log('Built to public/app.js')).catch(err => { console.error(err); process.exit(1) })
