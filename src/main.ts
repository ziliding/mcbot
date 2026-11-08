import { Actions } from './actions.js'
import { Body } from './body.js'
import minecraftData from 'minecraft-data'
import { Cerebellum } from './cerebellum.js'
import { itemCatalog } from './crafting.js'
import { loadConfig } from './config.js'
import { EventReporter } from './events.js'
import { Jev } from './jev.js'
import { log } from './log.js'
import { Lookout } from './lookout.js'
import { MatrixBridge } from './matrix.js'
import { startMcpServer } from './mcp.js'
import { PRESET_PLANS, PlanStore, describeStep, parsePlan } from './plan.js'
import { Reflexes } from './reflexes.js'
import { Triage, type LocalCommand } from './triage.js'

const cfg = loadConfig()
const body = new Body(cfg.mc)
const actions = new Actions(body, cfg.defaultPlayer)
// Self-preservation (fight, eat, escape, armor): pure code, every tick, no LLM.
new Reflexes(body, actions)

let matrix: MatrixBridge | null = null
if (cfg.matrix) {
  // Matrix -> game: whatever Hermes says in the room is spoken in game chat.
  matrix = new MatrixBridge(cfg.matrix, (msg) => {
    log('bridge.matrix_to_game', { sender: msg.sender, chars: msg.body.length })
    body.say(msg.body)
  })
  void matrix.start()
} else {
  log('matrix.disabled', { reason: 'MATRIX_ACCESS_TOKEN or MATRIX_ROOM not set' })
}

// Cerebellum (M4): Jev-driven behavior loop over a typed plan, and chat triage.
const plans = new PlanStore()
const jev = cfg.jev ? new Jev(cfg.jev) : null
if (!jev) log('jev.disabled', { reason: 'JEV_API not set: no cerebellum, no chat triage' })
const cerebellum = jev && cfg.cerebellum.enabled
  ? new Cerebellum(body, actions, plans, jev, cfg.cerebellum, cfg.mc.username, cfg.defaultPlayer)
  : null

// Escalations (M5): `[EVENT] …` lines from @mcbot wake Hermes, which is never
// polled. The bridge ignores its own messages, so these never loop back into
// game chat; Hermes's replies are spoken in game as usual.
const round = (n: number): number => Math.round(n)
function eventContext (): string {
  const st = actions.state()
  if (!st.connected || !st.position) return 'body not in the world (reconnecting)'
  const parts = [
    `pos ${round(st.position.x)} ${round(st.position.y)} ${round(st.position.z)}${st.dimension && !st.dimension.endsWith('overworld') ? ` (${st.dimension})` : ''}`,
    `hp ${round(st.health ?? 0)}/20 food ${st.food ?? 0}/20`,
    `doing: ${st.reflex ?? st.activity}`
  ]
  const v = plans.view()
  if (v && v.status !== 'done') parts.push(`plan "${v.goal}" ${v.status}${v.current ? ` at step ${v.stepIndex + 1}/${v.steps.length} (${describeStep(v.current)})` : ''}`)
  const players = st.players.map((p) => `${p.name} ${p.distance === null ? 'out of sight' : `${round(p.distance)}m`}`)
  parts.push(players.length ? `players: ${players.join(', ')}` : 'no players online')
  if (st.nearestHostile) parts.push(`hostile: ${st.nearestHostile.name} ${round(st.nearestHostile.distance)}m`)
  const inv = Object.entries(st.inventory).sort((a, b) => b[1] - a[1])
  parts.push(inv.length ? `carrying ${inv.slice(0, 6).map(([k, n]) => `${k} x${n}`).join(', ')}${inv.length > 6 ? ` +${inv.length - 6} more kinds` : ''}` : 'carrying nothing')
  return parts.join(' | ')
}
const events = new EventReporter(cfg.events, async (text) => { await matrix?.send(text) }, eventContext)

cerebellum?.onEvent((e) => {
  const v = plans.view()
  const where = v ? ` Plan "${v.goal}" ${v.status} at step ${v.stepIndex + 1}/${v.steps.length}${v.reason && e.type !== 'step_infeasible' && e.type !== 'step_failed' ? ` (${v.reason})` : ''}.` : ''
  switch (e.type) {
    case 'plan_done':
      events.report('plan_done', `finished "${v?.goal ?? e.plan ?? 'plan'}" (${v?.steps.map(describeStep).join(', then ') ?? ''}).`)
      break
    case 'step_infeasible':
    case 'step_failed':
      events.report(e.type, `${e.message}.${where}`)
      break
    case 'low_confidence':
      events.report('low_confidence', `${e.message} on "${e.step ?? 'no step'}" (${cerebellum.progressText() ?? 'no progress info'}).${where}`)
      break
  }
})

// Death: the server's death message names the cause; it arrives around the
// death packet, so wait a moment and use the latest one about us.
body.on('spawn', (bot) => {
  let lastSelfMsg: { text: string, at: number } | null = null
  bot.on('messagestr', (message: string, position: string) => {
    if (position !== 'chat' && message.startsWith(`${bot.username} `)) lastSelfMsg = { text: message, at: Date.now() }
  })
  bot.on('death', () => {
    const p = bot.entity?.position
    const at = p ? `${round(p.x)} ${round(p.y)} ${round(p.z)}` : 'unknown position'
    const v = plans.view()
    setTimeout(() => {
      const cause = lastSelfMsg && Date.now() - lastSelfMsg.at < 5000 ? lastSelfMsg.text : 'cause unknown'
      const plan = v && v.status === 'active' ? ` The plan continues after respawn ("${v.goal}", step ${v.stepIndex + 1}/${v.steps.length}).` : ''
      events.report('died', `${cause}, at ${at}. Whatever it carried and no longer has (see "carrying") lies there for ~5 min. Respawned at spawn.${plan}`)
    }, 1500)
  })
})

