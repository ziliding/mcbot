import type { Bot } from 'mineflayer'
import type { WorldStateSnapshot } from './actions.js'
import { BAD_FOODS, bestFood } from './items.js'
import { describeStep, type PlanView } from './plan.js'

/** Mobs the reflexes never fight (see reflexes.ts): the cerebellum may flee them. */
export const AVOID_MOBS = new Set(['creeper', 'warden'])

export interface LastAction {
  behavior: string
  outcome: 'running' | 'ok' | 'interrupted' | 'failed'
  detail: string
  at: number
}

/**
 * Compact, semantic world state for Jev. Numbers that need comparing are
 * turned into words by code (Jev reads "close", not 3.2 < 4): "gathered 3 of
 * 5, 2 more needed", "very close". No raw block dumps.
 */
export interface WorldState {
  bot_name: string
  health: string
  food: string
  time: 'day' | 'night'
  nearest_hostile: { mob: string, distance_blocks: number, how_close: string, bot_fights_it: boolean } | null
  players: Array<{ name: string, how_close: string }>
  inventory: { tools: string[], food: Record<string, number>, materials: Record<string, number>, other_item_kinds: number }
  activity: string
  automatic_reflex: string | null
  plan: {
    goal: string
    current_step: string
    step_number: string
    progress: string
    /** True when code already measured the step as complete. */
    measured_complete: boolean
  } | null
  last_action: { behavior: string, outcome: string, detail: string, seconds_ago: number } | null
}

const TOOL_RE = /(_pickaxe|_axe|_shovel|_hoe|_sword)$|^(shears|bow|crossbow|fishing_rod|flint_and_steel|shield|trident)$/
const MATERIAL_RE = /(_log|_planks|_ingot|_ore)$|^(cobblestone|stone|dirt|coal|charcoal|stick|diamond|emerald|torch|crafting_table|furnace|string|gunpowder|bone|arrow)$/

export function howClose (d: number | null): string {
  if (d === null) return 'out of sight'
  if (d <= 3) return 'very close'
  if (d <= 8) return 'close'
  if (d <= 16) return 'nearby'
  return 'far'
}

/** How far along a step is, measured by code. */
export interface StepProgress { text: string, complete: boolean }

export function buildWorldState (
  bot: Bot | null,
  snap: WorldStateSnapshot,
  botName: string,
  plan: PlanView | null,
  progress: StepProgress | null,
  last: LastAction | null
): WorldState {
  const inv = snap.inventory
  const tools: string[] = []
  const food: Record<string, number> = {}
  const materials: Record<string, number> = {}
  let other = 0
  const foods = bot?.registry.foodsByName ?? {}
  for (const [name, n] of Object.entries(inv)) {
    if (TOOL_RE.test(name)) tools.push(name)
    else if (foods[name]) food[BAD_FOODS.has(name) ? `${name} (harmful)` : name] = n
    else if (MATERIAL_RE.test(name)) materials[name] = n
    else other++
  }
  const h = snap.health ?? 0
  const f = snap.food ?? 0
  const hostile = snap.nearestHostile
  const step = plan?.current ?? null
  return {
    bot_name: botName,
    health: `${Math.round(h)}/20 (${h >= 16 ? 'healthy' : h >= 10 ? 'hurt' : h >= 5 ? 'badly hurt' : 'about to die'})`,
    food: `${f}/20 (${f >= 18 ? 'full' : f >= 14 ? 'fine' : f >= 7 ? 'hungry' : 'starving'})${bot && f < 20 && !bestFood(bot, false) ? ', no safe food carried' : ''}`,
    time: snap.isDay === false ? 'night' : 'day',
    nearest_hostile: hostile
      ? { mob: hostile.name, distance_blocks: Math.round(hostile.distance), how_close: howClose(hostile.distance), bot_fights_it: !AVOID_MOBS.has(hostile.name) }
      : null,
    players: snap.players.map((p) => ({ name: p.name, how_close: howClose(p.distance) })),
    inventory: { tools, food, materials, other_item_kinds: other },
    activity: snap.activity,
    automatic_reflex: snap.reflex,
    plan: plan && step
      ? {
          goal: plan.goal,
          current_step: describeStep(step),
          step_number: `${plan.stepIndex + 1} of ${plan.steps.length}`,
          progress: progress?.text ?? 'not started',
          measured_complete: progress?.complete ?? false
        }
      : null,
    last_action: last ? { behavior: last.behavior, outcome: last.outcome, detail: last.detail.slice(0, 160), seconds_ago: Math.round((Date.now() - last.at) / 1000) } : null
  }
}

/**
 * What counts as a meaningful change: bucketed numbers and labels, never raw
 * positions or timestamps. Same fingerprint = no new Jev call needed.
 */
export function fingerprint (s: WorldState, current: string): string {
  return JSON.stringify([
    current,
    s.health.split(' ')[1], s.food.split(' ')[1], s.time,
    s.nearest_hostile ? [s.nearest_hostile.mob, s.nearest_hostile.how_close] : null,
    s.players.map((p) => [p.name, p.how_close]),
    s.inventory.materials, Object.keys(s.inventory.food).length,
    s.activity, s.automatic_reflex,
    s.plan ? [s.plan.step_number, s.plan.progress] : null,
    s.last_action ? [s.last_action.behavior, s.last_action.outcome] : null
  ])
}

/** Count of inventory items matching a block pattern (`*` wildcard). */
export function countMatching (inventory: Record<string, number>, pattern: string): number {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z_]*') + '$')
  return Object.entries(inventory).filter(([n]) => re.test(n)).reduce((a, [, c]) => a + c, 0)
}
