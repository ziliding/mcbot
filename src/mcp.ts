import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ActionError, blockPattern, type Actions } from './actions.js'
import type { Cerebellum } from './cerebellum.js'
import { log } from './log.js'
import { checkCraftItem, checkSmeltItem, type ItemCatalog } from './crafting.js'
import { PlanStepSchema, STEP_KINDS, checkGatherBlocks, describeStep, type PlanStore } from './plan.js'

export interface McpDeps {
  actions: Actions
  plans: PlanStore
  /** Null when Jev is off: plans can't run, so set_plan refuses. */
  cerebellum: Cerebellum | null
  /** Every block id of the server version, for validating gather steps while offline too. */
  blockNames: string[]
  /** Item ids and which have crafting recipes, for validating craft steps. */
  items: ItemCatalog
}

/** The plan as Hermes sees it: goal, status, which step, code-measured progress. */
export function planSummary (d: McpDeps): Record<string, unknown> | null {
  const v = d.plans.view()
  if (!v) return null
  return {
    goal: v.goal,
    status: v.status,
    step: v.current ? `${v.stepIndex + 1}/${v.steps.length}` : null,
    current: v.current ? describeStep(v.current) : null,
    progress: d.cerebellum?.progressText() ?? null,
    reason: v.reason,
    steps: v.steps.map((s, i) => `${i + 1}. ${describeStep(s)}${i < v.stepIndex || v.status === 'done' ? ' (done)' : ''}`)
  }
}

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

