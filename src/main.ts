import { Actions } from './actions.js'
import { Body } from './body.js'
import { loadConfig } from './config.js'
import { log } from './log.js'
import { MatrixBridge } from './matrix.js'
import { startMcpServer } from './mcp.js'
import { Reflexes } from './reflexes.js'

const cfg = loadConfig()
const body = new Body(cfg.mc)
const actions = new Actions(body, cfg.defaultPlayer)
// Self-preservation (fight, eat, escape, armor): pure code, every tick, no LLM.
new Reflexes(body, actions)

let matrix: MatrixBridge | null = null
if (cfg.matrix) {
  // Matrix -> game: whatever Hermes says in the room is spoken in game chat.
  matrix = new MatrixBridge(cfg.matrix, (msg) => {
    log('bridge.matrix_to_game', { sender: msg.sender, chars: msg.body.length })
    body.say(msg.body)
  })
  void matrix.start()
} else {
  log('matrix.disabled', { reason: 'MATRIX_ACCESS_TOKEN or MATRIX_ROOM not set' })
}

// Game -> Matrix: other players' chat lines, prefixed so Hermes knows the source.
body.on('playerChat', ({ player, text }) => {
  log('bridge.game_to_matrix', { player, chars: text.length })
  void matrix?.send(`[MC] ${player}: ${text}`)
})

// MCP tools for Hermes: same process, same bot.
const mcp = cfg.mcp ? startMcpServer(actions, cfg.mcp.port, cfg.mcp.token) : null
if (!cfg.mcp) log('mcp.disabled', { reason: 'MCP_TOKEN not set' })
body.start()

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('shutdown', { sig })
    matrix?.stop()
    mcp?.close()
    body.stop()
    setTimeout(() => process.exit(0), 500)
  })
}
