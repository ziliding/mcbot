import { choice, noul } from '@typesafe-ai/sdk'
import { ActionError, SHELTER_ACTIVITY, type Actions } from './actions.js'
import { isEnclosed } from './surroundings.js'
import type { Body } from './body.js'
import type { Jev } from './jev.js'
import { log } from './log.js'
import { describeStep, type PlanStep, type PlanStore } from './plan.js'
import { smeltSpec } from './crafting.js'
import { countGathered } from './items.js'
import { AVOID_MOBS, buildWorldState, countMatching, fingerprint, howClose, type LastAction, type StepProgress, type WorldState } from './worldstate.js'

/**
 * Behaviors the cerebellum can choose, in a fixed order (Jev's Choice options
 * keep this order every tick). Each one has an executor below that drives
 * `Actions`. There is no FIGHT: fighting belongs to the reflexes, and the
 * cerebellum never runs while a reflex holds the activity slot. GATHER, CRAFT,
 * SMELT and MOVE_TO map 1:1 to the plan step kinds gather, craft, smelt and
 * move_to.
 */
export const BEHAVIORS = ['FOLLOW_PLAYER', 'COME_TO_PLAYER', 'GATHER', 'CRAFT', 'SMELT', 'MOVE_TO', 'FLEE', 'EAT', 'IDLE'] as const
export type Behavior = typeof BEHAVIORS[number]

const DESCRIPTIONS: Record<Behavior, string> = {
  FOLLOW_PLAYER: 'Keep following the player, as the bot is already doing (see `activity`).',
  COME_TO_PLAYER: 'Walk back to the player (the current plan step, or the activity already running).',
  GATHER: 'Work on the current plan step: find and mine the blocks it names.',
  CRAFT: 'Work on the current plan step: craft the item it names from the inventory (making planks, sticks or a crafting table on the way).',
  SMELT: 'Work on the current plan step: smelt the items it names in a furnace and wait for the results.',
  MOVE_TO: 'Walk to the place the current plan step or the running activity names.',
  FLEE: 'Move away from the creeper or warden in `nearest_hostile` while it is close: the bot never fights these, so distance is the only defense. A creeper explodes when it gets near.',
  EAT: 'Stop briefly and eat: the food bar is low and the bot carries food.',
  IDLE: 'Do nothing and stay put: no plan step to work on and nothing nearby that needs a response.'
}

export interface CerebellumConfig {
  tickMs: number
  timeoutMs: number
  /** Probability the new behavior needs before switching. */
  switchP: number
  /** ...and how far above the current behavior's probability it must be (hysteresis). */
  margin: number
  /** Top probability below this counts as a low-confidence tick. */
  lowConfP: number
  lowConfTicks: number
  /** "Step still feasible?" below this counts as an infeasible tick. */
  infeasibleP: number
  infeasibleTicks: number
  /** "In danger?" above this lowers the bar for FLEE / EAT. */
  dangerP: number
  /** Re-ask Jev at least this often while something runs, even if nothing changed. */
  maxStaleMs: number
  /** Same escalation (type + step) at most once per this many ms. */
  escalateCooldownMs: number
}

export interface CerebellumEvent {
  type: 'low_confidence' | 'step_infeasible' | 'step_failed' | 'plan_done'
  message: string
  plan: string | null
  step: string | null
  state?: WorldState
}

interface Running {
  behavior: Behavior
  /** Activity-slot generation this run owns; null for EAT (no slot). */
  gen: number | null
  settled: boolean
  /** Planned step index it was started for, or -1. */
  stepIndex: number
}

/** Activity strings set by Actions verbs, mapped back to behaviors. */
function behaviorOfActivity (activity: string): Behavior | null {
  if (activity.startsWith('following ')) return 'FOLLOW_PLAYER'
  if (activity.startsWith('coming to ')) return 'COME_TO_PLAYER'
  if (activity.startsWith('going to ')) return 'MOVE_TO'
  if (activity.startsWith('mining ')) return 'GATHER'
  if (activity.startsWith('crafting ')) return 'CRAFT'
  if (activity.startsWith('smelting ')) return 'SMELT'
  if (activity.startsWith('fleeing ')) return 'FLEE'
  return null
}

