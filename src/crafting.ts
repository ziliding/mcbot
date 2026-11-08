import type { Bot } from 'mineflayer'
import type { Recipe } from 'prismarine-recipe'

/**
 * Crafting and smelting knowledge, pure (no movement, no windows):
 * - a smelting table (minecraft-data 26.1 has crafting recipes but no furnace
 *   recipes) and fuel values;
 * - a shallow crafting resolver that turns "1 wooden_pickaxe" plus the
 *   inventory into an ordered list of `bot.craft` calls (logs -> planks ->
 *   sticks -> pickaxe), or says exactly what is missing.
 * Actions (actions.ts) executes the result.
 */

/** Seconds a vanilla furnace needs per item. */
export const SMELT_SECONDS = 10

/** Smelting recipes, input pattern (`*` wildcard) -> output. Common ones only. */
const SMELTING: Array<[string, string]> = [
  ['raw_iron', 'iron_ingot'], ['iron_ore', 'iron_ingot'], ['deepslate_iron_ore', 'iron_ingot'],
  ['raw_gold', 'gold_ingot'], ['gold_ore', 'gold_ingot'], ['deepslate_gold_ore', 'gold_ingot'], ['nether_gold_ore', 'gold_ingot'],
  ['raw_copper', 'copper_ingot'], ['copper_ore', 'copper_ingot'], ['deepslate_copper_ore', 'copper_ingot'],
  ['*_log', 'charcoal'], ['*_wood', 'charcoal'],
  ['sand', 'glass'], ['red_sand', 'glass'], ['cobblestone', 'stone'], ['stone', 'smooth_stone'], ['cobbled_deepslate', 'deepslate'],
  ['clay_ball', 'brick'], ['clay', 'terracotta'], ['netherrack', 'nether_brick'], ['ancient_debris', 'netherite_scrap'],
  ['sandstone', 'smooth_sandstone'], ['stone_bricks', 'cracked_stone_bricks'], ['wet_sponge', 'sponge'], ['cactus', 'green_dye'],
  ['beef', 'cooked_beef'], ['porkchop', 'cooked_porkchop'], ['chicken', 'cooked_chicken'], ['mutton', 'cooked_mutton'],
  ['rabbit', 'cooked_rabbit'], ['cod', 'cooked_cod'], ['salmon', 'cooked_salmon'], ['potato', 'baked_potato'], ['kelp', 'dried_kelp'],
  ['coal_ore', 'coal'], ['deepslate_coal_ore', 'coal'], ['diamond_ore', 'diamond'], ['redstone_ore', 'redstone'], ['lapis_ore', 'lapis_lazuli'],
  ['emerald_ore', 'emerald'], ['nether_quartz_ore', 'quartz']
]

const SMELT_OUTPUTS = new Set(SMELTING.map(([, o]) => o))

/** Items smelted per fuel item, best fuel first (the order auto-picking uses). */
const FUELS: Array<[RegExp, number]> = [
  [/^coal$/, 8], [/^charcoal$/, 8],
  [/^(?!crimson_|warped_)[a-z_]+_planks$/, 1.5],
  [/^(?!crimson_|warped_)[a-z_]+_(log|wood)$/, 1.5],
  [/^stick$/, 0.5], [/^coal_block$/, 80], [/^blaze_rod$/, 12], [/^dried_kelp_block$/, 20]
]

/** How many items one `name` smelts as fuel, or 0 if it is not a fuel. */
export function fuelUnits (name: string): number {
  return FUELS.find(([re]) => re.test(name))?.[1] ?? 0
}

/** Fuel preference rank (lower is better), Infinity when not a fuel. */
export function fuelRank (name: string): number {
  const i = FUELS.findIndex(([re]) => re.test(name))
  return i < 0 ? Infinity : i
}

/** `*_log` -> /^[a-z_]*_log$/ (same syntax as mine_block). */
export function wildcard (name: string): RegExp {
  return new RegExp('^' + name.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z_]*') + '$')
}

