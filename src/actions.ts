import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { Body } from './body.js'
import { BAD_FOODS, armorSlot, armorUpgrades, bestFood, bestWeapon, findItems, ownOxygen, wornArmor } from './items.js'
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
  /** Reflex currently running (fighting, escaping, eating), or null. */
  reflex: string | null
  heldItem: string | null
  offHand: string | null
  armor: string[]
  /** Air supply 0-20; below 20 means underwater. */
  oxygen: number | null
  inventory: Record<string, number>
  players: Array<{ name: string, distance: number | null }>
  nearestHostile: { name: string, distance: number } | null
}

/** Items that can be consumed at full hunger. */
const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'milk_bucket', 'potion'])

/**
 * The bot's verbs, shared by every caller (MCP tools, the reflexes, later the
 * cerebellum). Movement verbs take one "activity slot": starting one cancels
 * the previous one, and `stop()` cancels whatever is running.
 *
 * Reflexes (src/reflexes.ts) take the slot with `preempt()` and give it back
 * with `release()`. While a reflex holds it, movement verbs refuse with a
 * "busy" error instead of fighting the reflex for the slot; a follow that was
 * interrupted is resumed afterwards.
 *
 * Anything that changes the held item or uses it (equip, eat, toss) goes
 * through `withHands()`, one at a time: swapping the hotbar mid-meal would
 * silently cancel the meal.
 */
export class Actions {
  activity = 'idle'
  /** Reflex holding the activity slot (e.g. "fighting zombie"), or null. */
  slotReflex: string | null = null
  /** Reflex running without the slot (e.g. eating while following), or null. */
  sideReflex: string | null = null
  private generation = 0
  private interruptedBy = ''
  private following: { name: string, distance: number } | null = null
  private resumeFollow: { name: string, distance: number } | null = null
  private hands: Promise<unknown> = Promise.resolve()
  private handsQueued = 0

