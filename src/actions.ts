import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { Body } from './body.js'
import { log } from './log.js'

const { goals, Movements } = pathfinderPkg

/** Thrown for problems the caller (Hermes) should read and react to. */
export class ActionError extends Error {}

export interface WorldStateSnapshot {
  connected: boolean
  alive: boolean
  position: { x: number, y: number, z: number } | null
  dimension: string | null
  health: number | null
  food: number | null
  timeOfDay: number | null
  isDay: boolean | null
  activity: string
  heldItem: string | null
  inventory: Record<string, number>
  players: Array<{ name: string, distance: number | null }>
  nearestHostile: { name: string, distance: number } | null
}

/**
 * The bot's verbs, shared by every caller (MCP tools now, the cerebellum
 * later). Movement verbs take one "activity slot": starting one cancels the
 * previous one, and `stop()` cancels whatever is running.
 */
export class Actions {
  activity = 'idle'
  private generation = 0

  constructor (private readonly body: Body, private readonly defaultPlayer: string) {
    body.on('spawn', (bot) => {
      const moves = new Movements(bot)
      moves.allowParkour = true
      moves.allowSprinting = true
      bot.pathfinder.setMovements(moves)
      this.activity = 'idle'
    })
  }

  private bot (): Bot {
    const bot = this.body.bot
    if (!bot?.entity) throw new ActionError('bot is not in the world right now (reconnecting?)')
    return bot
  }

  /** Cancel the running activity and claim the slot for a new one. */
  private begin (activity: string): number {
    const bot = this.bot()
    bot.pathfinder.stop()
    bot.pathfinder.setGoal(null)
    if (bot.targetDigBlock) bot.stopDigging()
    this.activity = activity
    return ++this.generation
  }

  private stillCurrent (gen: number): boolean {
    return gen === this.generation
  }

  private finish (gen: number): void {
    if (this.stillCurrent(gen)) this.activity = 'idle'
  }

  private player (name?: string): Entity {
    const bot = this.bot()
    if (name) {
      const p = bot.players[name]
      if (!p) throw new ActionError(`player ${name} is not online`)
      if (!p.entity) throw new ActionError(`player ${name} is online but out of sight range; ask for coordinates and use go_to`)
      return p.entity
    }
    // Default: the configured player, else the nearest other player.
    const preferred = bot.players[this.defaultPlayer]?.entity
    if (preferred) return preferred
    const others = Object.values(bot.players)
      .filter((p) => p.username !== bot.username && p.entity)
      .map((p) => p.entity)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    if (!others[0]) throw new ActionError('no other player in sight')
    return others[0]
  }