export interface SmeltSpec {
  /** What comes out, e.g. iron_ingot. */
  output: string
  /** Does an item name count as input for this? */
  isInput: (name: string) => boolean
  /** Input patterns, for messages ("raw_iron, iron_ore, ..."). */
  inputs: string[]
}

/**
 * `item` may name the input (raw_iron, *_log) or the output (iron_ingot,
 * charcoal). Null when the table knows neither.
 */
export function smeltSpec (item: string): SmeltSpec | null {
  const name = item.replace(/^minecraft:/, '').toLowerCase()
  const re = wildcard(name)
  // Input: an exact or wildcard match against the input side.
  const asInput = SMELTING.filter(([input]) => input === name || re.test(input.replace(/\*/g, 'x')) || wildcard(input).test(name))
  const outputs = [...new Set(asInput.map(([, o]) => o))]
  if (outputs.length === 1 && outputs[0]) {
    const pats = asInput.map(([i]) => i)
    return { output: outputs[0], inputs: [name], isInput: (n) => re.test(n) && pats.some((p) => wildcard(p).test(n)) }
  }
  // Output: everything that smelts into it.
  const asOutput = SMELTING.filter(([, o]) => o === name)
  if (asOutput.length) {
    const pats = asOutput.map(([i]) => i)
    return { output: name, inputs: pats, isInput: (n) => pats.some((p) => wildcard(p).test(n)) }
  }
  return null
}

export interface CraftCall {
  recipe: Recipe
  /** How many times to run the recipe. */
  times: number
  item: string
  made: number
}

export type Resolution =
  | { ok: true, calls: CraftCall[], needsTable: boolean }
  | { ok: false, missing: Map<string, number> }

/** Recursion depth for intermediates: log -> planks -> stick -> pickaxe is depth 2. */
export const MAX_CRAFT_DEPTH = 3

/**
 * Plan the `bot.craft` calls that leave `count` more `item` in the inventory,
 * crafting missing ingredients up to MAX_CRAFT_DEPTH levels deep. Works on a
 * simulated inventory; ingredients are reserved as they are resolved, so
 * planks used for sticks are not counted again for the pickaxe.
 *
 * `withTable`: a crafting table is (or will be) available. When false, only
 * 2x2 recipes are used, and `prefixTable` asks to craft a table first (its
 * planks come out of the same simulated inventory).
 */
export function resolveCraft (bot: Bot, item: string, count: number, inventory: Record<string, number>, withTable: boolean, prefixTable = false): Resolution {
  const reg = bot.registry
  const inv = new Map(Object.entries(inventory))
  const calls: CraftCall[] = []
  const have = (n: string): number => inv.get(n) ?? 0

  /** Make sure `need` of `name` are in `inv`; records shortfalls in `missing`. */
  const ensure = (name: string, need: number, depth: number, stack: Set<string>, missing: Map<string, number>): boolean => {
    const short = need - have(name)
    if (short <= 0) return true
    const id = reg.itemsByName[name]?.id
    // Ingots, coal, diamonds... are base materials: never "craft" them by
    // breaking up a storage block.
    const recipes = id === undefined || depth > MAX_CRAFT_DEPTH || stack.has(name) || SMELT_OUTPUTS.has(name)
      ? []
      : bot.recipesAll(id, null, withTable).filter((r) => !r.delta.some((d) => d.count < 0 && (d.id === id || stack.has(reg.items[d.id]?.name ?? ''))))
    if (recipes.length === 0) {
      missing.set(name, (missing.get(name) ?? 0) + short)
      return false
    }
    // Try variants that use what is already carried first (birch planks when
    // holding birch logs), oak as the tie-break for the "missing" message.
    const score = (r: Recipe): number => r.delta.filter((d) => d.count < 0).reduce((s, d) => s + Math.min(have(reg.items[d.id]?.name ?? ''), -d.count), 0)
    const ranked = [...recipes].sort((a, b) => score(b) - score(a) || oakFirst(reg, a) - oakFirst(reg, b))
    let best: Map<string, number> | null = null
    for (const r of ranked) {
      const snapInv = new Map(inv)
      const snapCalls = calls.length
      const miss = new Map<string, number>()
      const times = Math.ceil(short / r.result.count)
      const inner = new Set(stack).add(name)
      let ok = true
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const ing = reg.items[d.id]?.name
        if (!ing) { ok = false; break }
        const n = -d.count * times
        if (!ensure(ing, n, depth + 1, inner, miss)) { ok = false; continue }
        inv.set(ing, have(ing) - n) // reserve
      }
      if (ok) {
        inv.set(name, have(name) + r.result.count * times)
        calls.push({ recipe: r, times, item: name, made: r.result.count * times })
        return true
      }
      // Roll back this variant; remember the one that misses the least.
      inv.clear(); for (const [k, v] of snapInv) inv.set(k, v)
      calls.length = snapCalls
      if (!best || total(miss) < total(best)) best = miss
    }
    for (const [k, v] of best ?? []) missing.set(k, (missing.get(k) ?? 0) + v)
    return false
  }

  const missing = new Map<string, number>()
  // Keep going after a shortfall so the "missing" list covers the table and the item.
  let ok = true
  if (prefixTable) {
    if (ensure('crafting_table', 1, 0, new Set(), missing)) inv.set('crafting_table', have('crafting_table') - 1)
    else ok = false
  }
  if (!ensure(item, have(item) + count, 0, new Set(), missing) || !ok) return { ok: false, missing }
  return { ok: true, calls, needsTable: calls.some((c) => c.recipe.requiresTable) }
}

