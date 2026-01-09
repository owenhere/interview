const http = require('http')
const handler = require('serve-handler')
const PORT = process.env.PORT || 5173

const server = http.createServer((req, res) => {
  return handler(req, res, { public: 'public', rewrites: [ { source: '/**', destination: '/index.html' } ] })
})

server.listen(PORT, () => console.log(`Preview server running at http://localhost:${PORT}`))