  constructor (private readonly body: Body, private readonly defaultPlayer: string) {
    body.on('spawn', (bot) => {
      const moves = new Movements(bot)
      moves.allowParkour = true
      moves.allowSprinting = true
      bot.pathfinder.setMovements(moves)
      // New bot after a reconnect: whatever held the slot (even a reflex) is gone.
      this.activity = 'idle'
      this.slotReflex = null
      this.sideReflex = null
      this.following = null
      this.resumeFollow = null
      this.generation++
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
    // setGoal(null) cancels immediately. Never use pathfinder.stop() here: it only
    // sets a flag that lingers and kills the *next* goto ("Path was stopped").
    bot.pathfinder.setGoal(null)
    if (bot.targetDigBlock) bot.stopDigging()
    this.activity = activity
    this.interruptedBy = activity
    this.following = null
    return ++this.generation
  }

  /** begin() for commands from outside: refused while a reflex holds the slot. */
  private claim (activity: string): number {
    if (this.slotReflex) throw new ActionError(`busy: ${this.slotReflex} (automatic reflex); try again in a few seconds`)
    return this.begin(activity)
  }

  stillCurrent (gen: number): boolean {
    return gen === this.generation
  }

  private interrupted (): ActionError {
    return new ActionError(`interrupted by ${this.interruptedBy || 'a newer command'}`)
  }

  /** A reflex takes the activity slot. Remembers a follow so it can resume. */
  preempt (reflex: string): number {
    if (!this.slotReflex) this.resumeFollow = this.following
    const gen = this.begin(reflex)
    this.slotReflex = reflex
    return gen
  }

  /** A reflex gives the slot back: resume an interrupted follow, else go idle. */
  release (gen: number): void {
    if (!this.stillCurrent(gen)) return
    this.slotReflex = null
    const bot = this.body.bot
    if (!bot?.entity) { this.activity = 'idle'; return }
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    const resume = this.resumeFollow
    this.resumeFollow = null
    const target = resume ? bot.players[resume.name]?.entity : undefined
    if (resume && target && bot.health > 0) {
      this.begin(`following ${resume.name}`)
      this.following = resume
      bot.pathfinder.setGoal(new goals.GoalFollow(target, resume.distance), true)
      log('reflex.resume', { activity: this.activity })
    } else {
      this.activity = 'idle'
    }
  }

  get handsBusy (): boolean {
    return this.handsQueued > 0
  }

  /** Run something that uses the held item, after any earlier one finishes. */
  withHands<T> (what: string, fn: () => Promise<T>): Promise<T> {
    this.handsQueued++
    const run = this.hands.then(() => withTimeout(fn(), 10_000, `${what} took too long`))
    const done = run.then(() => undefined, () => undefined).finally(() => { this.handsQueued-- })
    this.hands = done
    return run
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
  async goto (gen: number, goal: InstanceType<typeof goals.Goal>, timeoutMs: number): Promise<void> {
    const bot = this.bot()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new ActionError(`gave up after ${timeoutMs / 1000}s`)); bot.pathfinder.setGoal(null) }, timeoutMs)
        })
      ])
    } catch (e) {
      if (!this.stillCurrent(gen)) throw this.interrupted()
      throw e instanceof ActionError ? e : new ActionError(`path failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  state (): WorldStateSnapshot {
    const bot = this.body.bot
    if (!bot?.entity) {
      return { connected: false, alive: false, position: null, dimension: null, health: null, food: null, timeOfDay: null, isDay: null, activity: this.activity, reflex: null, heldItem: null, offHand: null, armor: [], oxygen: null, inventory: {}, players: [], nearestHostile: null }
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
      reflex: this.slotReflex ?? this.sideReflex,
      heldItem: bot.heldItem?.name ?? null,
      offHand: bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name ?? null,
      armor: wornArmor(bot),
      oxygen: ownOxygen(bot),
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
    if (this.slotReflex) {
      this.resumeFollow = null
      return `${this.slotReflex} (automatic reflex, can't be stopped); will stay put afterwards instead of resuming`
    }
    this.begin('idle')
    return 'stopped'
  }

  async comeTo (playerName: string | undefined, range: number): Promise<string> {
    const target = this.player(playerName)
    const gen = this.claim(`coming to ${target.username ?? 'player'}`)
    try {
      // The player may keep moving: re-aim at their current position until close.
      const deadline = Date.now() + 60_000
      const dist = (): number => this.bot().entity.position.distanceTo(target.position)
      while (dist() > range + 1) {
        const left = deadline - Date.now()
        if (left <= 0) throw new ActionError(`still ${round(dist())} blocks from ${target.username} after 60s; they may be moving away. Try follow_player`)
        const p = target.position
        await this.goto(gen, new goals.GoalNear(p.x, p.y, p.z, range), Math.min(left, 30_000))
        if (!this.bot().players[target.username ?? '']?.entity) throw new ActionError(`lost sight of ${target.username}`)
      }
      return `arrived, ${round(dist())} blocks from ${target.username}`
    } finally { this.finish(gen) }
  }

  follow (playerName: string | undefined, distance: number): string {
    const target = this.player(playerName)
    this.claim(`following ${target.username ?? 'player'}`)
    this.following = { name: target.username ?? '', distance }
    this.bot().pathfinder.setGoal(new goals.GoalFollow(target, distance), true)
    return `following ${target.username} at ${distance} blocks until told to stop`
  }

  async goTo (x: number, y: number | undefined, z: number, range: number): Promise<string> {
    const gen = this.claim(`going to ${x} ${y ?? '~'} ${z}`)
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
    const gen = this.claim(`mining ${count} ${blockName}`)
    let dug = 0
    try {
      while (dug < count) {
        if (!this.stillCurrent(gen)) throw this.interrupted()
        const block = bot.findBlock({ matching: ids, maxDistance })
        if (!block) break
        await this.goto(gen, new goals.GoalLookAtBlock(block.position, bot.world), 60_000)
        if (!this.stillCurrent(gen)) throw this.interrupted()
        const fresh = bot.blockAt(block.position)
        if (!fresh || !ids.includes(fresh.type)) continue
        if (!bot.canDigBlock(fresh)) throw new ActionError(`can't dig the ${blockName} at ${fresh.position.toString()} from here`)
        await this.withHands('equip tool', () => this.equipBestTool(fresh))
        try {
          await bot.dig(fresh, true)
        } catch (e) {
          // begin() aborts the dig when something (e.g. a reflex) takes the slot.
          if (!this.stillCurrent(gen)) throw this.interrupted()
          throw e
        }
        dug++
        await this.collectDrops(gen, fresh.position)
      }
    } finally { this.finish(gen) }
    const gained = have() - before
    const summary = `dug ${dug}/${count} ${blockName}, inventory +${gained} (now ${have()})`
    if (dug < count) throw new ActionError(`${summary}; no more ${blockName} within ${maxDistance} blocks`)
    return summary
  }

  /** Hold whichever inventory item digs this block fastest (e.g. an axe for logs). */
  private async equipBestTool (block: NonNullable<ReturnType<Bot['blockAt']>>): Promise<void> {
    const bot = this.bot()
    const effects = bot.entity.effects
    const time = (type: number | null): number => block.digTime(type, false, false, false, [], effects)
    let best = bot.heldItem
    let bestTime = time(best?.type ?? null)
    for (const item of bot.inventory.items()) {
      const t = time(item.type)
      if (t < bestTime) { best = item; bestTime = t }
    }
    if (best && best !== bot.heldItem) await bot.equip(best, 'hand')
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

  /** Hold an item in the hand, or wear it if it is armor. */
  async equip (itemName: string, destination?: 'hand' | 'off-hand'): Promise<string> {
    const bot = this.bot()
    return this.withHands('equip', async () => {
      const item = findItems(bot, itemName)[0]
      if (!item) throw new ActionError(`no ${itemName} in inventory; have: ${this.inventoryList()}`)
      const dest = armorSlot(item.name) ?? destination ?? 'hand'
      await bot.equip(item, dest)
      log('item.equip', { item: item.name, dest })
      return `equipped ${item.name} (${dest})`
    })
  }

  /** Put the best melee weapon in hand; returns its name, or null if none. */
  async equipBestWeapon (): Promise<string | null> {
    const bot = this.bot()
    return this.withHands('equip weapon', async () => {
      const w = bestWeapon(bot)
      if (w && bot.heldItem?.type !== w.type) await bot.equip(w, 'hand')
      return w?.name ?? null
    })
  }

  /** Wear any armor that beats what is worn; returns what was put on. */
  async equipBestArmor (): Promise<string[]> {
    const bot = this.bot()
    return this.withHands('equip armor', async () => {
      const put: string[] = []
      for (const { item, slot } of armorUpgrades(bot)) {
        await bot.equip(item, slot)
        put.push(item.name)
      }
      return put
    })
  }

  /** Eat a named food, or the best safe one in the inventory. */
  async eat (itemName?: string): Promise<string> {
    const bot = this.bot()
    return this.withHands('eat', async () => {
      const foods = bot.registry.foodsByName
      let food: Item | undefined
      if (itemName) {
        food = findItems(bot, itemName).find((i) => foods[i.name] != null || ALWAYS_EDIBLE.has(i.name))
        if (!food) throw new ActionError(`no edible ${itemName} in inventory; have: ${this.inventoryList()}`)
      } else {
        food = bestFood(bot, false) ?? undefined
        if (!food) {
          const bad = bot.inventory.items().filter((i) => BAD_FOODS.has(i.name)).map((i) => i.name)
          throw new ActionError(bad.length ? `no safe food, only ${bad.join(', ')} (harmful; name it explicitly to eat anyway)` : 'no food in inventory')
        }
      }
      if (bot.food >= 20 && !ALWAYS_EDIBLE.has(food.name)) throw new ActionError('not hungry (food is 20/20)')
      const before = bot.food
      const prev = bot.heldItem
      await bot.equip(food, 'hand')
      try {
        await bot.consume()
      } catch (e) {
        bot.deactivateItem()
        throw new ActionError(`eating ${food.name} failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        const again = prev && prev.type !== food.type ? bot.inventory.items().find((i) => i.type === prev.type) : undefined
        if (again) await bot.equip(again, 'hand').catch(() => {})
      }
      await sleep(400) // the food bar update arrives just after the eat confirmation
      const warn = BAD_FOODS.has(food.name) ? ' (that one is harmful: expect hunger/poison)' : ''
      log('item.eat', { item: food.name, food: bot.food })
      return `ate ${food.name}, food ${before} -> ${bot.food}${warn}`
    })
  }

  /** Throw items on the ground where the bot is looking. */
  async drop (itemName: string, count: number): Promise<string> {
    const bot = this.bot()
    return this.withHands('drop', () => this.toss(bot, itemName, count))
  }

  /** Walk to a player and throw them items. */
  async give (itemName: string, count: number, playerName: string | undefined): Promise<string> {
    const bot = this.bot()
    if (!findItems(bot, itemName)[0]) throw new ActionError(`no ${itemName} in inventory; have: ${this.inventoryList()}`)
    const target = this.player(playerName)
    await this.comeTo(target.username, 2)
    await bot.lookAt(target.position.offset(0, target.height, 0), true)
    const out = await this.withHands('give', () => this.toss(bot, itemName, count))
    return `${out} to ${target.username}`
  }

  private async toss (bot: Bot, itemName: string, count: number): Promise<string> {
    const first = findItems(bot, itemName)[0]
    if (!first) throw new ActionError(`no ${itemName} in inventory; have: ${this.inventoryList()}`)
    const have = bot.inventory.items().filter((i) => i.type === first.type).reduce((n, i) => n + i.count, 0)
    const n = Math.min(count, have)
    await bot.toss(first.type, null, n)
    log('item.toss', { item: first.name, count: n })
    return `threw ${n} ${first.name}${n < count ? ` (only had ${have})` : ''}`
  }

  private inventoryList (): string {
    const s = this.state().inventory
    const parts = Object.entries(s).map(([k, v]) => `${k} x${v}`)
    return parts.length ? parts.join(', ') : 'nothing'
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

function withTimeout<T> (p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ActionError(message)), ms) })
  ]).finally(() => clearTimeout(timer))
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
