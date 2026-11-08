import { randomUUID } from 'node:crypto'
import type { MatrixConfig } from './config.js'
import { log } from './log.js'
import { sleep } from './body.js'

interface RoomEvent {
  type: string
  redacts?: string
  event_id: string
  sender: string
  content: {
    msgtype?: string
    body?: string
    'm.new_content'?: { body?: string }
    'm.relates_to'?: { rel_type?: string, event_id?: string }
  }
}

interface SyncResponse {
  next_batch: string
  rooms?: { join?: Record<string, { timeline?: { events?: RoomEvent[] } }> }
}

export interface MatrixMessage {
  sender: string
  body: string
}

/**
 * Minimal Matrix client-server API client: joins one room, long-polls /sync
 * and hands finished messages to `onMessage`. No SDK, no E2EE: use an
 * unencrypted room for the bot.
 */
export class MatrixBridge {
  userId = ''
  roomId = ''
  private stopped = false
  /** Messages that may still be edited (streamed replies), keyed by original event id. */
  private readonly pending = new Map<string, { sender: string, body: string, timer: NodeJS.Timeout }>()
  private warnedEncrypted = false

  constructor (
    private readonly cfg: MatrixConfig,
    private readonly onMessage: (msg: MatrixMessage) => void,
    /** Wait this long after the last edit before treating a message as final. */
    private readonly settleMs = 1500
  ) {}

  async start (): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const who = await this.api<{ user_id: string }>('GET', '/account/whoami')
        this.userId = who.user_id
        const joined = await this.api<{ room_id: string }>('POST', `/join/${encodeURIComponent(this.cfg.room)}`, {})
        this.roomId = joined.room_id
        log('matrix.ready', { userId: this.userId, roomId: this.roomId })
        break
      } catch (e) {
        log('matrix.init_error', { message: errMsg(e), attempt })
        await sleep(Math.min(5000 * 2 ** attempt, 60_000))
      }
    }
    void this.syncLoop()
  }

  stop (): void {
    this.stopped = true
  }

  async send (body: string): Promise<void> {
    if (!this.roomId) { log('matrix.send_dropped', { reason: 'not joined', body }); return }
    const txn = randomUUID()
    try {
      await this.api('PUT', `/rooms/${encodeURIComponent(this.roomId)}/send/m.room.message/${txn}`, { msgtype: 'm.text', body })
    } catch (e) {
      log('matrix.send_error', { message: errMsg(e) })
    }
  }

  private async syncLoop (): Promise<void> {
    const filter = JSON.stringify({
      presence: { types: [] },
      account_data: { types: [] },
      room: {
        rooms: [this.roomId],
        timeline: { limit: 20 },
        state: { lazy_load_members: true },
        ephemeral: { types: [] },
        account_data: { types: [] }
      }
    })
    let since: string | undefined
    let backoff = 2000
    while (!this.stopped) {
      try {
        const q = new URLSearchParams({ filter, timeout: since ? '30000' : '0' })
        if (since) q.set('since', since)
        const res = await this.api<SyncResponse>('GET', `/sync?${q.toString()}`, undefined, 45_000)
        // The first sync only establishes a position: don't replay old history into the game.
        if (since) this.handleTimeline(res.rooms?.join?.[this.roomId]?.timeline?.events ?? [])
        since = res.next_batch
        backoff = 2000
      } catch (e) {
        log('matrix.sync_error', { message: errMsg(e), backoffMs: backoff })
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  private handleTimeline (events: RoomEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'm.room.encrypted' && !this.warnedEncrypted) {
        this.warnedEncrypted = true
        log('matrix.encrypted_room', { hint: 'this bridge cannot read E2EE rooms; use an unencrypted room' })
      }
      // Hermes deletes its transient progress bubbles; drop them if not yet spoken.
      if (ev.type === 'm.room.redaction' && ev.redacts && this.pending.has(ev.redacts)) {
        clearTimeout(this.pending.get(ev.redacts)?.timer)
        this.pending.delete(ev.redacts)
        log('matrix.dropped', { reason: 'redacted', eventId: ev.redacts })
        continue
      }
      if (ev.type !== 'm.room.message' || ev.sender === this.userId) continue
      if (this.cfg.allowedSenders.length > 0 && !this.cfg.allowedSenders.includes(ev.sender)) continue
      const { msgtype } = ev.content
      if (msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote') continue

      const rel = ev.content['m.relates_to']
      if (rel?.rel_type === 'm.replace' && rel.event_id) {
        const body = ev.content['m.new_content']?.body
        if (body !== undefined) this.upsert(rel.event_id, ev.sender, body)
      } else if (ev.content.body !== undefined) {
        this.upsert(ev.event_id, ev.sender, ev.content.body)
      }
    }
  }

  /** Hermes may stream a reply by editing one message; only forward it once edits stop. */
  private upsert (eventId: string, sender: string, body: string): void {
    const prev = this.pending.get(eventId)
    if (prev) clearTimeout(prev.timer)
    const timer = setTimeout(() => {
      const p = this.pending.get(eventId)
      this.pending.delete(eventId)
      if (!p) return
      // Code blocks are never speakable in game chat (tool logs, commands).
      const spoken = p.body.replace(/```[\s\S]*?(?:```|$)/g, '').trim()
      if (!spoken || this.isNoise(spoken)) { log('matrix.dropped', { reason: 'progress', body: p.body.slice(0, 80) }); return }
      this.onMessage({ sender: p.sender, body: spoken })
    }, this.settleMs)
    this.pending.set(eventId, { sender, body, timer })
  }

  /**
   * Hermes tool-progress bubbles ("📚 Reading skill x", "💻 Running code (×2)"):
   * every line is emoji + label, with no sentence punctuation. Replies, even
   * ones starting with an emoji, have punctuation somewhere.
   */
  private isNoise (body: string): boolean {
    if (this.cfg.ignorePattern) return this.cfg.ignorePattern.test(body)
    // Bubbles may quote the tool's arguments after an identifier-like label
    // (`⚙️ mcp__minecraft__say: "全杀？…"`). The quoted text is not the reply,
    // so its punctuation must not count.
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/^((?:┊\s*)?\p{Extended_Pictographic}\uFE0F?\s+[\w.\-]+(?:\s*\(×\d+\))?)(?:\.\.\.|…)?:\s*["“'].*$/u, '$1'))
    // Truncated previews end in "..." / "…"; that is not sentence punctuation.
    const text = lines.join('\n').replace(/(?:\.\.\.|…)(?=\s|$)/gu, '')
    return lines.length > 0 &&
      lines.every((l) => /^(?:┊\s*)?\p{Extended_Pictographic}\uFE0F?\s+\S/u.test(l)) &&
      !/[。！？，、!?]|[.,](?:\s|$)/u.test(text)
  }

  private async api<T = unknown> (method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(`${this.cfg.homeserver}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 200)}`)
    return (text ? JSON.parse(text) : {}) as T
  }
}

function errMsg (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
