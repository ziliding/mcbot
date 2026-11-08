import { Body } from './body.js'
import { loadConfig } from './config.js'
import { startLegacyQueue } from './legacyQueue.js'
import { log } from './log.js'
import { MatrixBridge } from './matrix.js'

const cfg = loadConfig()
const body = new Body(cfg.mc)

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

startLegacyQueue(body, cfg.dataDir, cfg.defaultPlayer)
body.start()

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('shutdown', { sig })
    matrix?.stop()
    body.stop()
    setTimeout(() => process.exit(0), 500)
  })
}
