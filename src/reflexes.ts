import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { Vec3 } from 'vec3'
import type { Actions } from './actions.js'
import type { Body } from './body.js'
import { armorUpgrades, attackCooldownMs, bestFood, ownOxygen } from './items.js'
import { log } from './log.js'

const { goals } = pathfinderPkg

/**
 * Hostile-typed mobs that are never attacked proactively: neutrals that only
 * fight back, plus creepers (their 1.5 s fuse beats our ~4 hits, and the blast
 * would land next to the player) and wardens (unwinnable).
 */
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'creaking', 'creeper', 'warden'])
/** Never fought, even when they hit us: hopeless or friendly. */
const NEVER_FIGHT = new Set(['iron_golem', 'snow_golem', 'villager', 'wandering_trader', 'warden'])
/** Mobs minecraft-data types as "mob"/"animal" that attack on sight anyway. */
const EXTRA_HOSTILE = new Set(['slime', 'magma_cube', 'hoglin', 'phantom'])
const ENGAGE_RANGE = 8
const REACH = 3
const FIGHT_LIMIT_MS = 30_000
/** Give up on a target we can't land a hit on for this long (unreachable). */
const NO_HIT_LIMIT_MS = 12_000

interface Fight {
  target: Entity
  name: string
  gen: number
  why: 'attacked' | 'nearby'
  started: number
  lastHit: number
  nextHit: number
  hits: number
}

type Hazard = 'lava' | 'fire' | 'burning' | 'drowning'

/**
 * Self-preservation that runs on every physics tick in the bot process, with
 * no LLM or cerebellum calls: escape lava/fire/water, fight back, eat, wear
 * armor. Priority, highest first: escape > fight > eat > armor.
 *
 * Fighting and escaping take the activity slot via `Actions.preempt()` (so
 * get_state shows e.g. "fighting zombie" and MCP movement verbs answer
 * "busy"); eating runs alongside a follow/walk; everything that touches the
 * held item goes through `Actions.withHands()`.
 */
export class Reflexes {
  private fight: Fight | null = null
  private escaping: Hazard | null = null
  private eating = false
  private lastHurt: { at: number, source: Entity | null } | null = null
  private ignored = new Map<number, number>()
  private underwaterSince = 0
  private nextEscapeAt = 0
  private nextEatAt = 0
  private noFoodLogged = false
  private nextArmorAt = 0
  private tick = 0
  private bot: Bot | null = null

  constructor (body: Body, private readonly actions: Actions) {
    body.on('spawn', (bot) => this.attach(bot))
  }

  private attach (bot: Bot): void {
    this.bot = bot
    // A new bot after a reconnect: Actions resets the activity slot itself.
    this.fight = null
    this.escaping = null
    this.eating = false
    bot.on('physicsTick', () => {
      try { this.onTick(bot) } catch (e) { log('reflex.error', { message: e instanceof Error ? e.message : String(e) }) }
    })
    bot.on('entityHurt', (entity, source) => {
      if (entity !== bot.entity) return
      this.lastHurt = { at: Date.now(), source: source ?? null }
    })
    bot.on('death', () => {
      if (this.fight) this.endFight('died')
    })
  }

  private onTick (bot: Bot): void {
    if (!bot.entity || bot.health <= 0) return
    const now = Date.now()
    this.tick++

    if (this.escaping) return
    const hazard = now >= this.nextEscapeAt ? this.hazard(bot, now) : null
    // Already out of the fire but still burning: only worth moving if water is
    // right there; otherwise carry on (and don't interrupt a fight for it).
    const water = hazard === 'burning' ? bot.findBlock({ matching: (b) => b.name === 'water', maxDistance: 8 })?.position ?? null : null
    if (hazard === 'burning' && !water) this.nextEscapeAt = now + 3000
    else if (hazard) {
      if (this.fight) this.endFight(`escaping ${hazard}`)
      void this.escape(bot, hazard, water)
      return
    }

    if (this.fight) { this.fightTick(bot, now); return }
    const target = this.pickTarget(bot, now)
    if (target) { this.startFight(bot, target.entity, target.why, now); return }

    if (!this.eating && now >= this.nextEatAt && !this.actions.handsBusy) this.maybeEat(bot, now)

    if (now >= this.nextArmorAt && !this.eating && !this.actions.handsBusy) {
      this.nextArmorAt = now + 2000
      if (armorUpgrades(bot).length > 0) {
        this.actions.equipBestArmor()
          .then((put) => { if (put.length) log('reflex.armor', { put }) })
          .catch((e: unknown) => log('reflex.armor', { ok: false, error: String(e) }))
      }
    }
  }

  // ---- hazards -----------------------------------------------------------

