import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'

type Vec = Bot['entity']['position']

/** Tree parts: standing on these means "up a tree", not on the ground. */
export const TREE = /(_leaves|_log|_wood|_stem|_hyphae|^mangrove_roots|^azalea|^flowering_azalea)$/
/** Blocks that fall when nothing is under them. */
export const LOOSE = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|[a-z_]+_concrete_powder)$/
/** Natural ground a shelter pit can be dug into. */
export const GROUND = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|packed_mud|clay|moss_block|dirt_path|farmland|stone|deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|cobblestone|cobbled_deepslate|mossy_cobblestone|terracotta|[a-z_]+_terracotta|sandstone|red_sandstone|netherrack|blackstone|basalt|smooth_basalt|end_stone|snow_block|[a-z_]*_ore)$/

const AIRS = new Set(['air', 'cave_air', 'void_air'])
const DIRS: Array<[string, number, number]> = [['north', 0, -1], ['south', 0, 1], ['east', 1, 0], ['west', -1, 0]]

export function isLiquid (b: Block | null): boolean {
  return b?.name === 'water' || b?.name === 'lava' || b?.name === 'bubble_column'
}

/** A full block you can't walk through (leaves count; slabs and plants don't). */
export function isSolidBlock (b: Block | null): boolean {
  return b != null && b.boundingBox === 'block' && !isLiquid(b)
}

/** Room to stand in: no collision and no liquid. */
export function isOpen (b: Block | null): boolean {
  return b != null && b.boundingBox === 'empty' && !isLiquid(b)
}

/**
 * Walls on all four sides at feet and head height and a solid block right
 * above the head: nothing can walk in or shoot in.
 */
export function isEnclosed (bot: Bot): boolean {
  if (!bot.entity) return false
  const feet = bot.entity.position.floored()
  for (const [, dx, dz] of DIRS) {
    if (!isSolidBlock(bot.blockAt(feet.offset(dx, 0, dz))) || !isSolidBlock(bot.blockAt(feet.offset(dx, 1, dz)))) return false
  }
  return isSolidBlock(bot.blockAt(feet.offset(0, 2, 0)))
}

export interface Surroundings {
  /** Block directly under the feet, e.g. "grass_block", "birch_leaves", "air". */
  standing_on: string
  footing: 'ground' | 'tree' | 'loose (sand/gravel)' | 'water' | 'lava' | 'in the air' | 'other'
  /** When not on natural ground: what's under the footing, e.g. "dirt 5 blocks down". */
  ground_below: string | null
  /** What fills the feet and head cells (air, water, tall_grass...). */
  in_cells: { feet: string, head: string }
  /** Each side at feet+head height: "open", "open, drop of 4", "wall (stone)", "half-blocked (...)". */
  sides: Record<string, string>
  /** First thing above the head: "open sky" or e.g. "oak_leaves 3 above". */
  overhead: string
  /** Walled in on all four sides with a roof right overhead: mobs can't get at you. */
  sheltered: boolean
  /** Most common blocks within 3 blocks (a rough picture of the area). */
  nearby_blocks: Record<string, number>
}