  /** pathfinder.goto with a deadline; rejects if the slot was taken over. */
  private async goto (gen: number, goal: InstanceType<typeof goals.Goal>, timeoutMs: number): Promise<void> {
    const bot = this.bot()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { bot.pathfinder.stop(); reject(new ActionError(`gave up after ${timeoutMs / 1000}s`)) }, timeoutMs)
        })
      ])
    } catch (e) {
      if (!this.stillCurrent(gen)) throw new ActionError('interrupted by a newer command')
      throw e instanceof ActionError ? e : new ActionError(`path failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  state (): WorldStateSnapshot {
    const bot = this.body.bot
    if (!bot?.entity) {
      return { connected: false, alive: false, position: null, dimension: null, health: null, food: null, timeOfDay: null, isDay: null, activity: this.activity, heldItem: null, inventory: {}, players: [], nearestHostile: null }
    }
    const me = bot.entity.position
    const inventory: Record<string, number> = {}
    for (const it of bot.inventory.items()) inventory[it.name] = (inventory[it.name] ?? 0) + it.count
    let nearestHostile: WorldStateSnapshot['nearestHostile'] = null
    for (const e of Object.values(bot.entities)) {
      if (e.type !== 'hostile') continue
      const d = e.position.distanceTo(me)
      if (d <= 24 && (!nearestHostile || d < nearestHostile.distance)) nearestHostile = { name: e.name ?? 'unknown', distance: round(d) }
    }
    return {
      connected: true,
      alive: bot.health > 0,
      position: { x: round(me.x), y: round(me.y), z: round(me.z) },
      dimension: bot.game.dimension,
      health: bot.health,
      food: bot.food,
      timeOfDay: bot.time.timeOfDay,
      isDay: bot.time.isDay,
      activity: this.activity,
      heldItem: bot.heldItem?.name ?? null,
      inventory,
      players: Object.values(bot.players)
        .filter((p) => p.username !== bot.username)
        .map((p) => ({ name: p.username, distance: p.entity ? round(p.entity.position.distanceTo(me)) : null })),
      nearestHostile
    }
  }

  say (text: string): string {
    this.bot()
    this.body.say(text)
    return 'said'
  }

  stop (): string {
    this.begin('idle')
    return 'stopped'
  }

  async comeTo (playerName: string | undefined, range: number): Promise<string> {
    const target = this.player(playerName)
    const gen = this.begin(`coming to ${target.username ?? 'player'}`)
    try {
      const p = target.position
      await this.goto(gen, new goals.GoalNear(p.x, p.y, p.z, range), 60_000)
      return `arrived, ${round(this.bot().entity.position.distanceTo(target.position))} blocks from ${target.username}`
    } finally { this.finish(gen) }
  }

  follow (playerName: string | undefined, distance: number): string {
    const target = this.player(playerName)
    this.begin(`following ${target.username ?? 'player'}`)
    this.bot().pathfinder.setGoal(new goals.GoalFollow(target, distance), true)
    return `following ${target.username} at ${distance} blocks until told to stop`
  }

  async goTo (x: number, y: number | undefined, z: number, range: number): Promise<string> {
    const gen = this.begin(`going to ${x} ${y ?? '~'} ${z}`)
    try {
      const goal = y === undefined ? new goals.GoalNearXZ(x, z, range) : new goals.GoalNear(x, y, z, range)
      await this.goto(gen, goal, 120_000)
      const p = this.bot().entity.position
      return `arrived at ${round(p.x)} ${round(p.y)} ${round(p.z)}`
    } finally { this.finish(gen) }
  }

  lookAt (playerName: string | undefined): string {
    const target = this.player(playerName)
    void this.bot().lookAt(target.position.offset(0, target.height, 0), true)
    return `looking at ${target.username}`
  }

  /** Find, walk to, dig and pick up `count` blocks of a type (e.g. oak_log). */
  async mineBlock (blockName: string, count: number, maxDistance: number): Promise<string> {
    const bot = this.bot()
    // "*_log" = any log: lets "chop a tree" work in any biome.
    const pattern = new RegExp('^' + blockName.split('*').map(escapeRe).join('[a-z_]*') + '$')
    const ids = Object.values(bot.registry.blocksByName).filter((b) => pattern.test(b.name)).map((b) => b.id)
    if (ids.length === 0) throw new ActionError(`unknown block "${blockName}"; use Minecraft ids like oak_log, stone, iron_ore, or a wildcard like *_log`)
    const isTarget = (name: string): boolean => pattern.test(name)
    const have = (): number => bot.inventory.items().filter((i) => isTarget(i.name)).reduce((n, i) => n + i.count, 0)
    const before = have()
    const gen = this.begin(`mining ${count} ${blockName}`)
    let dug = 0
    try {
      while (dug < count) {
        if (!this.stillCurrent(gen)) throw new ActionError('interrupted by a newer command')
        const block = bot.findBlock({ matching: ids, maxDistance })
        if (!block) break
        await this.goto(gen, new goals.GoalLookAtBlock(block.position, bot.world), 60_000)
        if (!this.stillCurrent(gen)) throw new ActionError('interrupted by a newer command')
        const fresh = bot.blockAt(block.position)
        if (!fresh || !ids.includes(fresh.type)) continue
        if (!bot.canDigBlock(fresh)) throw new ActionError(`can't dig the ${blockName} at ${fresh.position.toString()} from here`)
        await bot.dig(fresh, true)
        dug++
        await this.collectDrops(gen, fresh.position)
      }
    } finally { this.finish(gen) }
    const gained = have() - before
    const summary = `dug ${dug}/${count} ${blockName}, inventory +${gained} (now ${have()})`
    if (dug < count) throw new ActionError(`${summary}; no more ${blockName} within ${maxDistance} blocks`)
    return summary
  }

  /** Walk over item drops near `pos` so they get picked up. */
  private async collectDrops (gen: number, pos: { x: number, y: number, z: number }): Promise<void> {
    const bot = this.bot()
    await sleep(400)
    const near = (e: Entity): boolean => e.name === 'item' && e.position.distanceTo(bot.entity.position.clone().set(pos.x, pos.y, pos.z)) < 6
    for (const drop of Object.values(bot.entities).filter(near)) {
      if (!this.stillCurrent(gen) || !bot.entities[drop.id]) continue
      try {
        await this.goto(gen, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), 8_000)
      } catch { /* drop despawned, fell, or unreachable: fine */ }
    }
    await sleep(250)
  }

  respawn (): string {
    const bot = this.body.bot
    if (!bot) throw new ActionError('not connected')
    if (bot.health > 0 && bot.entity) return 'already alive'
    bot.respawn()
    log('mc.respawn_requested')
    return 'respawn requested'
  }
}

function escapeRe (s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function round (n: number): number {
  return Math.round(n * 10) / 10
}

function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
