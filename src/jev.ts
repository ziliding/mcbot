import { TypeSafeClient, type Questions, type SystemOneResult } from '@typesafe-ai/sdk'
import { log } from './log.js'

export interface JevConfig {
  apiKey: string
  /** Pinned model id: thresholds are tuned against one version, not an alias. */
  model: string
  /** USD per million input tokens (output tokens are free). */
  pricePerMtok: number
  /** How often to log the rolling usage summary. */
  summaryEveryMs: number
}

interface Sample { at: number, tokens: number, purpose: string }

/**
 * Thin wrapper around the TypeSafe SDK: one place for the API key, model pin,
 * per-call timeout, logging (latency, tokens, cost) and a rolling one-hour
 * usage total. Callers pass their own timeout; there are no SDK retries, a
 * late answer is worse than none for a 1 Hz loop or a chat line.
 */
export class Jev {
  private readonly client: TypeSafeClient
  private readonly hour: Sample[] = []
  private totals = { requests: 0, errors: 0, tokens: 0 }
  private readonly skipped: Record<string, number> = {}
  private readonly timer: NodeJS.Timeout

  constructor (private readonly cfg: JevConfig) {
    this.client = new TypeSafeClient({
      apiKey: cfg.apiKey,
      defaultModel: cfg.model,
      retry: { maxRetries: 0 },
      // 'debug' would log request bodies; keep it quiet.
      logLevel: 'warn'
    })
    this.timer = setInterval(() => this.summary(), cfg.summaryEveryMs)
    this.timer.unref()
  }

  /** Count a call that was avoided (state unchanged, idle, reflex busy). */
  skip (purpose: string): void {
    this.skipped[purpose] = (this.skipped[purpose] ?? 0) + 1
  }

  async ask<const Q extends Questions> (purpose: string, state: Record<string, unknown>, questions: Q, timeoutMs: number): Promise<{ result: SystemOneResult<Q>, ms: number }> {
    const started = Date.now()
    this.totals.requests++
    try {
      const result = await this.client.systemOne({ state: state as never, questions }, { timeout: timeoutMs, retry: { maxRetries: 0 } })
      const ms = Date.now() - started
      const tokens = result.usage.input_tokens ?? 0
      this.totals.tokens += tokens
      this.hour.push({ at: Date.now(), tokens, purpose })
      log('jev.answer', { purpose, ms, model: result.model, tokens, usd: round6(this.usd(tokens)), answers: compact(result.answers as Record<string, unknown>) })
      return { result, ms }
    } catch (e) {
      this.totals.errors++
      log('jev.error', { purpose, ms: Date.now() - started, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
      throw e
    }
  }

  private usd (tokens: number): number {
    return tokens * this.cfg.pricePerMtok / 1_000_000
  }

  /** Requests, tokens and dollars over the last hour, by purpose. */
  lastHour (): { requests: number, tokens: number, usd: number, byPurpose: Record<string, { requests: number, tokens: number }> } {
    const cutoff = Date.now() - 3_600_000
    while (this.hour[0] && this.hour[0].at < cutoff) this.hour.shift()
    const byPurpose: Record<string, { requests: number, tokens: number }> = {}
    let tokens = 0
    for (const s of this.hour) {
      tokens += s.tokens
      const p = byPurpose[s.purpose] ?? (byPurpose[s.purpose] = { requests: 0, tokens: 0 })
      p.requests++
      p.tokens += s.tokens
    }
    return { requests: this.hour.length, tokens, usd: round6(this.usd(tokens)), byPurpose }
  }

  summary (): void {
    const h = this.lastHour()
    log('jev.usage', {
      hour_requests: h.requests,
      hour_tokens: h.tokens,
      hour_usd: h.usd,
      hour_by_purpose: h.byPurpose,
      total_requests: this.totals.requests,
      total_errors: this.totals.errors,
      total_tokens: this.totals.tokens,
      total_usd: round6(this.usd(this.totals.tokens)),
      skipped: { ...this.skipped }
    })
  }

  close (): void {
    clearInterval(this.timer)
    this.summary()
  }
}

/** Answers without the `type` noise, probabilities rounded: keeps log lines short. */
function compact (answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(answers)) {
    const a = v as { type: string, noul?: number, choice?: string, probabilities?: Record<string, number> }
    if (a.type === 'noul') out[k] = a.noul
    else if (a.type === 'choice' && a.probabilities) {
      const probs = Object.fromEntries(Object.entries(a.probabilities).filter(([, p]) => p >= 0.01).map(([o, p]) => [o, Math.round(p * 100) / 100]))
      out[k] = probs
    } else out[k] = v
  }
  return out
}

function round6 (n: number): number {
  return Math.round(n * 1e6) / 1e6
}
