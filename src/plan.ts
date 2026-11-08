import { z } from 'zod'

/**
 * Plans: an ordered list of typed steps the cerebellum works through. Held in
 * memory only. The MCP tools set_plan / get_plan / clear_plan (mcp.ts) sit on
 * top of `PlanStore`; nothing here knows about MCP or Matrix.
 *
 * The zod schemas below are the single source of truth for a step's shape:
 * the MCP tool schema, `!plan {json}` and CEREBELLUM_PLAN all parse with them,
 * and `PlanStep` is inferred from them, so executors and Jev options stay in
 * step with what Hermes can send.
 */

export const STEP_KINDS = ['gather', 'craft', 'smelt', 'move_to', 'come_to_player', 'wait'] as const

const coord = (axis: string): z.ZodNumber => z.number({ error: `${axis} must be a number (block coordinate)` }).finite()

export const GatherStepSchema = z.strictObject({
  kind: z.literal('gather'),
  block: z.string({ error: 'gather needs `block`: a Minecraft block id such as oak_log, or a wildcard like *_log' }).min(1)
    .describe('Minecraft BLOCK id to mine, e.g. oak_log, stone, coal_ore, sand. `*` is a wildcard: *_log = any log. Name the block, not its drop (coal_ore, not coal; stone drops cobblestone).'),
  count: z.number({ error: 'gather needs `count`: how many blocks to mine (1-256)' }).int().min(1).max(256)
    .describe('How many MORE blocks to mine (counted from what is already carried).')
}).describe('Mine blocks nearby (searches about 48 blocks around the body) and pick up the drops.')

export const CraftStepSchema = z.strictObject({
  kind: z.literal('craft'),
  item: z.string({ error: 'craft needs `item`: a Minecraft item id such as stick, crafting_table, wooden_pickaxe' }).min(1)
    .describe('Minecraft ITEM id to craft, e.g. stick, crafting_table, wooden_pickaxe, stone_pickaxe, furnace, torch. *_planks = planks of any wood.'),
  count: z.number({ error: 'craft needs `count`: how many items to make (1-64)' }).int().min(1).max(64)
    .describe('How many MORE items to have than when the step starts.')
}).describe('Craft items; missing intermediates (planks, sticks, a crafting table) are made from what is carried.')

export const SmeltStepSchema = z.strictObject({
  kind: z.literal('smelt'),
  item: z.string({ error: 'smelt needs `item`: what to smelt (raw_iron) or what to make (iron_ingot)' }).min(1)
    .describe('The input (raw_iron, raw_gold, *_log, sand, beef) or the output (iron_ingot, charcoal, glass, cooked_beef).'),
  count: z.number({ error: 'smelt needs `count`: how many items to make (1-64)' }).int().min(1).max(64)
    .describe('How many MORE output items to have than when the step starts.'),
  fuel: z.string().min(1).optional().describe('Fuel item id (coal, charcoal, *_planks); omit to pick from the inventory.')
}).describe('Smelt in a furnace nearby, or one crafted from 8 cobblestone and placed; 10 s per item.')

export const MoveToStepSchema = z.strictObject({
  kind: z.literal('move_to'),
  x: coord('x'),
  y: coord('y').optional().describe('Omit to only reach the x/z column.'),
  z: coord('z')
}).describe('Walk to coordinates.')

export const ComeToPlayerStepSchema = z.strictObject({
  kind: z.literal('come_to_player'),
  player: z.string().min(1).optional().describe('Player name; omit for the usual companion player.')
}).describe('Walk back to a player and stop next to them.')

export const WaitStepSchema = z.strictObject({
  kind: z.literal('wait'),
  seconds: z.number({ error: 'wait needs `seconds` (1-600)' }).min(1).max(600)
}).describe('Stay where you are for a while.')

export const PlanStepSchema = z.discriminatedUnion('kind', [GatherStepSchema, CraftStepSchema, SmeltStepSchema, MoveToStepSchema, ComeToPlayerStepSchema, WaitStepSchema], {
  error: (iss) => iss.code === 'invalid_union' ? `unknown step kind; \`kind\` must be one of ${STEP_KINDS.join(', ')}` : undefined
})

export const PlanSchema = z.object({
  goal: z.string().max(200).optional(),
  steps: z.array(PlanStepSchema).min(1, 'a plan needs at least one step').max(20, 'at most 20 steps')
})

export type PlanStep = z.infer<typeof PlanStepSchema>

export type PlanStatus = 'active' | 'paused' | 'done' | 'failed'

export interface Plan {
  /** What the plan is for, in words (shown to Jev and to Hermes). */
  goal: string
  steps: PlanStep[]
}

export interface PlanView {
  goal: string
  status: PlanStatus
  stepIndex: number
  steps: PlanStep[]
  current: PlanStep | null
  /** Why the plan was paused or failed. */
  reason: string | null
}

/** Hand-written plans for testing without Hermes (CEREBELLUM_PLAN=<name>, or `!plan <name>` in game). */
export const PRESET_PLANS: Record<string, Plan> = {
  logs: {
    goal: 'gather 5 logs, then come back to the player',
    steps: [
      { kind: 'gather', block: '*_log', count: 5 },
      { kind: 'come_to_player' }
    ]
  },
  logs_only: {
    goal: 'gather 5 logs',
    steps: [{ kind: 'gather', block: '*_log', count: 5 }]
  },
  pickaxe: {
    goal: 'gather 3 logs and make a wooden pickaxe',
    steps: [
      { kind: 'gather', block: '*_log', count: 3 },
      { kind: 'craft', item: 'wooden_pickaxe', count: 1 }
    ]
  }
}

