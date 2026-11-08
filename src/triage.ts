import { choice, noul } from '@typesafe-ai/sdk'
import type { Jev } from './jev.js'
import { log } from './log.js'

/** Commands simple enough to answer without Hermes. */
export type LocalCommand = 'follow' | 'come' | 'stop' | 'wait'

export interface TriageConfig {
  timeoutMs: number
  /** Jev "addressed to the bot?" must reach this. */
  addressedP: number
  /** Jev's probability for the command must reach this. */
  commandP: number
}

export interface TriageResult {
  route: 'local' | 'forward'
  command: LocalCommand | null
  /** What decided: Jev (on top of the grammar), the grammar alone (Jev slow/down), or the grammar's veto. */
  by: 'jev' | 'rules' | 'guard'
  reason: string
}

/**
 * Exact grammar for the local commands, applied to the message after filler
 * words are stripped. A local answer means Hermes never sees the line, so this
 * is deliberately narrow: no questions, negations or compound requests, and
 * nothing beyond the command itself. Jev can only veto a guard match, never
 * widen it.
 */
const GRAMMAR: Array<[LocalCommand, RegExp]> = [
  ['follow', /^(follow|follow along|come with|come along)$/],
  ['come', /^(come|come over|come back)$/],
  ['stop', /^(stop|stop it|stop that|stop following|halt)$/],
  ['wait', /^(wait|stay|stay put|hold on)$/]
]
const FILLER = new Set(['please', 'pls', 'plz', 'hey', 'ok', 'okay', 'now', 'me', 'here', 'there', 'us', 'right', 'can', 'you'])

/** The command a message is, by grammar alone, or null. Exported for tests. */
export function grammarCommand (text: string, botName: string): { command: LocalCommand | null, named: boolean } {
  const lower = text.toLowerCase().trim()
  if (lower.length > 48 || /[?]/.test(lower)) return { command: null, named: false }
  const name = botName.toLowerCase()
  let named = false
  const words = lower.replace(/[!.,:;~]+/g, ' ').split(/\s+/).filter(Boolean).filter((w) => {
    const bare = w.replace(/^@/, '')
    if (bare === name) { named = true; return false }
    return !FILLER.has(bare)
  })
  const rest = words.join(' ')
  for (const [cmd, re] of GRAMMAR) if (re.test(rest)) return { command: cmd, named }
  return { command: null, named }
}

/**
 * Decides whether a game chat line is a simple command the body can handle
 * itself (follow / come / stop / wait) or must go to Hermes. Fails open:
 * anything uncertain, slow or broken is forwarded.
 */
export class Triage {
  constructor (private readonly jev: Jev, private readonly cfg: TriageConfig, private readonly botName: string) {}

  async classify (player: string, text: string, othersOnline: string[]): Promise<TriageResult> {
    const g = grammarCommand(text, this.botName)
    // With other people around, an unnamed "stop" may be meant for them.
    const crowd = othersOnline.filter((n) => n !== player).length > 0
    let result: TriageResult
    if (!g.command) {
      result = { route: 'forward', command: null, by: 'guard', reason: 'not a bare follow/come/stop/wait command' }
    } else {
      result = await this.askJev(player, text, othersOnline, g.command, crowd && !g.named)
    }
    log('triage', { player, text, route: result.route, command: result.command, by: result.by, reason: result.reason })
    return result
  }

  private async askJev (player: string, text: string, online: string[], guard: LocalCommand, crowdUnnamed: boolean): Promise<TriageResult> {
    try {
      const { result } = await this.jev.ask('triage', {
        bot_name: this.botName,
        speaker: player,
        message: text,
        // Who else could the speaker be talking to? Jev reads lists, not counts.
        others_who_can_hear: [`${this.botName} (the companion bot)`, ...online.filter((n) => n !== player && n !== this.botName)],
        setting: 'Minecraft game chat on a small private server'
      }, {
        addressed: noul('Is `message` meant for the bot `bot_name`? It is, when it names the bot, or when it is an instruction and the bot is the only one in `others_who_can_hear`.'),
        command: choice('Which simple command is `message`, if it is only that command and nothing else is asked?', {
          follow: 'Follow the speaker around / come along with them.',
          come: 'Walk over to the speaker once.',
          stop: 'Stop what it is doing.',
          wait: 'Wait / stay where it is.',
          none: 'Anything else: a question, chatter, a complex or combined request, or a command for someone else.'
        })
      }, this.cfg.timeoutMs)
      const a = result.answers
      const pCmd = (a.command.probabilities as Record<string, number>)[guard] ?? 0
      const addressed = a.addressed.noul
      const need = crowdUnnamed ? Math.max(this.cfg.addressedP, 0.85) : this.cfg.addressedP
      if (a.command.choice === guard && pCmd >= this.cfg.commandP && addressed >= need) {
        return { route: 'local', command: guard, by: 'jev', reason: `jev ${guard} ${pCmd.toFixed(2)}, addressed ${addressed.toFixed(2)}` }
      }
      return { route: 'forward', command: null, by: 'jev', reason: `jev ${a.command.choice} ${pCmd.toFixed(2)} for ${guard}, addressed ${addressed.toFixed(2)}` }
    } catch (e) {
      // Jev slow or down: the exact grammar alone, still conservative.
      const ok = !crowdUnnamed
      return { route: ok ? 'local' : 'forward', command: ok ? guard : null, by: 'rules', reason: `jev unavailable (${e instanceof Error ? e.name : 'error'})` }
    }
  }
}
