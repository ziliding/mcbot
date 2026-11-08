import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { Body } from './body.js'
import type { Block } from 'prismarine-block'
import type { Furnace } from 'mineflayer'
import { SMELT_SECONDS, describeMissing, fuelRank, fuelUnits, resolveCraft, smeltSpec, wildcard, type CraftCall } from './crafting.js'
import { BAD_FOODS, armorSlot, armorUpgrades, bestFood, bestWeapon, countGathered, findItems, ownOxygen, wornArmor } from './items.js'
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
  private readonly stopListeners: Array<() => void> = []
  /** Furnace the last smelt used: an interrupted smelt's output waits there. */
  private lastFurnace: Bot['entity']['position'] | null = null

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
    // A furnace or crafting-table window left open would make the next
    // equip (a reflex grabbing its sword) click that window's slots.
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch { /* already closed */ } }
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

  /** Bumped whenever something claims the activity slot (read-only for observers). */
  get currentGeneration (): number {
    return this.generation
  }

  /** Called after every explicit stop (MCP tool, local chat command), not after cancel(). */
  onStop (fn: () => void): void {
    this.stopListeners.push(fn)
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
  withHands<T> (what: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    this.handsQueued++
    const run = this.hands.then(() => withTimeout(fn(), timeoutMs, `${what} took too long`))
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
      for (const fn of this.stopListeners) fn()
      return `${this.slotReflex} (automatic reflex, can't be stopped); will stay put afterwards instead of resuming`
    }
    this.begin('idle')
    for (const fn of this.stopListeners) fn()
    return 'stopped'
  }

  /**
   * Cancel the activity started under `gen` (the cerebellum dropping its own
   * work). No-op if anything else has claimed the slot since; never pre-empts
   * a reflex and does not notify stop listeners.
   */
  cancel (gen: number): boolean {
    if (!this.stillCurrent(gen) || this.slotReflex) return false
    this.begin('idle')
    return true
  }

  /**
   * Hand the slot to the cerebellum's plan (set_plan): cancel any outside
   * activity (follow, go_to...) and forget a follow a reflex would resume,
   * so the plan doesn't wait behind it forever. Never pre-empts a running
   * reflex and does not notify stop listeners (that would pause the plan).
   */
  yieldToPlan (): void {
    this.resumeFollow = null
    if (!this.slotReflex && this.activity !== 'idle') this.begin('idle')
  }

  /** Walk until at least `distance` blocks from `from` (e.g. away from a creeper). */
  async fleeFrom (from: { x: number, y: number, z: number }, label: string, distance: number): Promise<string> {
    const gen = this.claim(`fleeing ${label}`)
    try {
      const goal = new goals.GoalInvert(new goals.GoalNear(from.x, from.y, from.z, distance))
      await this.goto(gen, goal, 15_000)
      const d = this.bot().entity.position.distanceTo(this.bot().entity.position.clone().set(from.x, from.y, from.z))
      return `fled to ${round(d)} blocks from ${label}`
    } finally { this.finish(gen) }
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
    const pattern = blockPattern(blockName)
    const ids = Object.values(bot.registry.blocksByName).filter((b) => pattern.test(b.name)).map((b) => b.id)
    if (ids.length === 0) throw new ActionError(`unknown block "${blockName}"; use Minecraft ids like oak_log, stone, iron_ore, or a wildcard like *_log`)
    // Count the drops too: iron_ore yields raw_iron, stone yields cobblestone.
    const have = (): number => countGathered(this.state().inventory, blockName)
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
        // Stone and ores drop nothing without the right pickaxe: say so instead of digging forever.
        const tools = bot.registry.blocks[fresh.type]?.harvestTools
        if (tools && !bot.inventory.items().some((i) => tools[String(i.type)])) {
          const names = Object.keys(tools).map((id) => bot.registry.items[Number(id)]?.name).filter((n): n is string => !!n)
          const weakest = names.sort((a, b) => PICK_ORDER.indexOf(a.split('_')[0] ?? '') - PICK_ORDER.indexOf(b.split('_')[0] ?? ''))[0] ?? 'a pickaxe'
          throw new ActionError(`need a tool: ${fresh.name} drops nothing without ${weakest} or better; craft one first`)
        }
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

  // ---- making things: craft, smelt, place ----

  /**
   * Craft `count` more of `item` (`*` wildcard: *_planks picks a wood the
   * inventory can make). Missing intermediates are crafted first (logs ->
   * planks -> sticks), up to MAX_CRAFT_DEPTH deep. 3x3 recipes use a crafting
   * table within 16 blocks, or one crafted from planks and placed next to the
   * bot. Takes the activity slot; a reflex interrupts it.
   */
  async craft (item: string, count: number): Promise<string> {
    this.bot()
    const gen = this.claim(`crafting ${count} ${item}`)
    try { return await this.craftIn(gen, item, count) } finally { this.finish(gen) }
  }

  private async craftIn (gen: number, item: string, count: number): Promise<string> {
    const bot = this.bot()
    const inv = this.state().inventory
    const name = item.replace(/^minecraft:/, '').toLowerCase()
    const re = wildcard(name)
    const candidates = Object.keys(bot.registry.itemsByName).filter((n) => re.test(n))
    if (candidates.length === 0) throw new ActionError(`unknown item "${item}"; use Minecraft item ids like stick, crafting_table, wooden_pickaxe, or *_planks`)
    const smelted = smeltSpec(name)
    if (smelted && smelted.output === name) throw new ActionError(`can't craft ${name}: it is smelted (or mined), not crafted; use smelt with ${smelted.inputs.join(' / ')}`)

    let table = this.findTable(bot)
    const hasTableItem = (inv.crafting_table ?? 0) > 0
    let chosen: { item: string, calls: CraftCall[] } | null = null
    let leastMissing: Map<string, number> | null = null
    for (const c of candidates) {
      // 2x2 first; if that can't do it and there's no table around, plan a table too.
      let r = resolveCraft(bot, c, count, inv, !!table)
      if (!r.ok && !table) r = resolveCraft(bot, c, count, inv, true, !hasTableItem)
      if (r.ok) {
        if (!chosen || r.calls.length < chosen.calls.length) chosen = { item: c, calls: r.calls }
      } else if (!leastMissing || sum(r.missing) < sum(leastMissing)) leastMissing = r.missing
    }
    if (!chosen) {
      const what = leastMissing && leastMissing.size ? describeMissing(leastMissing, inv) : 'a recipe'
      throw new ActionError(`can't craft ${count} ${item}: need ${what}; have: ${this.inventoryList()}`)
    }

    const target = chosen.item
    const before = inv[target] ?? 0
    const notes: string[] = []
    for (const call of chosen.calls) {
      if (!this.stillCurrent(gen)) throw this.interrupted()
      let tableBlock: Block | undefined
      if (call.recipe.requiresTable) {
        if (!table) {
          table = await this.placeIn(gen, 'crafting_table')
          notes.push(`placed a crafting_table at ${fmtPos(table.position)}`)
        }
        await this.reach(gen, table)
        tableBlock = bot.blockAt(table.position) ?? undefined
        if (tableBlock?.name !== 'crafting_table') throw new ActionError(`the crafting table at ${fmtPos(table.position)} is gone`)
      }
      // On 26.1 the last click of a 2x2 craft is unconfirmed, so the next craft
      // can start from a wrong inventory model and hang. Sync before each
      // craft; on a failure, empty the grid, sync again and retry once.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.withHands(`craft ${call.item}`, async () => {
            await syncInventory(bot)
            await bot.craft(call.recipe, call.times, tableBlock)
            if (!tableBlock) await syncInventory(bot)
          }, 6_000 + 400 * call.times)
          break
        } catch (e) {
          await this.closeAnyWindow(bot)
          await this.withHands('clear crafting grid', () => clearCraftingGrid(bot)).catch(() => {})
          if (!this.stillCurrent(gen)) throw this.interrupted()
          log('item.craft_retry', { item: call.item, attempt, error: errText(e) })
          if (attempt >= 2) throw new ActionError(`crafting ${call.item} failed: ${errText(e)}`)
        }
      }
      log('item.craft', { item: call.item, times: call.times, made: call.made, table: !!tableBlock })
    }
    const now = this.state().inventory[target] ?? 0
    const made = new Map<string, number>()
    for (const c of chosen.calls.slice(0, -1)) made.set(c.item, (made.get(c.item) ?? 0) + c.made)
    const via = made.size ? ` (via ${[...made].map(([n, c]) => `${c} ${n}`).join(', ')})` : ''
    return `crafted ${now - before} ${target}${via}, now have ${now}` + (notes.length ? `; ${notes.join('; ')}` : '')
  }

  private findTable (bot: Bot): Block | null {
    const id = bot.registry.blocksByName.crafting_table?.id
    return id === undefined ? null : bot.findBlock({ matching: id, maxDistance: 16 })
  }

  /** Walk until `block` is within reach. */
  private async reach (gen: number, block: Block): Promise<void> {
    const bot = this.bot()
    if (bot.entity.position.offset(0, bot.entity.height, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4) return
    await this.goto(gen, new goals.GoalLookAtBlock(block.position, bot.world), 30_000)
  }

  private async closeAnyWindow (bot: Bot): Promise<void> {
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch { /* already closed */ } }
  }

  /**
   * Smelt `count` items in a furnace. `item` names the input (raw_iron, *_log)
   * or the output (iron_ingot, charcoal). Uses a furnace within 16 blocks, or
   * crafts one from cobblestone and places it. Fuel comes from the inventory
   * (coal, charcoal, planks, logs, sticks, best first) unless `fuel` names one.
   * Waits for the results (10 s per item) and takes them out.
   */
  async smelt (item: string, count: number, fuel?: string): Promise<string> {
    const bot = this.bot()
    const spec = smeltSpec(item)
    if (!spec) throw new ActionError(`can't smelt "${item}": not in the smelting table (try raw_iron, raw_gold, raw_copper, *_log for charcoal, sand, cobblestone, raw meat)`)
    // The input slot holds one item type: use the one carried most.
    const totals = new Map<string, number>()
    for (const it of bot.inventory.items()) if (spec.isInput(it.name)) totals.set(it.name, (totals.get(it.name) ?? 0) + it.count)
    const gen = this.claim(`smelting ${count} ${item}`)
    let furnace: Furnace | null = null
    const notes: string[] = []
    try {
      let block = this.findFurnace(bot)
      if (!block) {
        if (findItems(bot, 'furnace').length === 0) {
          // Only spend materials on a furnace when there is something to smelt.
          if (totals.size === 0) throw new ActionError(`can't smelt ${item}: no ${spec.inputs.join(' / ')} in inventory; have: ${this.inventoryList()}`)
          const out = await this.craftIn(gen, 'furnace', 1)
          notes.push(out.replace(/^crafted/, 'made'))
        }
        block = await this.placeIn(gen, 'furnace')
        notes.push(`placed a furnace at ${fmtPos(block.position)}`)
      }
      this.lastFurnace = block.position.clone()
      await this.reach(gen, block)
      if (!this.stillCurrent(gen)) throw this.interrupted()
      const f = await withTimeout(bot.openFurnace(block), 5_000, 'opening the furnace took too long')
      furnace = f
      const outputName = spec.output
      const before = this.state().inventory[outputName] ?? 0
      let collected = 0
      let foreign = ''
      const takeOut = async (): Promise<void> => {
        const out = f.outputItem()
        if (!out) return
        const got = await this.withHands('take from furnace', () => f.takeOutput())
        if (got.name === outputName) collected += got.count
        else foreign = `${got.count} ${got.name}`
      }
      // Re-entry: output from an earlier run counts, matching input already in counts as loaded.
      await takeOut()
      const inSlot = f.inputItem()
      let inputName = [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      let loaded = 0
      if (inSlot) {
        if (!spec.isInput(inSlot.name)) throw new ActionError(`the furnace at ${fmtPos(block.position)} is busy with ${inSlot.count} ${inSlot.name}; wait for it or use another furnace`)
        if (inputName !== inSlot.name && (totals.get(inSlot.name) ?? 0) === 0) inputName = inSlot.name
        if (inputName === inSlot.name) loaded = inSlot.count
        else throw new ActionError(`the furnace at ${fmtPos(block.position)} already holds ${inSlot.count} ${inSlot.name}; wait for it or smelt ${inSlot.name}`)
      }
      const wanted = Math.max(0, count - collected)
      const add = inputName ? Math.min(totals.get(inputName) ?? 0, Math.max(0, wanted - loaded)) : 0
      if (add + loaded === 0 && collected === 0) throw new ActionError(`can't smelt ${item}: no ${spec.inputs.join(' / ')} in inventory; have: ${this.inventoryList()}`)
      const short = wanted - loaded - add
      if (short > 0) notes.push(`only had ${add + loaded} to smelt (${short} short)`)

      // Fuel: what's in the slot counts; top up with one fuel type.
      const toSmelt = add + loaded
      const fuelIn = f.fuelItem()
      let units = fuelIn ? fuelIn.count * fuelUnits(fuelIn.name) : 0
      if (f.fuel > 0) units += 1 // a burning flame covers about the item in progress
      let fuelUsed = ''
      if (toSmelt > units) {
        const pick = this.pickFuel(bot, toSmelt - units, fuel, (n) => spec.isInput(n), fuelIn?.name)
        if (fuelIn && fuelIn.name !== pick.name) await this.withHands('take fuel', () => f.takeFuel())
        await this.withHands('load fuel', () => f.putFuel(pick.type, null, pick.count))
        fuelUsed = `${pick.count} ${pick.name}`
      }
      if (add > 0 && inputName) {
        const type = bot.registry.itemsByName[inputName]?.id
        if (type === undefined) throw new ActionError(`unknown item ${inputName}`)
        await this.withHands('load furnace', () => f.putInput(type, null, add))
      }
      log('item.smelt_start', { input: inputName, add, loaded, fuel: fuelUsed, output: outputName })

      // Wait: ~10 s per item, plus slack. A reflex (or any newer command) ends the wait.
      const deadline = Date.now() + (toSmelt * SMELT_SECONDS + 20) * 1000
      while (collected < count && Date.now() < deadline) {
        await sleep(1000)
        if (!this.stillCurrent(gen)) throw this.interrupted()
        await takeOut()
        if (!f.inputItem() && !f.outputItem() && f.progress === 0) break
      }
      await takeOut()
      // The inventory model lags while the furnace window is open: count ourselves.
      const have = before + collected
      const left = f.inputItem()?.count ?? 0
      const msg = `smelted ${collected} ${outputName}${inputName ? ` from ${inputName}` : ''}, now have ${have}` +
        (fuelUsed ? `; fuel ${fuelUsed}` : '') + (left ? `; ${left} still in the furnace at ${fmtPos(block.position)} (smelt again to collect)` : '') +
        (foreign ? `; also took out ${foreign}` : '') + (notes.length ? `; ${notes.join('; ')}` : '')
      if (collected === 0) throw new ActionError(`nothing came out: ${msg}`)
      return msg
    } catch (e) {
      // A window op in flight when a reflex closed the furnace fails oddly: report the interruption.
      if (!this.stillCurrent(gen)) throw this.interrupted()
      throw e instanceof ActionError ? e : new ActionError(`smelting failed: ${errText(e)}`)
    } finally {
      if (furnace && this.stillCurrent(gen)) { try { furnace.close() } catch { /* closed already */ } }
      this.finish(gen)
    }
  }

  /** A furnace within 16 blocks, else the last one used if it is still there (within 64). */
  private findFurnace (bot: Bot): Block | null {
    const id = bot.registry.blocksByName.furnace?.id
    if (id === undefined) return null
    const near = bot.findBlock({ matching: id, maxDistance: 16 })
    if (near) return near
    const last = this.lastFurnace ? bot.blockAt(this.lastFurnace) : null
    return last && last.type === id && last.position.distanceTo(bot.entity.position) <= 64 ? last : null
  }

  /** One fuel type from the inventory that covers `units` items. */
  private pickFuel (bot: Bot, units: number, wanted: string | undefined, isInput: (n: string) => boolean, inSlot: string | undefined): { name: string, type: number, count: number } {
    const totals = new Map<string, { type: number, count: number }>()
    const re = wanted ? wildcard(wanted) : null
    for (const it of bot.inventory.items()) {
      if (fuelUnits(it.name) === 0) continue
      if (re ? !re.test(it.name) : isInput(it.name)) continue
      const t = totals.get(it.name) ?? { type: it.type, count: 0 }
      t.count += it.count
      totals.set(it.name, t)
    }
    // Prefer topping up the fuel already in the slot, then the best fuel.
    const ranked = [...totals].sort((a, b) => Number(b[0] === inSlot) - Number(a[0] === inSlot) || fuelRank(a[0]) - fuelRank(b[0]))
    for (const [name, t] of ranked) {
      const need = Math.ceil(units / fuelUnits(name))
      if (t.count >= need) return { name, type: t.type, count: need }
    }
    const carried = ranked.map(([n, t]) => `${t.count} ${n}`).join(', ')
    const coal = Math.ceil(units / 8)
    throw new ActionError(`can't smelt: need fuel for ${units} items, e.g. ${coal} more coal/charcoal or ${Math.ceil(units / 1.5)} planks/logs; ${wanted ? `${wanted} carried` : 'fuel carried'}: ${carried || 'none'}`)
  }

  /** Place a block from the inventory at x y z, or on a free spot next to the bot. */
  async placeBlock (item: string, at?: { x: number, y: number, z: number }): Promise<string> {
    this.bot()
    const gen = this.claim(`placing ${item}`)
    try {
      const b = await this.placeIn(gen, item, at)
      return `placed ${b.name} at ${fmtPos(b.position)}`
    } finally { this.finish(gen) }
  }

  private async placeIn (gen: number, itemName: string, at?: { x: number, y: number, z: number }): Promise<Block> {
    const bot = this.bot()
    const item = findItems(bot, itemName)[0]
    if (!item) throw new ActionError(`no ${itemName} in inventory to place; have: ${this.inventoryList()}`)
    if (!bot.registry.blocksByName[item.name]) throw new ActionError(`${item.name} is not a placeable block`)
    let spot: { target: Vec3Like, ref: Block } | null
    if (at) {
      const target = bot.entity.position.clone().set(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
      const cur = bot.blockAt(target)
      if (!cur) throw new ActionError(`${fmtPos(target)} is not loaded (too far away)`)
      if (!isFree(cur)) throw new ActionError(`${fmtPos(target)} is not empty (${cur.name})`)
      const ref = NEIGHBORS.map(([dx, dy, dz]) => bot.blockAt(target.offset(dx, dy, dz))).find((b): b is Block => !!b && isSolid(b))
      if (!ref) throw new ActionError(`nothing solid next to ${fmtPos(target)} to place against`)
      spot = { target, ref }
    } else {
      spot = this.freeSpot(bot)
      if (!spot) throw new ActionError('no free spot with solid ground within 3 blocks to place on')
    }
    const { target, ref } = spot
    const eye = (): number => bot.entity.position.offset(0, bot.entity.height, 0).distanceTo(target.offset(0.5, 0.5, 0.5))
    if (eye() > 4.2) {
      await this.goto(gen, new goals.GoalPlaceBlock(target, bot.world, { range: 4 } as unknown as ConstructorParameters<typeof goals.GoalPlaceBlock>[2]), 30_000) // the JS fills in the other options
    }
    if (!this.stillCurrent(gen)) throw this.interrupted()
    if (overlapsEntity(bot, target)) throw new ActionError(`someone is standing at ${fmtPos(target)}`)
    const face = target.minus(ref.position)
    try {
      await this.withHands('place', async () => {
        await bot.equip(item, 'hand')
        await bot.placeBlock(ref, face)
      })
    } catch (e) {
      // placeBlock can time out waiting for the update although the block is there.
      await sleep(300)
      if (bot.blockAt(target)?.name !== item.name) {
        if (!this.stillCurrent(gen)) throw this.interrupted()
        throw new ActionError(`placing ${item.name} at ${fmtPos(target)} failed: ${errText(e)}`)
      }
    }
    const placed = bot.blockAt(target)
    if (!placed || isFree(placed)) throw new ActionError(`placing ${item.name} at ${fmtPos(target)} failed (still ${placed?.name ?? 'unknown'})`)
    log('item.place', { item: item.name, at: fmtPos(target) })
    return placed
  }

  /** Nearest empty cell 1-3 blocks away with solid ground, not where anyone stands. */
  private freeSpot (bot: Bot): { target: Vec3Like, ref: Block } | null {
    const feet = bot.entity.position.floored()
    const cells: Vec3Like[] = []
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, -1, 1]) {
      if (dx === 0 && dz === 0) continue
      cells.push(feet.offset(dx, dy, dz))
    }
    const me = bot.entity.position
    cells.sort((a, b) => Math.abs(a.distanceTo(me) - 2) - Math.abs(b.distanceTo(me) - 2) || Math.abs(a.y - feet.y) - Math.abs(b.y - feet.y))
    for (const target of cells) {
      const cur = bot.blockAt(target)
      const below = bot.blockAt(target.offset(0, -1, 0))
      if (!cur || !below || !isFree(cur) || !isSolid(below)) continue
      if (overlapsEntity(bot, target)) continue
      return { target, ref: below }
    }
    return null
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

type Vec3Like = Bot['entity']['position']

/** Tool tiers, weakest first (for "needs a stone_pickaxe or better"). */
const PICK_ORDER = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']

const NEIGHBORS: Array<[number, number, number]> = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

/** Blocks that open a screen or toggle when clicked: never place against them. */
const INTERACTIVE = /table|furnace|smoker|chest|barrel|shulker|hopper|dispenser|dropper|door|gate|bed|anvil|lever|button|loom|grindstone|stonecutter|lectern|enchanting|brewing|beacon|bell|note_block|repeater|comparator|crafter|cartography|smithing|fletching|composter/

/** Air, or a plant a placed block replaces (flowers are not replaceable). */
function isFree (b: Block): boolean {
  return /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|short_dry_grass|tall_dry_grass|bush)$/.test(b.name)
}

