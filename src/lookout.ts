import type { Bot } from 'mineflayer'
import type { Body } from './body.js'
import { log } from './log.js'

export interface LookoutConfig {
  /** Block ids worth telling the brain about (rare ores). Empty = off. */
  blocks: string[]
  radius: number
  everyMs: number
}

/** Blocks that let you see a face of the ore: an ore sealed in stone isn't "spotted". */
const SEE_THROUGH = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'glow_lichen', 'short_grass', 'tall_grass', 'snow', 'torch', 'wall_torch'])

export interface Find { block: string, count: number, at: { x: number, y: number, z: number }, distance: number }

/**
 * Periodically looks for rare ores near the body (diamonds, emeralds, ancient
 * debris) with at least one face open to air or water, i.e. something a player
 * standing there could actually see. Each find is reported once: blocks
 * within 8 of an already reported one are part of the same vein.
 */
export class Lookout {
  private timer: NodeJS.Timeout | null = null
  private readonly reported: Array<{ x: number, y: number, z: number }> = []

  constructor (private readonly body: Body, private readonly cfg: LookoutConfig, private readonly onFind: (f: Find) => void) {}

  start (): void {
    if (this.timer || this.cfg.blocks.length === 0) return
    this.timer = setInterval(() => {
      try { this.scan() } catch (e) { log('lookout.error', { message: String(e) }) }
    }, this.cfg.everyMs)
  }

  stop (): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private scan (): void {
    const bot = this.body.bot
    if (!bot?.entity || bot.health <= 0) return
    const ids = this.cfg.blocks.map((n) => bot.registry.blocksByName[n]?.id).filter((id): id is number => id !== undefined)
    if (ids.length === 0) return
    const me = bot.entity.position
    const found = bot.findBlocks({ matching: ids, maxDistance: this.cfg.radius, count: 64 })
      .filter((p) => !this.reported.some((r) => Math.abs(r.x - p.x) <= 8 && Math.abs(r.y - p.y) <= 8 && Math.abs(r.z - p.z) <= 8))
      .filter((p) => exposed(bot, p))
    // Group into veins: by block name, around the first block of each.
    const veins: Find[] = []
    for (const p of found) {
      const name = bot.blockAt(p)?.name ?? 'unknown'
      const v = veins.find((f) => f.block === name && Math.abs(f.at.x - p.x) <= 8 && Math.abs(f.at.y - p.y) <= 8 && Math.abs(f.at.z - p.z) <= 8)
      if (v) { v.count++; continue }
      veins.push({ block: name, count: 1, at: { x: p.x, y: p.y, z: p.z }, distance: Math.round(p.distanceTo(me)) })
    }
    for (const v of veins) {
      this.reported.push(v.at)
      if (this.reported.length > 500) this.reported.shift()
      log('lookout.find', { ...v })
      this.onFind(v)
    }
  }
}

function exposed (bot: Bot, pos: Parameters<Bot['blockAt']>[0]): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && SEE_THROUGH.has(b.name)) return true
  }
  return false
}