/**
 * The cerebellum (M4): a ~1 Hz loop that asks Jev one batched question per
 * tick — which behavior next, is the plan step done, is it still feasible, is
 * the bot in danger — and turns the answers into `Actions` calls through a
 * code-owned policy (thresholds, hysteresis, escalation).
 *
 * Authority, highest first: reflexes (any tick where a reflex holds the slot
 * is skipped outright) > commands from outside (Hermes over MCP, local chat
 * commands: the cerebellum only watches, and may interject FLEE/EAT) > the
 * plan. Completion and progress are measured by code; Jev's "done?" answer is
 * a logged second opinion.
 */
export class Cerebellum {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private running: Running | null = null
  private last: LastAction | null = null
  private lastFp = ''
  private lastCallAt = 0
  private lowTicks = 0
  private infeasibleTicks = 0
  private failures = 0
  private stepKey = ''
  private baseline = 0
  private stepStartedAt = 0
  private doneDisagreeLogged = false
  /** After fleeing from an external follow, follow that player again. */
  private resumeFollow: string | null = null
  private readonly escalatedAt = new Map<string, number>()
  private readonly listeners: Array<(e: CerebellumEvent) => void> = []

  constructor (
    private readonly body: Body,
    private readonly actions: Actions,
    private readonly plans: PlanStore,
    private readonly jev: Jev,
    private readonly cfg: CerebellumConfig,
    private readonly botName: string,
    private readonly defaultPlayer: string
  ) {
    // Any explicit stop (MCP tool, "stop" in chat) pauses the plan, so the next
    // tick doesn't simply start it again.
    actions.onStop(() => plans.pause('told to stop'))
    plans.onChange((v, change) => {
      log('plan.change', { change, goal: v.goal, status: v.status, step: v.stepIndex, of: v.steps.length, reason: v.reason })
      if (change === 'done') this.emit({ type: 'plan_done', message: `plan finished: ${v.goal}`, plan: v.goal, step: null })
      if (change === 'paused' || change === 'cleared' || change === 'done' || change === 'failed') this.lowTicks = 0
      if (change === 'set' || change === 'cleared') {
        // A new or cleared plan: drop the old plan's work, even when the new
        // step maps to the same behavior (GATHER -> GATHER would otherwise
        // "continue" mining the old block), and forget old escalations so the
        // same failure on a re-sent plan is reported again.
        if (this.owns(this.running) && this.running.gen !== null) this.actions.cancel(this.running.gen)
        this.running = null
        this.stepKey = ''
        this.escalatedAt.clear()
      }
    })
  }

  /** Code-measured progress of the active (or paused) plan step, e.g. "gathered 3 of 5, 2 more needed". */
  progressText (): string | null {
    const v = this.plans.view()
    if (!v?.current) return null
    if (v.status === 'active' && this.stepKey === '') return 'not started yet'
    return this.progress(v.current, this.actions.state().inventory).text
  }

  /** Hook for escalation events (main.ts posts them to the Matrix room as `[EVENT] …`). */
  onEvent (fn: (e: CerebellumEvent) => void): void {
    this.listeners.push(fn)
  }

