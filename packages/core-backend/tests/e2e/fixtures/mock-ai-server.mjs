import http from 'node:http'
const PORT = Number(process.env.MOCK_AI_PORT || 9999)
const DELAY = Number(process.env.MOCK_AI_DELAY_MS || 0)
let calls = 0
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/v1/messages')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      calls += 1
      const reply = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: `AI summary #${calls}` }], usage: { input_tokens: 20, output_tokens: 10 } })) }
      DELAY > 0 ? setTimeout(reply, DELAY) : reply()
    })
    return
  }
  res.writeHead(404); res.end('not found')
})
server.listen(PORT, '127.0.0.1', () => console.log(`mock-ai :${PORT} delay=${DELAY}ms`))