/** What the brain needs to know about the blocks around the body, as words. */
export function describeSurroundings (bot: Bot): Surroundings | null {
  if (!bot.entity) return null
  const feet = bot.entity.position.floored()
  const at = (p: Vec): Block | null => bot.blockAt(p)
  const name = (b: Block | null): string => b?.name ?? 'unloaded'

  const under = at(feet.offset(0, -1, 0))
  let footing: Surroundings['footing']
  if (!under) footing = 'other'
  else if (under.name === 'water') footing = 'water'
  else if (under.name === 'lava') footing = 'lava'
  else if (TREE.test(under.name)) footing = 'tree'
  else if (LOOSE.test(under.name)) footing = 'loose (sand/gravel)'
  else if (under.boundingBox === 'empty') footing = 'in the air'
  else if (GROUND.test(under.name)) footing = 'ground'
  else footing = 'other'

  let groundBelow: string | null = null
  if (footing === 'tree' || footing === 'in the air' || footing === 'water') {
    for (let dy = 2; dy <= 24; dy++) {
      const b = at(feet.offset(0, -dy, 0))
      if (!b) break
      if (b.boundingBox === 'block' && !TREE.test(b.name)) { groundBelow = `${b.name} ${dy} blocks down`; break }
    }
    groundBelow ??= 'nothing solid within 24 blocks'
  }

  const sides: Record<string, string> = {}
  for (const [dir, dx, dz] of DIRS) {
    const f = at(feet.offset(dx, 0, dz))
    const h = at(feet.offset(dx, 1, dz))
    if (isSolidBlock(f) && isSolidBlock(h)) {
      sides[dir] = f?.name === h?.name ? `wall (${name(f)})` : `wall (${name(f)}, ${name(h)} above)`
    } else if (isOpen(f) && isOpen(h)) {
      let drop = 0
      while (drop < 5 && isOpen(at(feet.offset(dx, -1 - drop, dz)))) drop++
      const floor = at(feet.offset(dx, -1 - drop, dz))
      sides[dir] = drop === 0 ? 'open' : `open, drop of ${drop === 5 ? '5+' : drop}${isLiquid(floor) ? ` into ${name(floor)}` : ''}`
    } else {
      sides[dir] = `half-blocked (feet: ${name(f)}, head: ${name(h)})`
    }
  }

  let overhead = 'open sky'
  for (let dy = 2; dy <= 24; dy++) {
    const b = at(feet.offset(0, dy, 0))
    if (!b) { overhead = 'unknown'; break }
    if (b.boundingBox !== 'empty' || isLiquid(b)) { overhead = `${b.name} ${dy - 1} above`; break }
  }

  const counts = new Map<string, number>()
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    const b = at(feet.offset(dx, dy, dz))
    if (!b || AIRS.has(b.name)) continue
    counts.set(b.name, (counts.get(b.name) ?? 0) + 1)
  }
  const nearby = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 8))

  return {
    standing_on: name(under),
    footing,
    ground_below: groundBelow,
    in_cells: { feet: name(at(feet)), head: name(at(feet.offset(0, 1, 0))) },
    sides,
    overhead,
    sheltered: isEnclosed(bot),
    nearby_blocks: nearby
  }
}

export interface ShelterSpot {
  /** Top ground block: the pit is this block and the two below it. */
  ground: Vec
  /** Rough cost: distance plus dig seconds. */
  cost: number
}

/**
 * A column to dig a 1x1 pit three deep: natural ground (not tree, sand or
 * gravel), room to stand on top, solid walls around the two cells the body
 * will occupy, a solid floor, no liquid next to any of it, and something
 * solid beside the top cell to plug it against. Nearest and quickest first.
 */
export function findShelterSpot (bot: Bot, radius: number, digMs: (b: Block) => number): ShelterSpot | null {
  const me = bot.entity.position
  const ok = (g: Vec): number | null => {
    if (!isOpen(bot.blockAt(g.offset(0, 1, 0))) || !isOpen(bot.blockAt(g.offset(0, 2, 0)))) return null
    let ms = 0
    for (let i = 0; i < 3; i++) {
      const b = bot.blockAt(g.offset(0, -i, 0))
      if (!b || !GROUND.test(b.name) || LOOSE.test(b.name)) return null
      ms += digMs(b)
    }
    if (ms > 25_000) return null
    const floor = bot.blockAt(g.offset(0, -3, 0))
    if (!isSolidBlock(floor) || LOOSE.test(floor?.name ?? '') || floor?.name === 'magma_block') return null
    let anchor = false
    for (let i = 0; i <= 3; i++) {
      for (const [, dx, dz] of DIRS) {
        const side = bot.blockAt(g.offset(dx, -i, dz))
        if (isLiquid(side)) return null
        if (i === 0) { if (isSolidBlock(side)) anchor = true; continue }
        if ((i === 1 || i === 2) && !isSolidBlock(side)) return null
      }
    }
    if (isLiquid(bot.blockAt(g.offset(0, -4, 0)))) return null
    return anchor ? ms : null
  }
  const candidates = bot.findBlocks({
    point: me,
    maxDistance: radius,
    count: 200,
    matching: (b: Block | null) => b != null && GROUND.test(b.name),
    // Count only surface blocks (room to stand on top), not buried ones.
    useExtraInfo: (b: Block) => isOpen(bot.blockAt(b.position.offset(0, 1, 0))) && isOpen(bot.blockAt(b.position.offset(0, 2, 0)))
  })
  let best: ShelterSpot | null = null
  for (const g of candidates) {
    const ms = ok(g)
    if (ms === null) continue
    const cost = g.offset(0.5, 1, 0.5).distanceTo(me) + ms / 1000
    if (!best || cost < best.cost) best = { ground: g, cost }
  }
  return best
}
