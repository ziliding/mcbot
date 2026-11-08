import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

/**
 * Pure item knowledge shared by the reflexes and the MCP verbs: which food is
 * worth eating, which weapon hits hardest, where armor goes.
 */

/** Foods that poison, teleport or otherwise hurt; eaten only when starving. */
export const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])

/** Best food in the inventory by effective quality, or null. */
export function bestFood (bot: Bot, allowBad: boolean): Item | null {
  const foods = bot.registry.foodsByName
  let best: Item | null = null
  let bestQ = -Infinity
  for (const it of bot.inventory.items()) {
    const f = foods[it.name]
    if (!f) continue
    if (BAD_FOODS.has(it.name) && !allowBad) continue
    // Golden apples are for emergencies, not snacks.
    const q = it.name.includes('golden_apple') ? -1 : f.effectiveQuality - (BAD_FOODS.has(it.name) ? 100 : 0)
    if (q > bestQ) { best = it; bestQ = q }
  }
  return best
}

const SWORD_DAMAGE: Record<string, number> = { wooden: 4, golden: 4, stone: 5, copper: 5, iron: 6, diamond: 7, netherite: 8 }
const AXE_DAMAGE: Record<string, number> = { wooden: 7, golden: 7, stone: 9, copper: 9, iron: 9, diamond: 9, netherite: 10 }
const AXE_SPEED: Record<string, number> = { wooden: 0.8, golden: 1, stone: 0.8, copper: 0.8, iron: 0.9, diamond: 1, netherite: 1 }

function weaponStats (name: string): { damage: number, speed: number } | null {
  const [material, kind] = name.split('_') as [string, string | undefined]
  if (kind === 'sword') return { damage: SWORD_DAMAGE[material] ?? 4, speed: 1.6 }
  if (kind === 'axe') return { damage: AXE_DAMAGE[material] ?? 7, speed: AXE_SPEED[material] ?? 0.8 }
  return null
}

/** Best melee weapon (by damage per second) in the inventory, or null. */
export function bestWeapon (bot: Bot): Item | null {
  let best: Item | null = null
  let bestDps = 0
  for (const it of bot.inventory.items()) {
    const s = weaponStats(it.name)
    if (s && s.damage * s.speed > bestDps) { best = it; bestDps = s.damage * s.speed }
  }
  return best
}

/** Milliseconds until a full-strength hit with the held item. */
export function attackCooldownMs (held: Item | null): number {
  const s = held ? weaponStats(held.name) : null
  return Math.ceil(1000 / (s?.speed ?? 4))
}

export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet'
const ARMOR_SUFFIX: Array<[string, ArmorSlot]> = [['_helmet', 'head'], ['_chestplate', 'torso'], ['_leggings', 'legs'], ['_boots', 'feet']]
const ARMOR_MATERIAL: Record<string, number> = { leather: 1, golden: 2, chainmail: 3, copper: 3, iron: 4, turtle: 4, diamond: 5, netherite: 6 }

export function armorSlot (name: string): ArmorSlot | null {
  if (name === 'turtle_helmet') return 'head'
  for (const [suffix, slot] of ARMOR_SUFFIX) if (name.endsWith(suffix)) return slot
  return null
}

export function armorRank (name: string): number {
  return ARMOR_MATERIAL[name.split('_')[0] ?? ''] ?? 0
}

/** Armor pieces in the inventory that beat what is worn in their slot. */
export function armorUpgrades (bot: Bot): Array<{ item: Item, slot: ArmorSlot }> {
  const best = new Map<ArmorSlot, Item>()
  for (const it of bot.inventory.items()) {
    const slot = armorSlot(it.name)
    if (!slot) continue
    const cur = best.get(slot)
    if (!cur || armorRank(it.name) > armorRank(cur.name)) best.set(slot, it)
  }
  const out: Array<{ item: Item, slot: ArmorSlot }> = []
  for (const [slot, item] of best) {
    const worn = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
    if (!worn || armorRank(item.name) > armorRank(worn.name)) out.push({ item, slot })
  }
  return out
}

/** Names of worn armor pieces, for get_state. */
export function wornArmor (bot: Bot): string[] {
  const out: string[] = []
  for (const slot of ['head', 'torso', 'legs', 'feet'] as const) {
    const it = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
    if (it) out.push(it.name)
  }
  return out
}

/** Find inventory items by exact id or `*` wildcard (e.g. `*_sword`). */
export function findItems (bot: Bot, name: string): Item[] {
  const pattern = new RegExp('^' + name.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z_]*') + '$')
  return bot.inventory.items().filter((i) => pattern.test(i.name))
}

/**
 * The bot's own air supply, 0-20 (20 = not underwater).
 *
 * Don't use `bot.oxygenLevel`: mineflayer 4.39 sets it from the air_supply
 * metadata of *any* entity (a nearby squid makes the bot look like it's
 * drowning). Read our own entity's metadata instead.
 */
export function ownOxygen (bot: Bot): number {
  const keys = bot.registry.entitiesByName.player?.metadataKeys as string[] | undefined
  const idx = keys?.indexOf('air_supply') ?? -1
  const raw = idx >= 0 ? (bot.entity?.metadata as unknown[] | undefined)?.[idx] : undefined
  return typeof raw === 'number' ? Math.round(raw / 15) : 20
}

/** What mining a block puts in the inventory, where it isn't the block itself. */
const BLOCK_DROPS: Record<string, string> = {
  stone: 'cobblestone', deepslate: 'cobbled_deepslate', grass_block: 'dirt', clay: 'clay_ball',
  coal_ore: 'coal', deepslate_coal_ore: 'coal', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold', copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond', emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  nether_quartz_ore: 'quartz', nether_gold_ore: 'gold_nugget', glowstone: 'glowstone_dust', snow_block: 'snowball'
}

/**
 * Items in `inventory` that count as gathered for a block pattern (`*`
 * wildcard): the block itself plus what it drops (iron_ore -> raw_iron,
 * stone -> cobblestone). Gather progress and mine_block both use it.
 */
export function countGathered (inventory: Record<string, number>, block: string): number {
  const re = new RegExp('^' + block.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z_]*') + '$')
  const names = new Set(Object.keys(inventory).filter((n) => re.test(n)))
  for (const [b, drop] of Object.entries(BLOCK_DROPS)) if (re.test(b)) names.add(drop)
  let n = 0
  for (const name of names) n += inventory[name] ?? 0
  return n
}
