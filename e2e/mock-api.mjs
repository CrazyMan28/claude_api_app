// A tiny stand-in for the Anthropic Messages API used by the UI end-to-end test.
// It speaks the real SSE streaming protocol so the official SDK, the agent loop,
// IPC and the React UI are all exercised exactly as in production.
import http from 'node:http'

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 }

async function streamSlow(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_slow', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const w of text.split(' ')) {
    if (res.destroyed || res.writableEnded) return
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w + ' ' } })
    await new Promise((r) => setTimeout(r, 120))
  }
  if (res.destroyed) return
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function streamMessage(res, content, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' })
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } }
  })
  content.forEach((block, index) => {
    if (block.type === 'thinking') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock-signature' } })
    } else if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const piece of block.text.match(/.{1,12}/gs)) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
    } else if (block.type === 'tool_use') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      const json = JSON.stringify(block.input)
      for (const piece of json.match(/.{1,16}/gs)) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  })
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

let slowCalls = 0
const hasResultFor = (msg, id) => Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result' && b.tool_use_id === id)

export function startMockApi() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.headers['x-api-key'] !== 'sk-ant-api03-e2e-test-key-0000000000') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        return
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: null, last_id: null }))
        return
      }
      const params = JSON.parse(body || '{}')
      requests.push({ url: req.url, headers: req.headers, params })
      if (!params.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: params.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }))
        return
      }
      const last = params.messages.at(-1)
      const userTexts = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
      const lastUserText = userTexts.filter((t) => !t.startsWith('Continue from where')).at(-1) ?? ''
      if (lastUserText.includes('slowly')) {
        slowCalls++
        if (slowCalls === 1) {
          void streamSlow(res, 'This is a long answer that streams word by word so that the user has time to press the stop button before it finishes. '.repeat(4))
          return
        }
        if (!hasResultFor(last, 'toolu_cmd')) {
          streamMessage(res, [{ type: 'text', text: 'Resuming. Let me run a command.' }, { type: 'tool_use', id: 'toolu_cmd', name: 'run_command', input: { command: 'echo forge-command-output' } }], 'tool_use')
          return
        }
        streamMessage(res, [{ type: 'text', text: 'Command finished; all good.' }], 'end_turn')
        return
      }
      const hasToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')
      if (!hasToolResult) {
        streamMessage(
          res,
          [
            { type: 'thinking', thinking: 'The user wants a hello world script. I will create it.' },
            { type: 'text', text: "I'll create a small **hello world** script for you." },
            { type: 'tool_use', id: 'toolu_e2e_write', name: 'write_file', input: { path: 'hello.py', content: 'print("Hello from Forge")\n' } }
          ],
          'tool_use'
        )
      } else if (params.messages.length < 5) {
        streamMessage(res, [{ type: 'tool_use', id: 'toolu_e2e_list', name: 'list_dir', input: {} }], 'tool_use')
      } else {
        streamMessage(res, [{ type: 'text', text: 'Done! I created `hello.py`:\n\n```python\nprint("Hello from Forge")\n```\n\nRun it with `python hello.py`.' }], 'end_turn')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }))
  })
}