/** Tie-break between recipe variants: the everyday material (oak, cobblestone) first. */
function oakFirst (reg: Bot['registry'], r: Recipe): number {
  return r.delta.some((d) => /^(oak_|cobblestone$)/.test(reg.items[d.id]?.name ?? '')) ? 0 : 1
}

function total (m: Map<string, number>): number {
  let n = 0
  for (const v of m.values()) n += v
  return n
}

/** "3 oak_planks (have 1), 2 stick (have 0)". */
export function describeMissing (missing: Map<string, number>, inventory: Record<string, number>): string {
  return [...missing].map(([n, c]) => `${c} more ${n} (have ${inventory[n] ?? 0})`).join(', ')
}

/** Item ids and which of them have a crafting recipe, for validating plan steps. */
export interface ItemCatalog {
  itemNames: string[]
  craftable: Set<string>
}

export function itemCatalog (data: { itemsArray: Array<{ id: number, name: string }>, recipes: Record<string, unknown> }): ItemCatalog {
  const craftable = new Set<string>()
  for (const it of data.itemsArray) if (data.recipes[String(it.id)]) craftable.add(it.name)
  return { itemNames: data.itemsArray.map((i) => i.name), craftable }
}

/** Errors for a craft item that has no crafting recipe (with hints), or null. */
export function checkCraftItem (item: string, cat: ItemCatalog): string | null {
  const re = wildcard(item.replace(/^minecraft:/, '').toLowerCase())
  // Ingots, coal, diamonds... also have "craft from a storage block" recipes,
  // which is never what is meant: they come from smelting or mining.
  const smelt = smeltSpec(item)
  if (smelt && smelt.output === item) return `"${item}" is smelted (or mined), not crafted: use a smelt step with ${smelt.inputs.join(' / ')}`
  if ([...cat.craftable].some((n) => re.test(n))) return null
  const token = item.replace(/\*/g, '').replace(/^_+|_+$/g, '')
  const similar = token.length >= 3 ? [...cat.craftable].filter((n) => n.includes(token)).sort((a, b) => a.length - b.length).slice(0, 5) : []
  if (cat.itemNames.some((n) => re.test(n))) return `"${item}" has no crafting recipe` + (similar.length ? `; craftable: ${similar.join(', ')}` : '')
  return `"${item}" is not a Minecraft item id` + (similar.length ? `; did you mean ${similar.join(', ')}?` : '')
}

/** Error for a smelt item the table does not know, or null. */
export function checkSmeltItem (item: string): string | null {
  return smeltSpec(item) ? null : `"${item}" can't be smelted here; known: raw_iron/raw_gold/raw_copper (or their ores) -> ingots, *_log -> charcoal, sand -> glass, cobblestone -> stone, raw meat/fish -> cooked`
}