/** Parse a preset name or a JSON plan (`{"goal": ..., "steps": [...]}`). */
export function parsePlan (spec: string): Plan {
  const preset = PRESET_PLANS[spec.trim()]
  if (preset) return structuredClone(preset)
  const raw = JSON.parse(spec) as unknown
  return validatePlan(raw)
}

export function validatePlan (raw: unknown): Plan {
  const r = PlanSchema.safeParse(raw)
  if (!r.success) throw new Error(formatIssues(r.error))
  return { goal: r.data.goal?.trim() || 'unnamed plan', steps: r.data.steps }
}

/** zod issues as short readable lines: "steps.0.kind: unknown step kind; ...". */
export function formatIssues (e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ')
}

/** Common drop/material names → the block that yields them (gather mines blocks). */
const DROP_TO_BLOCK: Record<string, string> = {
  wood: '*_log', log: '*_log', logs: '*_log', tree: '*_log', coal: 'coal_ore', raw_iron: 'iron_ore', iron: 'iron_ore',
  raw_gold: 'gold_ore', gold: 'gold_ore', raw_copper: 'copper_ore', copper: 'copper_ore', diamond: 'diamond_ore',
  emerald: 'emerald_ore', redstone: 'redstone_ore', lapis_lazuli: 'lapis_ore', lapis: 'lapis_ore', flint: 'gravel',
  clay_ball: 'clay', quartz: 'nether_quartz_ore', rock: 'stone', cobble: 'stone', seeds: 'short_grass'
}

/**
 * Checks every gather step's `block` against the block registry (with `*`
 * wildcards). Returns readable errors with suggestions, or [] when all match.
 */
export function checkGatherBlocks (steps: PlanStep[], blockNames: string[], pattern: (name: string) => RegExp): string[] {
  const errors: string[] = []
  steps.forEach((s, i) => {
    if (s.kind !== 'gather') return
    const re = pattern(s.block)
    if (blockNames.some((n) => re.test(n))) return
    const key = s.block.replace(/^minecraft:/, '').toLowerCase()
    const mapped = DROP_TO_BLOCK[key]
    const token = key.replace(/\*/g, '').replace(/^raw_|^_+|_+$/g, '')
    const similar = token.length >= 3 ? blockNames.filter((n) => n.includes(token)).sort((a, b) => a.length - b.length).slice(0, 5) : []
    const hints = [...new Set([...(mapped ? [mapped] : []), ...similar])].slice(0, 5)
    errors.push(`steps.${i}.block: "${s.block}" is not a Minecraft block id` + (hints.length ? `; did you mean ${hints.join(', ')}?` : '; use block ids like oak_log, stone, coal_ore, or a wildcard like *_log') + (mapped ? ' (gather mines the block, not the item it drops)' : ''))
  })
  return errors
}

export function describeStep (s: PlanStep): string {
  switch (s.kind) {
    case 'gather': return `gather ${s.count} ${s.block}`
    case 'craft': return `craft ${s.count} ${s.item}`
    case 'smelt': return `smelt ${s.count} ${s.item}${s.fuel ? ` with ${s.fuel}` : ''}`
    case 'move_to': return `walk to ${s.x} ${s.y ?? '~'} ${s.z}`
    case 'come_to_player': return `come back to ${s.player ?? 'the player'}`
    case 'wait': return `wait ${s.seconds}s`
  }
}

type Listener = (view: PlanView, change: string) => void

export class PlanStore {
  private plan: Plan | null = null
  private status: PlanStatus = 'done'
  private index = 0
  private reason: string | null = null
  private readonly listeners: Listener[] = []

  onChange (fn: Listener): void {
    this.listeners.push(fn)
  }

  private emit (change: string): void {
    const v = this.view()
    if (v) for (const fn of this.listeners) fn(v, change)
  }

  set (plan: Plan): void {
    this.plan = plan
    this.index = 0
    this.status = 'active'
    this.reason = null
    this.emit('set')
  }

  clear (): void {
    if (!this.plan) return
    this.emit('cleared')
    this.plan = null
    this.status = 'done'
  }

  view (): PlanView | null {
    if (!this.plan) return null
    return {
      goal: this.plan.goal,
      status: this.status,
      stepIndex: this.index,
      steps: this.plan.steps,
      current: this.status === 'active' || this.status === 'paused' ? this.plan.steps[this.index] ?? null : null,
      reason: this.reason
    }
  }

  /** The step to work on now, or null when there is no active plan. */
  get active (): PlanStep | null {
    return this.plan && this.status === 'active' ? this.plan.steps[this.index] ?? null : null
  }

  get stepIndex (): number {
    return this.index
  }

  /** Mark the current step done; finishes the plan after the last one. */
  advance (): void {
    if (!this.plan || this.status !== 'active') return
    this.index++
    if (this.index >= this.plan.steps.length) {
      this.status = 'done'
      this.emit('done')
    } else {
      this.emit('advanced')
    }
  }

  pause (reason: string): void {
    if (!this.plan || this.status !== 'active') return
    this.status = 'paused'
    this.reason = reason
    this.emit('paused')
  }

  resume (): boolean {
    if (!this.plan || this.status !== 'paused') return false
    this.status = 'active'
    this.reason = null
    this.emit('resumed')
    return true
  }

  fail (reason: string): void {
    if (!this.plan || this.status !== 'active') return
    this.status = 'failed'
    this.reason = reason
    this.emit('failed')
  }
}