  start (): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((e: unknown) => { this.inFlight = false; log('cerebellum.error', { message: errText(e) }) })
    }, this.cfg.tickMs)
    log('cerebellum.start', { ...this.cfg })
  }

  stop (): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private emit (e: CerebellumEvent, dedupeKey?: string): void {
    if (dedupeKey) {
      const prev = this.escalatedAt.get(dedupeKey) ?? 0
      if (Date.now() - prev < this.cfg.escalateCooldownMs) return
      this.escalatedAt.set(dedupeKey, Date.now())
    }
    log('cerebellum.escalate', { type: e.type, message: e.message, plan: e.plan, step: e.step })
    for (const fn of this.listeners) {
      try { fn(e) } catch (err) { log('cerebellum.hook_error', { message: String(err) }) }
    }
  }

  /** Is our run still the one holding the slot? */
  private owns (r: Running | null): r is Running {
    return !!r && !r.settled && (r.gen === null || r.gen === this.actions.currentGeneration)
  }

  /** Code-measured progress of a plan step. */
  private progress (step: PlanStep, inventory: Record<string, number>): StepProgress {
    const bot = this.body.bot
    switch (step.kind) {
      case 'gather': {
        const got = Math.max(0, countGathered(inventory, step.block) - this.baseline)
        const left = Math.max(0, step.count - got)
        return { text: left === 0 ? `gathered ${got} of ${step.count}, complete` : `gathered ${got} of ${step.count}, ${left} more needed`, complete: left === 0 }
      }
      case 'craft':
      case 'smelt': {
        const got = Math.max(0, stepOutputCount(step, inventory) - this.baseline)
        const left = Math.max(0, step.count - got)
        const verb = step.kind === 'craft' ? 'crafted' : 'smelted'
        return { text: left === 0 ? `${verb} ${got} of ${step.count}, complete` : `${verb} ${got} of ${step.count}, ${left} more needed`, complete: left === 0 }
      }
      case 'move_to': {
        const p = bot?.entity?.position
        if (!p) return { text: 'unknown', complete: false }
        const d = step.y === undefined ? Math.hypot(p.x - step.x, p.z - step.z) : Math.hypot(p.x - step.x, p.y - step.y, p.z - step.z)
        return { text: d <= 3 ? 'arrived' : `${howClose(d)} (${Math.round(d / 5) * 5} blocks to go)`, complete: d <= 3 }
      }
      case 'come_to_player': {
        const name = step.player ?? this.defaultPlayer
        const pl = bot?.players[name]
        if (!pl) return { text: `${name} is not online`, complete: false }
        const d = pl.entity && bot?.entity ? pl.entity.position.distanceTo(bot.entity.position) : null
        return { text: d !== null && d <= 4 ? `next to ${name}` : `${name} is ${howClose(d)}`, complete: d !== null && d <= 4 }
      }
      case 'wait': {
        const s = (Date.now() - this.stepStartedAt) / 1000
        return { text: s >= step.seconds ? 'waited long enough' : `waited ${Math.floor(s)} of ${step.seconds}s`, complete: s >= step.seconds }
      }
    }
  }

  private planBehavior (step: PlanStep | null): Behavior | null {
    if (!step) return null
    switch (step.kind) {
      case 'gather': return 'GATHER'
      case 'craft': return 'CRAFT'
      case 'smelt': return 'SMELT'
      case 'move_to': return 'MOVE_TO'
      case 'come_to_player': return 'COME_TO_PLAYER'
      case 'wait': return 'IDLE'
    }
  }

  private async tick (): Promise<void> {
    if (this.inFlight) { this.jev.skip('tick_in_flight'); return }
    const bot = this.body.bot
    if (!bot?.entity || bot.health <= 0) return
    // Reflexes are authoritative: never decide while one holds the slot.
    if (this.actions.slotReflex) { this.jev.skip('reflex'); return }

    // Settle bookkeeping for a plan step change.
    const step = this.plans.active
    const key = step ? `${this.plans.stepIndex}:${JSON.stringify(step)}` : ''
    if (key !== this.stepKey) {
      this.stepKey = key
      this.stepStartedAt = Date.now()
      this.baseline = step ? stepOutputCount(step, this.actions.state().inventory) : 0
      this.failures = 0
      this.infeasibleTicks = 0
      this.lowTicks = 0
      this.doneDisagreeLogged = false
      if (step) log('cerebellum.step', { index: this.plans.stepIndex, step: describeStep(step), baseline: this.baseline })
    }

    const snap = this.actions.state()
    if (step) {
      const prog = this.progress(step, snap.inventory)
      if (prog.complete) {
        log('cerebellum.step_done', { index: this.plans.stepIndex, step: describeStep(step), progress: prog.text, by: 'code' })
        if (this.owns(this.running) && this.running.stepIndex === this.plans.stepIndex && this.running.gen !== null) this.actions.cancel(this.running.gen)
        this.plans.advance()
        return
      }
    }

    // Who owns the slot right now?
    const mine = this.owns(this.running) ? this.running : null
    const externalBehavior = !mine && this.actions.activity !== 'idle' ? behaviorOfActivity(this.actions.activity) ?? 'IDLE' : null
    const external = externalBehavior !== null
    const current: Behavior = mine?.behavior ?? externalBehavior ?? 'IDLE'

    if (!external && this.resumeFollow && !mine) {
      const who = this.resumeFollow
      this.resumeFollow = null
      try { this.actions.follow(who, 3); log('cerebellum.resume_follow', { player: who }) } catch (e) { log('cerebellum.resume_follow', { player: who, error: errText(e) }) }
      return
    }

    // Options this tick, in BEHAVIORS order.
    const avail = new Set<Behavior>(['IDLE', current])
    const planned = external ? null : this.planBehavior(step)
    if (planned) avail.add(planned)
    const h = snap.nearestHostile
    // Not from a shelter (or while digging one): the flee path would dig us out.
    const hiding = this.actions.activity === SHELTER_ACTIVITY || isEnclosed(bot)
    if (h && AVOID_MOBS.has(h.name) && h.distance <= 10 && !hiding) avail.add('FLEE')
    const hungry = (snap.food ?? 20) <= 16 || ((snap.health ?? 20) <= 14 && (snap.food ?? 20) < 20)
    const hasFood = Object.keys(snap.inventory).some((n) => bot.registry.foodsByName[n] && n !== 'rotten_flesh')
    if (hungry && hasFood && !this.actions.sideReflex && !this.actions.handsBusy) avail.add('EAT')
    const options = BEHAVIORS.filter((b) => avail.has(b))

    // Nothing to decide: idle with no plan, or an outside command with no threat.
    if (options.length === 1 || (external && !avail.has('FLEE') && !avail.has('EAT'))) {
      this.jev.skip(external ? 'external' : 'idle')
      return
    }

    const prog = step ? this.progress(step, snap.inventory) : null
    const state = buildWorldState(bot, snap, this.botName, step ? this.plans.view() : null, prog, this.last)
    const fp = fingerprint(state, current)
    if (fp === this.lastFp && Date.now() - this.lastCallAt < this.cfg.maxStaleMs) { this.jev.skip('unchanged'); return }

    this.inFlight = true
    const stepIndex = this.plans.stepIndex
    const gen = this.actions.currentGeneration
    let answers
    try {
      const criteria = Object.fromEntries(options.map((b) => [b, DESCRIPTIONS[b]]))
      const { result } = await this.jev.ask('cerebellum', state as unknown as Record<string, unknown>, {
        behavior: choice({
          question: 'Which behavior should the Minecraft companion bot `bot_name` do next?',
          rules: [
            'When there is a `plan`, work on `plan.current_step` unless something in the state needs attention first.',
            'Fighting hostile mobs is handled automatically elsewhere; do not pick a behavior just because a mob that `bot_fights_it` is near.',
            'A creeper or warden close by is a reason to change.',
            'Otherwise keep doing the current `activity` unless there is a clear reason to change.'
          ]
        }, criteria),
        step_done: noul('Has the bot already finished `plan.current_step`, judging by `plan.progress`? If there is no plan, answer no.'),
        step_feasible: noul('Can the bot still carry out `plan.current_step`? Answer no only if the state shows it cannot, for example `last_action` says there is nothing left to mine nearby, or the player it must reach is not online. If there is no plan, answer yes.'),
        danger: noul('Is the bot in real danger right now: a creeper or warden close by, health badly hurt or worse, or starving with no food?')
      }, this.cfg.timeoutMs)
      answers = result.answers
      this.lastFp = fp
      this.lastCallAt = Date.now()
    } catch {
      return // logged by Jev; the next tick tries again
    } finally {
      this.inFlight = false
    }

    // The world may have moved on while we waited.
    if (this.actions.slotReflex || this.plans.stepIndex !== stepIndex || this.actions.currentGeneration !== gen) {
      log('cerebellum.stale_answer', { reason: this.actions.slotReflex ? 'reflex' : this.plans.stepIndex !== stepIndex ? 'step changed' : 'slot changed' })
      return
    }

    const probs = answers.behavior.probabilities as Record<string, number>
    const ranked = options.map((b) => [b, probs[b] ?? 0] as const).sort((a, b) => b[1] - a[1])
    const [top, pTop] = ranked[0] ?? ['IDLE', 0]
    const pCur = probs[current] ?? 0
    const danger = answers.danger.noul
    const urgent = danger >= this.cfg.dangerP && (top === 'FLEE' || top === 'EAT')
    let decision: 'continue' | 'switch' | 'hold' = 'continue'
    if (top !== current) {
      decision = (pTop >= this.cfg.switchP && pTop - pCur >= this.cfg.margin) || (urgent && pTop >= 0.4) ? 'switch' : 'hold'
    }
    log('cerebellum.decide', {
      current, top, p: round2(pTop), p_current: round2(pCur), decision, external,
      step: step ? describeStep(step) : null, progress: prog?.text ?? null,
      step_done: round2(answers.step_done.noul), feasible: round2(answers.step_feasible.noul), danger: round2(danger)
    })

    // Low confidence for N ticks in a row: Hermes should look.
    if (pTop < this.cfg.lowConfP) {
      if (++this.lowTicks >= this.cfg.lowConfTicks) {
        this.lowTicks = 0
        this.emit({ type: 'low_confidence', message: `unsure what to do next (top ${top} at ${round2(pTop)} for ${this.cfg.lowConfTicks} ticks)`, plan: this.plans.view()?.goal ?? null, step: step ? describeStep(step) : null, state }, `low:${this.stepKey}`)
      }
    } else this.lowTicks = 0

    if (step && !external) {
      if (answers.step_done.noul >= 0.9 && !prog?.complete && !this.doneDisagreeLogged) {
        this.doneDisagreeLogged = true
        log('cerebellum.done_disagree', { step: describeStep(step), progress: prog?.text, jev: round2(answers.step_done.noul) })
      }
      if (answers.step_feasible.noul < this.cfg.infeasibleP) {
        if (++this.infeasibleTicks >= this.cfg.infeasibleTicks) { this.infeasible(step, `Jev judged the step infeasible ${this.cfg.infeasibleTicks} times (${round2(answers.step_feasible.noul)})`, state); return }
      } else this.infeasibleTicks = 0
    }

    if (decision === 'switch') this.execute(top, step, external ? current : null)
  }

  private infeasible (step: PlanStep, why: string, state?: WorldState): void {
    if (this.owns(this.running) && this.running.gen !== null) this.actions.cancel(this.running.gen)
    this.plans.pause(`step infeasible: ${why}`)
    this.emit({ type: 'step_infeasible', message: `can't ${describeStep(step)}: ${why}`, plan: this.plans.view()?.goal ?? null, step: describeStep(step), state }, `infeasible:${this.stepKey}`)
  }

  /** Start a behavior's executor. Rejections are always caught and recorded. */
  private execute (b: Behavior, step: PlanStep | null, interrupting: Behavior | null): void {
    const prev = this.owns(this.running) ? this.running : null
    if (interrupting === 'FOLLOW_PLAYER' && b === 'FLEE') {
      const m = /^following (.+)$/.exec(this.actions.activity)
      if (m?.[1]) this.resumeFollow = m[1]
    }
    log('cerebellum.switch', { from: prev?.behavior ?? interrupting ?? 'IDLE', to: b, step: step ? describeStep(step) : null })
    const stepIndex = step ? this.plans.stepIndex : -1
    let promise: Promise<string> | null = null
    let gen: number | null = null
    try {
      switch (b) {
        case 'IDLE':
          if (prev?.gen != null) this.actions.cancel(prev.gen)
          this.running = null
          return
        case 'EAT':
          promise = this.actions.eat()
          break
        case 'FOLLOW_PLAYER':
          this.actions.follow(this.defaultPlayer, 3)
          gen = this.actions.currentGeneration
          break
        case 'COME_TO_PLAYER':
          promise = this.actions.comeTo(step?.kind === 'come_to_player' ? step.player ?? this.defaultPlayer : this.defaultPlayer, 3)
          gen = this.actions.currentGeneration
          break
        case 'GATHER': {
          if (step?.kind !== 'gather') return
          const got = Math.max(0, countGathered(this.actions.state().inventory, step.block) - this.baseline)
          promise = this.actions.mineBlock(step.block, Math.max(1, step.count - got), 48)
          gen = this.actions.currentGeneration
          break
        }
        case 'CRAFT': {
          if (step?.kind !== 'craft') return
          const got = Math.max(0, stepOutputCount(step, this.actions.state().inventory) - this.baseline)
          promise = this.actions.craft(step.item, Math.max(1, step.count - got))
          gen = this.actions.currentGeneration
          break
        }
        case 'SMELT': {
          if (step?.kind !== 'smelt') return
          const got = Math.max(0, stepOutputCount(step, this.actions.state().inventory) - this.baseline)
          // One furnace load at a time (10 s per item); the next tick continues.
          promise = this.actions.smelt(step.item, Math.min(SMELT_CHUNK, Math.max(1, step.count - got)), step.fuel)
          gen = this.actions.currentGeneration
          break
        }
        case 'MOVE_TO':
          if (step?.kind !== 'move_to') return
          promise = this.actions.goTo(step.x, step.y, step.z, 2)
          gen = this.actions.currentGeneration
          break
        case 'FLEE': {
          const bot = this.body.bot
          const mob = bot?.entity ? Object.values(bot.entities).filter((e) => AVOID_MOBS.has(e.name ?? '')).sort((a, c) => a.position.distanceTo(bot.entity.position) - c.position.distanceTo(bot.entity.position))[0] : undefined
          if (!mob) return
          promise = this.actions.fleeFrom(mob.position.clone(), mob.name ?? 'mob', 16)
          gen = this.actions.currentGeneration
          break
        }
      }
    } catch (e) {
      this.record(b, e)
      return
    }
    const run: Running = { behavior: b, gen: b === 'EAT' ? null : gen, settled: false, stepIndex }
    this.running = run
    this.last = { behavior: b, outcome: 'running', detail: '', at: Date.now() }
    if (!promise) return
    promise.then(
      (out) => { run.settled = true; this.last = { behavior: b, outcome: 'ok', detail: out, at: Date.now() }; log('cerebellum.outcome', { behavior: b, ok: true, detail: out }) },
      (e: unknown) => { run.settled = true; this.record(b, e, run.stepIndex) }
    )
  }

  private record (b: Behavior, e: unknown, stepIndex = this.plans.stepIndex): void {
    const msg = errText(e)
    // Interrupted by a reflex or busy: retry on a later tick, never an escalation.
    const transient = /^(interrupted by|busy:)/.test(msg)
    this.last = { behavior: b, outcome: transient ? 'interrupted' : 'failed', detail: msg, at: Date.now() }
    log('cerebellum.outcome', { behavior: b, ok: false, transient, detail: msg, expected: e instanceof ActionError })
    if (transient) return
    const step = this.plans.active
    if (!step || stepIndex !== this.plans.stepIndex) return
    // Missing materials or fuel won't fix themselves by retrying.
    if (/^dug \d+\/\d+ .*no more|^unknown (block|item)|is not online|no other player|^can't (craft|smelt)|^nothing came out|^need a tool/.test(msg)) {
      this.infeasible(step, msg)
    } else if (++this.failures >= 2) {
      this.plans.pause(`step failed twice: ${msg}`)
      this.emit({ type: 'step_failed', message: `${describeStep(step)} failed twice: ${msg}`, plan: this.plans.view()?.goal ?? null, step: describeStep(step) }, `failed:${this.stepKey}`)
    }
  }
}

/** Furnace loads per SMELT run: 24 items = 4 minutes. */
const SMELT_CHUNK = 24

/**
 * What a step's completion is measured in: gathered blocks plus their drops,
 * crafted items (`*` wildcard), or the smelt output (iron_ingot for raw_iron).
 */
export function stepOutputCount (step: PlanStep, inventory: Record<string, number>): number {
  switch (step.kind) {
    case 'gather': return countGathered(inventory, step.block)
    case 'craft': return countMatching(inventory, step.item)
    case 'smelt': {
      const out = smeltSpec(step.item)?.output
      return out ? inventory[out] ?? 0 : 0
    }
    default: return 0
  }
}

function errText (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function round2 (n: number): number {
  return Math.round(n * 100) / 100
}
