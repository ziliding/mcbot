import type { CerebellumConfig } from './cerebellum.js'
import type { EventReporterConfig } from './events.js'
import type { JevConfig } from './jev.js'
import type { LookoutConfig } from './lookout.js'
import type { TriageConfig } from './triage.js'

function env (name: string, fallback?: string): string {
  const v = process.env[name]
  if (v !== undefined && v !== '') return v
  if (fallback !== undefined) return fallback
  throw new Error(`missing required env var ${name}`)
}

function list (name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export interface MatrixConfig {
  homeserver: string
  accessToken: string
  /** Room id (!abc:server) or alias (#room:server). */
  room: string
  /** Matrix user ids whose messages are spoken in game. Empty = anyone in the room except the bot. */
  allowedSenders: string[]
  /** Overrides the built-in progress-bubble filter: matching messages are not spoken. */
  ignorePattern: RegExp | null
}

function num (name: string, fallback: number): number {
  const v = Number(process.env[name] ?? '')
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback
}

function flag (name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? '').toLowerCase()
  if (v === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(v)
}

export interface Config {
  mc: { host: string, port: number, username: string, version: string }
  /** Player that come/follow/look target when no name is given. */
  defaultPlayer: string
  matrix: MatrixConfig | null
  /** MCP over Streamable HTTP; null when MCP_TOKEN is unset (server stays off). */
  mcp: { port: number, token: string } | null
  /** Jev (TypeSafe); null when JEV_API is unset: cerebellum and triage stay off. */
  jev: JevConfig | null
  cerebellum: (CerebellumConfig & { enabled: boolean, plan: string | null })
  triage: TriageConfig & { enabled: boolean }
  /** `[EVENT]` escalations into the Matrix room (M5). */
  events: EventReporterConfig
  /** Rare-ore "notable find" events. */
  lookout: LookoutConfig
}

export function loadConfig (): Config {
  const token = process.env.MATRIX_ACCESS_TOKEN
  const room = process.env.MATRIX_ROOM
  return {
    mc: {
      host: env('MC_HOST', 'mc'),
      port: Number(env('MC_PORT', '25565')),
      username: env('MC_NAME', 'mcbot'),
      version: env('MC_VER', '26.1')
    },
    defaultPlayer: env('MC_DEFAULT_PLAYER', 'steve'),
    matrix: token && room
      ? {
          homeserver: env('MATRIX_HOMESERVER', 'http://tailscale:6167').replace(/\/+$/, ''),
          accessToken: token,
          room,
          allowedSenders: list('MATRIX_ALLOWED_SENDERS'),
          ignorePattern: process.env.MATRIX_IGNORE_REGEX ? new RegExp(process.env.MATRIX_IGNORE_REGEX, 'u') : null
        }
      : null,
    mcp: process.env.MCP_TOKEN ? { port: Number(env('MCP_PORT', '3333')), token: process.env.MCP_TOKEN } : null,
    jev: process.env.JEV_API
      ? {
          apiKey: process.env.JEV_API,
          model: env('JEV_MODEL', 'jev-1.14.0'),
          pricePerMtok: num('JEV_PRICE_PER_MTOK', 0.042),
          summaryEveryMs: num('JEV_USAGE_LOG_MS', 300_000)
        }
      : null,
    cerebellum: {
      enabled: flag('CEREBELLUM_ENABLED', true),
      plan: process.env.CEREBELLUM_PLAN || null,
      tickMs: num('CEREBELLUM_TICK_MS', 1000),
      timeoutMs: num('CEREBELLUM_TIMEOUT_MS', 800),
      switchP: num('CEREBELLUM_SWITCH_P', 0.6),
      margin: num('CEREBELLUM_MARGIN', 0.25),
      lowConfP: num('CEREBELLUM_LOW_CONF_P', 0.5),
      lowConfTicks: num('CEREBELLUM_LOW_CONF_TICKS', 5),
      infeasibleP: num('CEREBELLUM_INFEASIBLE_P', 0.2),
      infeasibleTicks: num('CEREBELLUM_INFEASIBLE_TICKS', 3),
      dangerP: num('CEREBELLUM_DANGER_P', 0.7),
      maxStaleMs: num('CEREBELLUM_MAX_STALE_MS', 10_000),
      escalateCooldownMs: num('CEREBELLUM_ESCALATE_COOLDOWN_MS', 120_000)
    },
    triage: {
      enabled: flag('TRIAGE_ENABLED', true),
      timeoutMs: num('TRIAGE_TIMEOUT_MS', 1000),
      addressedP: num('TRIAGE_ADDRESSED_P', 0.6),
      commandP: num('TRIAGE_COMMAND_P', 0.9)
    },
    events: {
      enabled: flag('EVENTS_ENABLED', true),
      coalesceMs: num('EVENT_COALESCE_MS', 3000),
      minIntervalMs: num('EVENT_MIN_INTERVAL_MS', 20_000),
      maxPerMinute: num('EVENT_MAX_PER_MIN', 3),
      maxLines: num('EVENT_MAX_LINES', 6)
    },
    lookout: {
      blocks: process.env.EVENT_FIND_BLOCKS !== undefined ? list('EVENT_FIND_BLOCKS') : ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris'],
      radius: num('EVENT_FIND_RADIUS', 16),
      everyMs: num('EVENT_FIND_EVERY_MS', 10_000)
    }
  }
}
