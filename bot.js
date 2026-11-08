const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 64290)
const NAME = process.env.MC_NAME || 'luna'
const VER = process.env.MC_VER || '26.1'
const CMDS = path.join(__dirname, 'data', 'cmds.jsonl')
const STATE = path.join(__dirname, 'data', 'state.json')
const EVENTS = path.join(__dirname, 'data', 'events.jsonl')

let offset = 0
try { offset = fs.statSync(CMDS).size } catch (e) {}
let bot = null
let stopping = false

function log (s) {
  const line = new Date().toISOString() + ' ' + s
  try { fs.appendFileSync(path.join(__dirname, 'data', 'bot.log'), line + '\n') } catch (e) {}
  console.log(line)
}

function writeState () {
  try {
    const p = bot && bot.entity ? bot.entity.position : null
    const players = bot && bot.players ? Object.keys(bot.players) : []
    const pos = {}
    if (bot && bot.entity && bot.players) {
      for (const [n, pl] of Object.entries(bot.players)) {
        if (pl.entity) pos[n] = { x: +pl.entity.position.x.toFixed(1), y: +pl.entity.position.y.toFixed(1), z: +pl.entity.position.z.toFixed(1), d: +pl.entity.position.distanceTo(bot.entity.position).toFixed(1) }
      }
    }
    fs.writeFileSync(STATE, JSON.stringify({
      at: Date.now(),
      connected: !!(bot && bot.entity),
      pos: p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null,
      players,
      positions: pos,
      health: bot && bot.health,
      food: bot && bot.food
    }))
  } catch (e) {}
}

function notify (sender, text) {
  const url = process.env.MC_WEBHOOK_URL
  const secret = process.env.MC_WEBHOOK_SECRET
  if (!url || !secret) return
  const body = JSON.stringify({ sender, text, at: Date.now() })
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Hub-Signature-256': sig }, body })
    .then((r) => { if (!r.ok) log('HOOK ' + r.status) })
    .catch((e) => log('HOOK err ' + e.message))
}

function start () {
  log('CONNECTING')
  bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline', version: VER })
  bot.loadPlugin(pathfinder)
  bot.once('login', () => { log('LOGIN ' + bot.username); offset = fs.existsSync(CMDS) ? fs.statSync(CMDS).size : 0 })
  bot.once('spawn', () => log('SPAWN ' + JSON.stringify(bot.entity && bot.entity.position)))
  bot.on('kicked', (r) => log('KICKED ' + JSON.stringify(r)))
  bot.on('error', (e) => log('ERROR ' + e.message))
  bot.on('chat', (u, m) => { if (u !== bot.username) log('CHAT <' + u + '> ' + m) })
  bot.on('messagestr', (m, pos, jsonMsg, sender) => {
    const myUuid = bot.player && bot.player.uuid
    if (!sender || sender === myUuid) return
    let name = sender
    for (const [n, pl] of Object.entries(bot.players || {})) {
      if (pl.uuid === sender) { name = n; break }
    }
    try { fs.appendFileSync(EVENTS, JSON.stringify({ t: Date.now(), sender: name, pos, text: m }) + '\n') } catch (e) {}
    notify(name, m)
  })
  bot.once('end', (reason) => {
    log('END ' + reason)
    bot = null
    if (!stopping) setTimeout(start, 3000)
  })
}

async function handle (c) {
  if (!bot || !bot.entity) throw new Error('not spawned')
  if (c.cmd === 'say') bot.chat(c.text)
  else if (c.cmd === 'look') {
    const p = bot.players[c.name || 'steve'] && bot.players[c.name || 'steve'].entity
    if (p) await bot.lookAt(p.position.offset(0, 1.6, 0), true)
  } else if (c.cmd === 'where') {
    const out = {}
    for (const [n, pl] of Object.entries(bot.players)) if (pl.entity) out[n] = { ...pl.entity.position, d: +pl.entity.position.distanceTo(bot.entity.position).toFixed(1) }
    log('WHERE ' + JSON.stringify(out))
  } else if (c.cmd === 'come') {
    const p = bot.players[c.name || 'steve'] && bot.players[c.name || 'steve'].entity
    if (p) bot.pathfinder.setGoal(new goals.GoalNear(p.position.x, p.position.y, p.position.z, 2), false)
  } else if (c.cmd === 'follow') {
    const p = bot.players[c.name || 'steve'] && bot.players[c.name || 'steve'].entity
    if (p) bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
  } else if (c.cmd === 'stop') bot.pathfinder.setGoal(null)
  else if (c.cmd === 'dig') {
    const b = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (b) await bot.dig(b)
  } else throw new Error('unknown cmd')
}

setInterval(writeState, 1000)

setInterval(async () => {
  if (!bot || !bot.entity) return
  let buf
  try { buf = fs.readFileSync(CMDS, 'utf8') } catch (e) { return }
  if (!buf) return
  if (offset > buf.length) offset = 0
  const fresh = buf.slice(offset)
  offset = buf.length
  for (const raw of fresh.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let c
    try { c = JSON.parse(line) } catch (e) { continue }
    try { await handle(c); log('CMD ok ' + line) } catch (e) { log('CMD err ' + line + ' :: ' + e.message) }
  }
}, 400)

process.on('SIGTERM', () => { stopping = true; if (bot) bot.end(); setTimeout(() => process.exit(0), 500) })
start()
