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
}

export interface Config {
  mc: { host: string, port: number, username: string, version: string }
  /** Player the legacy queue's come/follow/look commands target by default. */
  defaultPlayer: string
  matrix: MatrixConfig | null
  dataDir: string
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
          allowedSenders: list('MATRIX_ALLOWED_SENDERS')
        }
      : null,
    dataDir: env('DATA_DIR', new URL('../data', import.meta.url).pathname)
  }
}
