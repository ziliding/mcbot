import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ActionError, type Actions } from './actions.js'
import { log } from './log.js'

type ToolResult = { content: Array<{ type: 'text', text: string }>, isError?: boolean }

/** Run an action and turn its result or ActionError into an MCP tool result. */
async function run (tool: string, args: unknown, fn: () => unknown): Promise<ToolResult> {
  const started = Date.now()
  try {
    const out = await fn()
    const text = typeof out === 'string' ? out : JSON.stringify(out)
    log('mcp.call', { tool, args, ok: true, ms: Date.now() - started })
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log('mcp.call', { tool, args, ok: false, ms: Date.now() - started, error: message, unexpected: !(e instanceof ActionError) })
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

const player = z.string().optional().describe('Minecraft player name; omit for the usual companion player')

function buildServer (a: Actions): McpServer {
  const s = new McpServer({ name: 'minecraft-body', version: '0.3.0' })

  s.registerTool('get_state', {
    description: 'Current state of your Minecraft body: position, health/food, time of day, current activity, inventory, nearby players and the nearest hostile mob.',
    inputSchema: {}
  }, async () => run('get_state', {}, () => a.state()))

  s.registerTool('say', {
    description: 'Say something in Minecraft game chat. You do NOT need this to reply to players: your normal replies in the Matrix room are already spoken in game.',
    inputSchema: { text: z.string().min(1).max(1000) }
  }, async (args) => run('say', args, () => a.say(args.text)))

  s.registerTool('come_to_player', {
    description: 'Walk to a player and stop next to them. Waits until arrived (up to 60s).',
    inputSchema: { player, range: z.number().min(1).max(10).default(2) }
  }, async (args) => run('come_to_player', args, () => a.comeTo(args.player, args.range)))

  s.registerTool('follow_player', {
    description: 'Keep following a player until stop is called or another movement command starts. Returns immediately.',
    inputSchema: { player, distance: z.number().min(1).max(10).default(2) }
  }, async (args) => run('follow_player', args, () => a.follow(args.player, args.distance)))

  s.registerTool('go_to', {
    description: 'Walk to coordinates. Omit y to only reach the x/z column. Waits until arrived (up to 120s).',
    inputSchema: { x: z.number(), y: z.number().optional(), z: z.number(), range: z.number().min(0).max(10).default(1) }
  }, async (args) => run('go_to', args, () => a.goTo(args.x, args.y, args.z, args.range)))

  s.registerTool('mine_block', {
    description: 'Find the nearest blocks of a type, walk to them, break them and pick up the drops. Use Minecraft ids, e.g. oak_log (chop a tree), birch_log, stone, coal_ore. Waits until done.',
    inputSchema: { block: z.string().min(1), count: z.number().int().min(1).max(64).default(1), max_distance: z.number().int().min(4).max(64).default(32) }
  }, async (args) => run('mine_block', args, () => a.mineBlock(args.block, args.count, args.max_distance)))

  s.registerTool('look_at_player', {
    description: 'Turn to face a player.',
    inputSchema: { player }
  }, async (args) => run('look_at_player', args, () => a.lookAt(args.player)))

  s.registerTool('stop', {
    description: 'Stop whatever you are doing (following, walking, mining).',
    inputSchema: {}
  }, async () => run('stop', {}, () => a.stop()))

  s.registerTool('respawn', {
    description: 'Respawn after dying.',
    inputSchema: {}
  }, async () => run('respawn', {}, () => a.respawn()))

  return s
}

/**
 * MCP over Streamable HTTP, stateless: every POST gets a fresh McpServer bound
 * to the same Actions (and so the same single bot). Survives Hermes restarts
 * and bot restarts with no session to lose.
 */
export function startMcpServer (actions: Actions, port: number, token: string): http.Server {
  const expected = Buffer.from(`Bearer ${token}`)
  const authorized = (h: string | undefined): boolean => {
    const got = Buffer.from(h ?? '')
    return got.length === expected.length && timingSafeEqual(got, expected)
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/health') {
        const s = actions.state()
        res.writeHead(s.connected ? 200 : 503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ connected: s.connected, activity: s.activity }))
        return
      }
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return }
      if (!authorized(req.headers.authorization)) {
        log('mcp.unauthorized', { remote: req.socket.remoteAddress })
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null }))
        return
      }
      const mcp = buildServer(actions)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void transport.close(); void mcp.close() })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, await readJson(req))
    })().catch((e: unknown) => {
      log('mcp.error', { message: e instanceof Error ? e.message : String(e) })
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  server.listen(port, '0.0.0.0', () => log('mcp.listening', { port, path: '/mcp' }))
  return server
}

async function readJson (req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 1_000_000) throw new Error('request too large')
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}