  private hazard (bot: Bot, now: number): Hazard | null {
    const e = bot.entity as Entity & { isInLava?: boolean, isInWater?: boolean }
    if (e.isInLava) return 'lava'
    const feet = bot.blockAt(e.position)
    const head = bot.blockAt(e.position.offset(0, 1, 0))
    if (isFire(feet) || isFire(head)) return 'fire'
    // Oxygen drops one point per ~0.75 s underwater; three points down means
    // really submerged, not wading.
    const oxygen = ownOxygen(bot)
    if (oxygen < 20) {
      if (!this.underwaterSince) this.underwaterSince = now
      if (oxygen <= 17 && isLiquid(bot.blockAt(e.position.offset(0, 1.62, 0)))) return 'drowning'
    } else {
      this.underwaterSince = 0
    }
    const flags = (e.metadata as unknown[])[0]
    if (typeof flags === 'number' && (flags & 0x01) && !e.isInWater) return 'burning'
    return null
  }

  private async escape (bot: Bot, hazard: Hazard, water: Vec3 | null): Promise<void> {
    const started = Date.now()
    this.escaping = hazard
    const from = bot.entity.position.floored()
    let gen: number | null = null
    let result = 'ok'
    let to: Vec3 | null = water
    try {
      gen = this.actions.preempt(`escaping ${hazard}`)
      log('reflex.escape', { phase: 'start', hazard, pos: from, oxygen: ownOxygen(bot), health: bot.health })
      bot.setControlState('jump', true)
      if (hazard === 'drowning') {
        // Swim up until the head is out of the water (or 4 s pass).
        const until = Date.now() + 4000
        while (Date.now() < until && bot.entity && isLiquid(bot.blockAt(bot.entity.position.offset(0, 1.62, 0)))) await sleep(100)
      } else {
        await sleep(250)
      }
      to ??= safeSpot(bot, hazard)
      bot.setControlState('jump', false)
      if (!to) { result = 'no safe spot found'; return }
      const goal = hazard === 'burning' ? new goals.GoalNear(to.x, to.y, to.z, 0) : new goals.GoalBlock(to.x, to.y + 1, to.z)
      await this.actions.goto(gen, goal, 15_000)
    } catch (e) {
      result = e instanceof Error ? e.message : String(e)
    } finally {
      if (bot.entity) bot.clearControlStates()
      if (gen !== null) this.actions.release(gen)
      this.escaping = null
      // Retry soon if still in trouble, but don't spin on a hopeless spot.
      this.nextEscapeAt = Date.now() + (result === 'ok' ? 500 : 2000)
      log('reflex.escape', { phase: 'end', hazard, result, to, pos: bot.entity?.position.floored(), oxygen: bot.entity ? ownOxygen(bot) : null, health: bot.health, ms: Date.now() - started })
    }
  }

  // ---- fighting ----------------------------------------------------------

  private pickTarget (bot: Bot, now: number): { entity: Entity, why: Fight['why'] } | null {
    const me = bot.entity.position
    // Retaliate against the mob that just hurt us. Damage with no attacker
    // (fall, starvation, fire, drowning) is never blamed on whoever stands
    // nearby: that could be the player's pet.
    const hurt = this.lastHurt
    if (hurt && now - hurt.at < 1500) {
      this.lastHurt = null
      const src = hurt.source
      if (src && isMob(src) && !NEVER_FIGHT.has(src.name ?? '') && bot.entities[src.id] && src.position.distanceTo(me) <= 16) {
        return { entity: src, why: 'attacked' }
      }
    }
    if (this.tick % 4 !== 0) return null
    for (const [id, until] of this.ignored) if (until < now) this.ignored.delete(id)
    const e = nearest(bot, (e) => isAggressive(e) && !this.ignored.has(e.id) && Math.abs(e.position.y - me.y) < 4, ENGAGE_RANGE)
    return e ? { entity: e, why: 'nearby' } : null
  }

  private startFight (bot: Bot, target: Entity, why: Fight['why'], now: number): void {
    const name = target.name ?? 'mob'
    const gen = this.actions.preempt(`fighting ${name}`)
    this.fight = { target, name, gen, why, started: now, lastHit: now, nextHit: now, hits: 0 }
    log('reflex.fight', { phase: 'start', target: name, id: target.id, why, distance: round(target.position.distanceTo(bot.entity.position)), health: bot.health })
    this.actions.equipBestWeapon()
      .then((w) => { if (this.fight) log('reflex.fight', { phase: 'weapon', weapon: w ?? 'fist' }) })
      .catch(() => {})
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
  }

