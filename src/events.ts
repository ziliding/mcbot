import { log } from './log.js'

/**
 * Escalations into the Matrix room (M5). Hermes is never polled: it only wakes
 * on room messages, so anything the brain should react to is posted by the
 * bot account as `[EVENT] …`. Every post wakes Hermes and costs an LLM turn,
 * so bursts are coalesced and the rate is capped:
 *
 * - events arriving within `coalesceMs` of the first one go out as one message;
 * - two messages are at least `minIntervalMs` apart (later events wait and merge);
 * - at most `maxPerMinute` messages in any rolling minute (also wait and merge).
 *
 * Nothing is dropped except duplicates and, past `maxLines`, the oldest lines
 * of one merged message (counted as "+N earlier").
 */

export type EventType = 'plan_done' | 'step_infeasible' | 'step_failed' | 'low_confidence' | 'died' | 'notable_find'

const LABEL: Record<EventType, string> = {
  plan_done: 'plan complete',
  step_infeasible: 'step stuck',
  step_failed: 'step failed',
  low_confidence: 'unsure',
  died: 'died',
  notable_find: 'notable find'
}

export interface EventReporterConfig {
  enabled: boolean
  coalesceMs: number
  minIntervalMs: number
  maxPerMinute: number
  maxLines: number
}

interface Pending { type: EventType, text: string, at: number }

export class EventReporter {
  private buffer: Pending[] = []
  private dropped = 0
  private timer: NodeJS.Timeout | null = null
  private lastSentAt = -Infinity
  private readonly sentAt: number[] = []

  constructor (
    private readonly cfg: EventReporterConfig,
    private readonly send: (body: string) => Promise<void>,
    /** Compact "now" context appended to every message (position, health, plan). */
    private readonly context: () => string,
    private readonly now: () => number = Date.now
  ) {}

  report (type: EventType, text: string): void {
    log('event.report', { type, text })
    if (!this.cfg.enabled) return
    if (this.buffer.some((p) => p.type === type && p.text === text)) return
    this.buffer.push({ type, text, at: this.now() })
    if (this.buffer.length > this.cfg.maxLines) {
      this.dropped += this.buffer.length - this.cfg.maxLines
      this.buffer = this.buffer.slice(-this.cfg.maxLines)
    }
    this.schedule(this.cfg.coalesceMs)
  }

  /** Earliest time the next message may go out under both limits. */
  private nextSlot (): number {
    const t = this.now()
    const cutoff = t - 60_000
    while (this.sentAt.length && (this.sentAt[0] ?? 0) <= cutoff) this.sentAt.shift()
    let at = Math.max(t, this.lastSentAt + this.cfg.minIntervalMs)
    if (this.sentAt.length >= this.cfg.maxPerMinute) {
      const oldest = this.sentAt[this.sentAt.length - this.cfg.maxPerMinute] ?? t
      at = Math.max(at, oldest + 60_000)
    }
    return at
  }

  private schedule (coalesceMs: number): void {
    if (this.timer) return // already waiting: the new event merges into that message
    const first = this.buffer[0]?.at ?? this.now()
    const at = Math.max(first + coalesceMs, this.nextSlot())
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, Math.max(0, at - this.now()))
  }

  private flush (): void {
    if (this.buffer.length === 0) return
    // Limits may have moved (a slot freed late): re-check before sending.
    if (this.nextSlot() > this.now()) { this.schedule(0); return }
    const items = this.buffer
    const dropped = this.dropped
    this.buffer = []
    this.dropped = 0
    const ctx = safe(this.context)
    let body: string
    if (items.length === 1 && dropped === 0) {
      const only = items[0] as Pending
      body = `[EVENT] ${LABEL[only.type]}: ${only.text}${ctx ? `\n  now: ${ctx}` : ''}`
    } else {
      const lines = items.map((p) => `- ${LABEL[p.type]}: ${p.text}`)
      if (dropped) lines.unshift(`- (+${dropped} earlier events not shown)`)
      body = `[EVENT] ${items.length + dropped} events:\n${lines.join('\n')}${ctx ? `\n  now: ${ctx}` : ''}`
    }
    const t = this.now()
    this.lastSentAt = t
    this.sentAt.push(t)
    log('event.post', { events: items.length + dropped, types: items.map((p) => p.type), chars: body.length })
    this.send(body).catch((e: unknown) => log('event.send_error', { message: String(e) }))
  }

  /** Send anything still buffered right away (shutdown, tests). */
  flushNow (): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.lastSentAt = -Infinity
    this.sentAt.length = 0
    this.flush()
  }
}

function safe (fn: () => string): string {
  try { return fn() } catch (e) { return `(context unavailable: ${String(e)})` }
}