function buildServer (d: McpDeps): McpServer {
  const a = d.actions
  const s = new McpServer({ name: 'minecraft-body', version: '0.5.0' })

  s.registerTool('get_state', {
    description: 'Current state of your Minecraft body: position, health/food, oxygen, time of day, current activity and running reflex (e.g. "fighting zombie", "eating bread"), held item, worn armor, inventory, nearby players, the nearest hostile mob, and the current plan (goal, status, step, measured progress).',
    inputSchema: {}
  }, async () => run('get_state', {}, () => ({ ...a.state(), plan: planSummary(d) })))

  s.registerTool('set_plan', {
    description: [
      'Give your body a multi-step job that it carries out on its own, step by step, while you stay free to talk. Replaces any current plan and takes over from a running follow/go_to.',
      `Step kinds (\`kind\`): ${STEP_KINDS.join(', ')}.`,
      '- gather {block, count}: mine `count` more blocks of a Minecraft BLOCK id and pick up the drops, e.g. {"kind":"gather","block":"*_log","count":10} (any wood). Name the block, not the drop: coal_ore not coal, stone (drops cobblestone).',
      '- craft {item, count}: craft `count` more of a Minecraft ITEM id, e.g. {"kind":"craft","item":"wooden_pickaxe","count":1}. Planks, sticks and a crafting table are made on the way from logs/planks carried. Fails (pausing the plan) with what is missing.',
      '- smelt {item, count, fuel?}: smelt in a furnace (one is crafted from 8 cobblestone and placed if none is near), e.g. {"kind":"smelt","item":"raw_iron","count":20}; item may be the input or the output (iron_ingot). 10 s per item; fuel from the inventory (coal, charcoal, planks, logs).',
      '- move_to {x, y?, z}: walk to coordinates.',
      '- come_to_player {player?}: walk back to a player (default: your usual companion).',
      '- wait {seconds}: stay put.',
      'Mining ore needs the right pickaxe (iron_ore needs stone_pickaxe or better; stone needs any pickaxe), and gather counts the drop (iron_ore -> raw_iron, stone -> cobblestone).',
      'Use a plan for long or multi-step jobs ("get me 20 logs" = gather 20 *_log, then come_to_player; "20 iron ingots" = gather 20 iron_ore, smelt 20 raw_iron, come_to_player), so you are not blocked for minutes. Use the single tools (mine_block, come_to_player, follow_player...) for quick one-shot actions.',
      'Progress and completion are measured by the body itself. When the plan finishes, or a step gets stuck (nothing left nearby, player offline, keeps failing), an [EVENT] message arrives in the room: react then, no need to poll. A stuck step pauses the plan; send a new plan or clear_plan.',
      'Fights, eating and escaping water/lava still happen by reflex; a step interrupted by them resumes by itself. A "stop" from the player pauses the plan.'
    ].join('\n'),
    inputSchema: {
      goal: z.string().min(1).max(200).describe('What the plan is for, in a few words (e.g. "20 logs for steve"). Shown back in events.'),
      steps: z.array(PlanStepSchema).min(1, 'a plan needs at least one step').max(20, 'at most 20 steps').describe('Steps, done in order.')
    }
  }, async (args) => run('set_plan', args, () => {
    if (!d.cerebellum) throw new ActionError('plans are off on this body (no cerebellum: JEV_API unset); use the single tools like mine_block instead')
    const errors = checkGatherBlocks(args.steps, d.blockNames, blockPattern)
    args.steps.forEach((st, i) => {
      const err = st.kind === 'craft' ? checkCraftItem(st.item, d.items) : st.kind === 'smelt' ? checkSmeltItem(st.item) : null
      if (err) errors.push(`steps.${i}.item: ${err}`)
    })
    if (errors.length) throw new ActionError(errors.join('\n'))
    // Take over from an outside activity (a follow, go_to...), which the
    // cerebellum would otherwise leave alone, including a follow a running
    // reflex would resume afterwards.
    a.yieldToPlan()
    d.plans.set({ goal: args.goal, steps: args.steps })
    return { ok: true, note: a.slotReflex ? `starts after the reflex (${a.slotReflex}) ends` : 'started', plan: planSummary(d) }
  }))

  s.registerTool('get_plan', {
    description: 'The current plan: goal, status (active, paused, done), the step being worked on, measured progress (e.g. "gathered 3 of 10, 7 more needed"), why it paused, and all steps. Null when there is no plan.',
    inputSchema: {}
  }, async () => run('get_plan', {}, () => planSummary(d) ?? 'no plan'))

  s.registerTool('clear_plan', {
    description: 'Drop the current plan and stop working on it. The body goes idle (use follow_player afterwards if the player wants company).',
    inputSchema: {}
  }, async () => run('clear_plan', {}, () => {
    const had = d.plans.view()
    if (!had) return 'no plan to clear'
    d.plans.clear()
    return `cleared plan "${had.goal}" (was ${had.status})`
  }))

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

  s.registerTool('craft', {
    description: 'Craft items from your inventory. Makes missing intermediates itself (logs -> planks -> sticks -> wooden_pickaxe). 3x3 recipes use a crafting table within 16 blocks, or it crafts one from planks and places it next to you. Use Minecraft item ids (stick, crafting_table, wooden_pickaxe, stone_pickaxe, furnace, torch, chest); `*_planks` = planks of whatever wood you carry. On failure it says exactly what is missing. Ingots/charcoal/glass are smelted, not crafted: use smelt. Waits until done.',
    inputSchema: { item: z.string().min(1), count: z.number().int().min(1).max(64).default(1).describe('How many items to end up with MORE than now (e.g. 4 sticks).') }
  }, async (args) => run('craft', args, () => a.craft(args.item, args.count)))

  s.registerTool('smelt', {
    description: 'Smelt items in a furnace and take the results: raw_iron -> iron_ingot, raw_gold, raw_copper, *_log -> charcoal, sand -> glass, cobblestone -> stone, raw meat/fish -> cooked. `item` may be the input (raw_iron) or the output (iron_ingot). Uses a furnace within 16 blocks, or crafts one from 8 cobblestone and places it. Fuel comes from your inventory (coal, charcoal, planks, logs) unless you name one. Takes 10 s per item and waits until done (max 24 per call; for more use a plan smelt step).',
    inputSchema: {
      item: z.string().min(1),
      count: z.number().int().min(1).max(24).default(1),
      fuel: z.string().min(1).optional().describe('Fuel item id, e.g. coal or *_planks; omit to pick automatically.')
    }
  }, async (args) => run('smelt', args, () => a.smelt(args.item, args.count, args.fuel)))

  s.registerTool('place_block', {
    description: 'Place a block from your inventory (torch, crafting_table, furnace, cobblestone to plug a hole...). Give x y z for an exact spot (it walks into reach), or omit them for a free spot with solid ground right next to you.',
    inputSchema: { item: z.string().min(1), x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }
  }, async (args) => run('place_block', args, () => {
    const { x, y, z: zz } = args
    if ((x === undefined) !== (y === undefined) || (x === undefined) !== (zz === undefined)) throw new ActionError('give all of x, y, z, or none')
    return a.placeBlock(args.item, x !== undefined && y !== undefined && zz !== undefined ? { x, y, z: zz } : undefined)
  }))

  s.registerTool('look_at_player', {
    description: 'Turn to face a player.',
    inputSchema: { player }
  }, async (args) => run('look_at_player', args, () => a.lookAt(args.player)))

  s.registerTool('stop', {
    description: 'Stop whatever you are doing (following, walking, mining). Reflexes (fighting a mob that is attacking you, escaping water/lava) cannot be stopped; they end on their own in seconds.',
    inputSchema: {}
  }, async () => run('stop', {}, () => a.stop()))

  s.registerTool('equip', {
    description: 'Hold an inventory item in your hand (or off-hand), or wear it if it is armor. Use Minecraft ids, e.g. iron_axe, shield, diamond_helmet; `*` wildcards work (*_sword). You do NOT need this for fighting or armor: your reflexes already pick the best weapon in a fight and wear the best armor you carry.',
    inputSchema: { item: z.string().min(1), hand: z.enum(['hand', 'off-hand']).default('hand').describe('Ignored for armor') }
  }, async (args) => run('equip', args, () => a.equip(args.item, args.hand)))

  s.registerTool('eat', {
    description: 'Eat food from your inventory. Omit item to eat the best safe food. Refuses when not hungry, and skips harmful foods (rotten_flesh, spider_eye, poisonous_potato, pufferfish) unless you name them. You do NOT need this to survive: your reflexes already eat when hungry or hurt.',
    inputSchema: { item: z.string().min(1).optional() }
  }, async (args) => run('eat', args, () => a.eat(args.item)))

  s.registerTool('give', {
    description: 'Walk to a player and throw them items from your inventory (e.g. give steve 3 oak_log). Waits until done.',
    inputSchema: { item: z.string().min(1), count: z.number().int().min(1).max(2304).default(1), player }
  }, async (args) => run('give', args, () => a.give(args.item, args.count, args.player)))

  s.registerTool('drop', {
    description: 'Throw items from your inventory on the ground in front of you.',
    inputSchema: { item: z.string().min(1), count: z.number().int().min(1).max(2304).default(1) }
  }, async (args) => run('drop', args, () => a.drop(args.item, args.count)))

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
export function startMcpServer (deps: McpDeps, port: number, token: string): http.Server {
  const { actions } = deps
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
      const mcp = buildServer(deps)
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
