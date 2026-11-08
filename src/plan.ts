/**
 * Plans: an ordered list of typed steps the cerebellum works through. Held in
 * memory only. M5 adds set_plan / get_plan / clear_plan MCP tools on top of
 * `PlanStore`; nothing here knows about MCP or Matrix.
 */

export type PlanStep =
  /** Mine `count` more blocks matching `block` (Minecraft id, `*` wildcard allowed: `*_log`). */
  | { kind: 'gather', block: string, count: number }
  /** Walk to coordinates (y optional). */
  | { kind: 'move_to', x: number, y?: number, z: number }
  /** Walk back to a player (default: the companion player). */
  | { kind: 'come_to_player', player?: string }
  /** Stay put for a while. */
  | { kind: 'wait', seconds: number }

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
  const o = raw as { goal?: unknown, steps?: unknown }
  if (!o || typeof o !== 'object' || !Array.isArray(o.steps) || o.steps.length === 0) throw new Error('plan needs a non-empty steps array')
  const steps = o.steps.map((s: unknown, i: number): PlanStep => {
    const st = s as Record<string, unknown>
    const num = (k: string): number => {
      const v = st[k]
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`step ${i}: ${k} must be a number`)
      return v
    }
    switch (st.kind) {
      case 'gather':
        if (typeof st.block !== 'string' || !st.block) throw new Error(`step ${i}: gather needs block`)
        return { kind: 'gather', block: st.block, count: Math.max(1, Math.floor(num('count'))) }
      case 'move_to':
        return st.y === undefined ? { kind: 'move_to', x: num('x'), z: num('z') } : { kind: 'move_to', x: num('x'), y: num('y'), z: num('z') }
      case 'come_to_player':
        return typeof st.player === 'string' ? { kind: 'come_to_player', player: st.player } : { kind: 'come_to_player' }
      case 'wait':
        return { kind: 'wait', seconds: num('seconds') }
      default:
        throw new Error(`step ${i}: unknown kind ${String(st.kind)}`)
    }
  })
  return { goal: typeof o.goal === 'string' && o.goal ? o.goal : 'unnamed plan', steps }
}

export function describeStep (s: PlanStep): string {
  switch (s.kind) {
    case 'gather': return `gather ${s.count} ${s.block}`
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