// Notable finds: rare ores with an open face near the body.
const lookout = new Lookout(body, cfg.lookout, (f) => {
  events.report('notable_find', `${f.count > 1 ? `${f.count}× ` : ''}${f.block} nearby at ${f.at.x} ${f.at.y} ${f.at.z} (${f.distance} blocks away, visible from the open).`)
})
if (cfg.matrix && cfg.events.enabled) lookout.start()
const triage = jev && cfg.triage.enabled ? new Triage(jev, cfg.triage, cfg.mc.username) : null
if (cerebellum) {
  let planLoaded = false
  body.on('spawn', () => {
    // A hand-written test plan from the env, once per process.
    if (planLoaded || !cfg.cerebellum.plan) return
    planLoaded = true
    try { plans.set(parsePlan(cfg.cerebellum.plan)) } catch (e) { log('plan.invalid', { error: String(e) }) }
  })
  cerebellum.start()
}

const ACK: Record<LocalCommand, string> = { follow: 'ok, following you', come: 'coming', stop: 'ok, stopping', wait: 'ok, waiting here' }
/** Lines handled locally since the last forward: prepended so Hermes keeps the context without being woken. */
let handledLocally: string[] = []

async function runLocal (player: string, command: LocalCommand): Promise<string> {
  switch (command) {
    case 'follow': return actions.follow(player, 3)
    case 'stop':
    case 'wait': return actions.stop()
    case 'come': {
      // Fail before acknowledging when it obviously can't work (busy, out of
      // sight): the caller then forwards the line to Hermes.
      if (actions.slotReflex) throw new Error(`busy: ${actions.slotReflex}`)
      if (!body.bot?.players[player]?.entity) throw new Error(`${player} is out of sight`)
      // The walk itself can take a while: ack now, report a late failure in chat.
      actions.comeTo(player, 2).catch((e: unknown) => {
        log('triage.local_failed', { player, command, error: String(e) })
        body.say(`can't reach you: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200))
      })
      return 'coming'
    }
  }
}

/** `!plan <preset|json>`, `!plan pause|resume|clear|show`: test plans from game chat. */
function planCommand (text: string): void {
  const arg = text.replace(/^!plan\s*/, '').trim()
  if (!cerebellum) { body.say('cerebellum is off (no JEV_API)'); return }
  try {
    if (arg === 'clear') plans.clear()
    else if (arg === 'pause') plans.pause('paused from chat')
    else if (arg === 'resume') plans.resume()
    else if (arg === '' || arg === 'show') {
      const v = plans.view()
      body.say(v ? `plan: ${v.goal} [${v.status}] step ${v.stepIndex + 1}/${v.steps.length}${v.reason ? ` (${v.reason})` : ''}` : `no plan. presets: ${Object.keys(PRESET_PLANS).join(', ')}`)
      return
    } else plans.set(parsePlan(arg))
    body.say(`plan ${arg}: ok`)
  } catch (e) {
    body.say(`plan error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200))
  }
}

async function onGameChat (player: string, text: string): Promise<void> {
  if (/^!plan\b/.test(text)) { log('plan.chat_command', { player, text }); planCommand(text); return }
  if (triage) {
    const others = Object.keys(body.bot?.players ?? {}).filter((n) => n !== cfg.mc.username)
    const t = await triage.classify(player, text, others)
    if (t.route === 'local' && t.command) {
      try {
        const out = await runLocal(player, t.command)
        body.say(ACK[t.command])
        log('triage.local', { player, command: t.command, result: out })
        handledLocally.push(`[MC] (handled locally) ${player}: ${text} → ${out}`)
        handledLocally = handledLocally.slice(-5)
        return
      } catch (e) {
        // Couldn't do it (busy, player out of sight...): fail open to Hermes.
        log('triage.local_failed', { player, command: t.command, error: String(e) })
      }
    }
  }
  log('bridge.game_to_matrix', { player, chars: text.length })
  const prefix = handledLocally.length ? handledLocally.join('\n') + '\n' : ''
  handledLocally = []
  await matrix?.send(`${prefix}[MC] ${player}: ${text}`)
}

// Game -> Matrix: other players' chat lines, prefixed so Hermes knows the source.
// One line at a time so triage latency never reorders them.
let chatQueue: Promise<void> = Promise.resolve()
body.on('playerChat', ({ player, text }) => {
  chatQueue = chatQueue.then(() => onGameChat(player, text)).catch((e: unknown) => log('bridge.error', { message: String(e) }))
})

// MCP tools for Hermes: same process, same bot.
const mcData = minecraftData(cfg.mc.version)
const blockNames = Object.keys(mcData.blocksByName)
const items = itemCatalog({ itemsArray: mcData.itemsArray, recipes: mcData.recipes as Record<string, unknown> })
const mcp = cfg.mcp ? startMcpServer({ actions, plans, cerebellum, blockNames, items }, cfg.mcp.port, cfg.mcp.token) : null
if (!cfg.mcp) log('mcp.disabled', { reason: 'MCP_TOKEN not set' })
body.start()

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('shutdown', { sig })
    cerebellum?.stop()
    lookout.stop()
    jev?.close()
    matrix?.stop()
    mcp?.close()
    body.stop()
    setTimeout(() => process.exit(0), 500)
  })
}