function isSolid (b: Block): boolean {
  return b.boundingBox === 'block' && !INTERACTIVE.test(b.name)
}

/** Would a block at `cell` intersect the bot, a player or a mob? */
function overlapsEntity (bot: Bot, cell: Vec3Like): boolean {
  return Object.values(bot.entities).some((e) => {
    if (e.type === 'object' || e.type === 'orb' || e.name === 'item') return false
    const half = (e.width || 0.6) / 2
    const h = e.height || 1.8
    const p = e.position
    return p.x + half > cell.x && p.x - half < cell.x + 1 && p.z + half > cell.z && p.z - half < cell.z + 1 && p.y + h > cell.y && p.y < cell.y + 1
  })
}

/**
 * Ask the server for the full inventory state (mineflayer's own no-op click,
 * `bot._syncWindow`, which craft() only uses for crafting-table windows).
 */
async function syncInventory (bot: Bot): Promise<void> {
  const sync = (bot as unknown as { _syncWindow?: (w: unknown) => Promise<void> })._syncWindow
  if (!sync) return
  await withTimeout(sync(bot.inventory), 2_000, 'inventory sync timed out').catch(() => {})
}

/** Move anything left in the 2x2 crafting grid (slots 1-4) back into the inventory. */
async function clearCraftingGrid (bot: Bot): Promise<void> {
  await syncInventory(bot)
  for (let s = 1; s <= 4; s++) {
    if (bot.inventory.slots[s]) await withTimeout(bot.putAway(s), 2_000, 'clearing the crafting grid timed out').catch(() => {})
  }
  await syncInventory(bot)
}

function fmtPos (p: { x: number, y: number, z: number }): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
}

function errText (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sum (m: Map<string, number>): number {
  let n = 0
  for (const v of m.values()) n += v
  return n
}

function withTimeout<T> (p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ActionError(message)), ms) })
  ]).finally(() => clearTimeout(timer))
}

/** `*_log` → /^[a-z_]*_log$/: the wildcard syntax mine_block and gather steps share. */
export function blockPattern (name: string): RegExp {
  return new RegExp('^' + name.split('*').map(escapeRe).join('[a-z_]*') + '$')
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