  private fightTick (bot: Bot, now: number): void {
    const f = this.fight
    if (!f) return
    if (!this.actions.stillCurrent(f.gen)) { this.fight = null; return }
    const t = f.target
    if (!bot.entities[t.id] || !t.isValid) { this.endFight(f.hits > 0 ? 'won' : 'target gone'); return }
    const d = t.position.distanceTo(bot.entity.position)
    if (d > 16) { this.endFight('target out of range'); return }
    if (now - f.started > FIGHT_LIMIT_MS || now - f.lastHit > NO_HIT_LIMIT_MS) {
      this.ignored.set(t.id, now + 60_000)
      this.endFight('gave up (unreachable?)')
      return
    }
    // Hit only at full attack strength: early swings do a fraction of the damage.
    if (d <= REACH && now >= f.nextHit) {
      void bot.lookAt(t.position.offset(0, t.height * 0.8, 0), true)
      bot.attack(t)
      f.hits++
      f.lastHit = now
      f.nextHit = now + attackCooldownMs(bot.heldItem)
    }
  }

  private endFight (result: string): void {
    const f = this.fight
    if (!f) return
    this.fight = null
    log('reflex.fight', { phase: 'end', target: f.name, result, hits: f.hits, ms: Date.now() - f.started, health: this.bot?.health ?? null })
    this.actions.release(f.gen)
  }

  // ---- eating ------------------------------------------------------------

  private maybeEat (bot: Bot, now: number): void {
    if (bot.food >= 20) return
    if (!(bot.food <= 14 || bot.health <= 14)) return
    const urgent = bot.food <= 6 || bot.health <= 8
    if (this.actions.activity.startsWith('mining') && !urgent) return
    if (nearest(bot, isAggressive, 5)) return
    const food = bestFood(bot, bot.food <= 4)
    if (!food) {
      // Re-check often (someone may hand us food) but log only once.
      if (!this.noFoodLogged) log('reflex.eat', { ok: false, reason: 'no food', food: bot.food, health: bot.health })
      this.noFoodLogged = true
      this.nextEatAt = now + 3000
      return
    }
    this.noFoodLogged = false
    this.eating = true
    this.actions.sideReflex = `eating ${food.name}`
    // Mining keeps swapping tools in hand: pause it for an urgent meal.
    const gen = this.actions.activity.startsWith('mining') ? this.actions.preempt(`eating ${food.name}`) : null
    const before = { food: bot.food, health: bot.health }
    this.actions.eat(food.name)
      .then((r) => log('reflex.eat', { ok: true, item: food.name, ...before, result: r }))
      .catch((e: unknown) => log('reflex.eat', { ok: false, item: food.name, ...before, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        this.eating = false
        this.actions.sideReflex = null
        if (gen !== null) this.actions.release(gen)
        this.nextEatAt = Date.now() + 2000
      })
  }
}

function isFire (b: Block | null): boolean {
  return b?.name === 'fire' || b?.name === 'soul_fire'
}

function isLiquid (b: Block | null): boolean {
  return b?.name === 'water' || b?.name === 'lava' || b?.name === 'bubble_column'
}

function isMob (e: Entity): boolean {
  // Runtime types come from minecraft-data ("animal", "water_creature", ...),
  // wider than prismarine-entity's typings.
  return ['hostile', 'mob', 'animal', 'water_creature', 'ambient'].includes(e.type as string)
}

function isAggressive (e: Entity): boolean {
  const name = e.name ?? ''
  return (e.type === 'hostile' && !NEUTRAL.has(name)) || EXTRA_HOSTILE.has(name)
}

function nearest (bot: Bot, pred: (e: Entity) => boolean, range: number): Entity | null {
  const me = bot.entity.position
  let best: Entity | null = null
  let bestD = range
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !pred(e)) continue
    const d = e.position.distanceTo(me)
    if (d <= bestD) { best = e; bestD = d }
  }
  return best
}

/** Nearest solid block with two free (non-liquid, non-fire) blocks above it. */
function safeSpot (bot: Bot, hazard: Hazard): Vec3 | null {
  const danger = new Set(['lava', 'magma_block', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'cactus'])
  const free = (b: Block | null): boolean => b != null && b.boundingBox === 'empty' && !isLiquid(b) && !isFire(b)
  const spots = bot.findBlocks({
    point: bot.entity.position,
    maxDistance: 16,
    count: 400,
    matching: (b) => b.boundingBox === 'block' && !danger.has(b.name),
    useExtraInfo: (b) => free(bot.blockAt(b.position.offset(0, 1, 0))) && free(bot.blockAt(b.position.offset(0, 2, 0)))
  })
  const here = bot.entity.position
  // Leaving fire: any neighbouring spot will do, but not the one we're on.
  return spots.find((p) => hazard !== 'fire' || p.offset(0.5, 1, 0.5).distanceTo(here) > 0.9) ?? null
}

function round (n: number): number {
  return Math.round(n * 10) / 10
}

function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
