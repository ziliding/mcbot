import fs from 'node:fs'
import path from 'node:path'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { Body } from './body.js'
import { log } from './log.js'

const { goals } = pathfinderPkg

/**
 * Transitional: the old data/cmds.jsonl command queue and data/state.json
 * snapshot, kept so existing Hermes habits keep working until the MCP server
 * (M2) replaces them. Delete this module in M2.
 */
export function startLegacyQueue (body: Body, dataDir: string, defaultPlayer: string): void {
  const cmds = path.join(dataDir, 'cmds.jsonl')
  const state = path.join(dataDir, 'state.json')
  let offset = fileSize(cmds)
  body.on('spawn', () => { offset = fileSize(cmds) })

  setInterval(() => {
    const bot = body.bot
    const p = bot?.entity?.position
    try {
      fs.writeFileSync(state, JSON.stringify({
        at: Date.now(),
        connected: body.ready,
        pos: p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null,
        players: bot ? Object.keys(bot.players) : [],
        health: bot?.health ?? null,
        food: bot?.food ?? null
      }))
    } catch {}
  }, 1000)

  let busy = false
  setInterval(() => {
    if (busy || !body.ready) return
    // Offsets are in bytes (they start from fs.stat size); never mix with string length.
    let buf: Buffer
    try { buf = fs.readFileSync(cmds) } catch { return }
    if (offset > buf.length) offset = 0
    const fresh = buf.subarray(offset).toString('utf8')
    offset = buf.length
    if (!fresh.trim()) return
    busy = true
    void (async () => {
      for (const line of fresh.split('\n').map((l) => l.trim()).filter(Boolean)) {
        try {
          await handle(body, JSON.parse(line) as Cmd, defaultPlayer)
          log('legacy.cmd_ok', { line })
        } catch (e) {
          log('legacy.cmd_err', { line, message: e instanceof Error ? e.message : String(e) })
        }
      }
    })().finally(() => { busy = false })
  }, 400)
}

interface Cmd { cmd: string, text?: string, name?: string }

async function handle (body: Body, c: Cmd, defaultPlayer: string): Promise<void> {
  const bot = body.bot
  if (!bot?.entity) throw new Error('not spawned')
  const target = bot.players[c.name ?? defaultPlayer]?.entity
  switch (c.cmd) {
    case 'say': body.say(c.text ?? ''); return
    case 'look': if (target) await bot.lookAt(target.position.offset(0, 1.6, 0), true); return
    case 'come': if (target) bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), false); return
    case 'follow': if (target) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true); return
    case 'stop': bot.pathfinder.setGoal(null); return
    default: throw new Error('unknown cmd')
  }
}

function fileSize (f: string): number {
  try { return fs.statSync(f).size } catch { return 0 }
}
