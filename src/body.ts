import { EventEmitter } from 'node:events'
import mineflayer, { type Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import type { Config } from './config.js'
import { log } from './log.js'

const { pathfinder } = pathfinderPkg

export interface PlayerChat {
  player: string
  text: string
}

interface BodyEvents {
  playerChat: [PlayerChat]
  spawn: [Bot]
}

/**
 * Owns the single mineflayer bot instance and reconnects it when the
 * connection drops. Everything else (Matrix bridge, MCP, cerebellum) goes
 * through this object instead of creating bots of its own.
 */
export class Body extends EventEmitter<BodyEvents> {
  bot: Bot | null = null
  private stopping = false
  private retryMs = 3000
  private readonly outbox: string[] = []
  private sending = false

  constructor (private readonly cfg: Config['mc']) {
    super()
  }

  get ready (): boolean {
    return this.bot?.entity != null
  }

  start (): void {
    log('mc.connecting', { host: this.cfg.host, port: this.cfg.port, version: this.cfg.version })
    const bot = mineflayer.createBot({
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      auth: 'offline',
      version: this.cfg.version,
      hideErrors: true
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)

    bot.once('spawn', () => {
      this.retryMs = 3000
      log('mc.spawn', { pos: bot.entity.position })
      this.emit('spawn', bot)
    })
    bot.on('kicked', (reason) => log('mc.kicked', { reason }))
    bot.on('error', (e) => log('mc.error', { message: e.message }))
    bot.on('death', () => log('mc.death'))
    // mineflayer passes (message, position, jsonMsg, sender, verified) at
    // runtime, but its typings omit `sender`.
    const onMessage = (message: string, position: string, _json: unknown, sender?: string): void => {
      const chat = this.parsePlayerChat(bot, message, position, sender)
      if (chat) this.emit('playerChat', chat)
    }
    bot.on('messagestr', onMessage as (message: string, position: string, jsonMsg: unknown) => void)
    bot.once('end', (reason) => {
      log('mc.end', { reason, retryMs: this.retryMs })
      if (this.bot === bot) this.bot = null
      if (this.stopping) return
      setTimeout(() => this.start(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 60_000)
    })
  }

  stop (): void {
    this.stopping = true
    this.bot?.end()
  }

  /**
   * Returns a chat line typed by another player, or null for the bot's own
   * messages and for system/death/join/advancement lines.
   */
  private parsePlayerChat (bot: Bot, message: string, position: string, sender: string | undefined): PlayerChat | null {
    if (position !== 'chat' || !sender) return null
    if (sender === bot.player?.uuid) return null

    let player: string | undefined
    for (const [name, p] of Object.entries(bot.players)) {
      if (p.uuid === sender) { player = name; break }
    }
    // Vanilla formats player chat as "<name> text".
    const m = /^<([^>]+)> ([\s\S]*)$/.exec(message)
    if (m) {
      player ??= m[1]
      message = m[2] ?? ''
    }
    // Guard against our own echo even if the uuid lookup failed.
    if (player === undefined || player === bot.username) return null
    const text = message.trim()
    return text ? { player, text } : null
  }

  /**
   * Speaks text in game chat: splits on newlines and the 256-char limit,
   * paces lines so the server's spam filter doesn't kick us, and never lets
   * a line start with "/" (that would run a command as the bot).
   */
  say (text: string, maxLines = 8): void {
    const lines: string[] = []
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/[\u0000-\u001f\u007f§]/g, '').trim()
      while (line.length > 0) {
        lines.push(line.slice(0, 250))
        line = line.slice(250)
      }
    }
    if (lines.length > maxLines) {
      lines.length = maxLines
      lines[maxLines - 1] = (lines[maxLines - 1] ?? '').slice(0, 246) + ' ...'
    }
    for (const l of lines) this.outbox.push(l.startsWith('/') ? ' ' + l : l)
    void this.drain()
  }

  private async drain (): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      while (this.outbox.length > 0) {
        if (!this.ready || !this.bot) { await sleep(1000); continue }
        const line = this.outbox.shift()
        if (line !== undefined) this.bot.chat(line)
        await sleep(700)
      }
    } finally {
      this.sending = false
    }
  }
}

export function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
