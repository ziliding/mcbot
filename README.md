# uta-mcbot

A Minecraft companion bot. Mineflayer controls the body in game, and a Matrix room carries the conversation with Hermes.
The full design (brain / cerebellum / reflexes, milestones M1–M6) is in the implementation plan. Status: **M1 (conversation round trip), M2 (MCP over HTTP in the same process), M3 (reflexes: fight, eat, escape water/lava/fire, wear armor) and M4 (cerebellum: Jev-driven behavior loop over typed plans, plus local chat triage) and M5 (brain → cerebellum: `set_plan`/`get_plan`/`clear_plan` MCP tools for Hermes, and rate-limited `[EVENT]` escalations into the room) are done, plus crafting, smelting and block placement (`craft`, `smelt`, `place_block`, and `craft`/`smelt` plan steps), and surroundings, shelter and low-health retreat (`get_state.surroundings`, `shelter`).** M6 (ops/observability: traces, reconnect hardening) is next.

## Layout

| Service | What | Ports |
|---|---|---|
| `mc` | `itzg/minecraft-server`, vanilla `${MC_VER}` (26.1), offline mode | `127.0.0.1:25565` only |
| `mcbot` | single Node process: mineflayer bot + Matrix bridge + MCP server | `127.0.0.1:3333` (MCP, bearer token) |

`mcbot` also joins the external `matrix_default` network to reach the homeserver at `http://tailscale:6167`. Start the matrix compose project first.

Source is in `src/` (strict TypeScript):

- `body.ts` owns the one mineflayer instance, reconnects with backoff, parses player chat, and paces outgoing chat (256-char limit, newline split, never sends a line starting with `/`).
- `matrix.ts` is a minimal client-server API client: whoami, join, long-poll `/sync`. It waits 1.5 s after the last edit so streamed replies are sent once, complete.
- `main.ts` wires them together: game chat → `[MC] <player>: <text>` in the room, and room messages from allowed senders → game chat.
- `actions.ts` holds the bot's verbs: state, come, follow, go_to, mine (with `*` wildcards, e.g. `*_log`), look, equip, eat, give, drop, stop, respawn. A movement verb cancels the one before it. Everything that uses the held item (equip, eat, toss, tool swaps) runs one at a time.
- `reflexes.ts` is the reflex layer (M3). It runs on every physics tick, makes no LLM or MCP calls, and never chats. Highest priority first:
  1. Escape lava, fire and deep water (when its air drops).
  2. Retreat when health ≤ 8 and a hostile mob (or whatever just hit it) is within 12 blocks: it ends any fight and runs until 20 blocks away. If it can't get away, it fights back for 8 s before trying again. Not while sheltered. When the threat is an archer (skeleton, pillager, witch…), or it already retreated twice within 45 s, it digs in with `shelter` instead (`reflex.shelter`), pauses any plan and posts `[EVENT] took shelter`. If no shelter spot is found it goes back to retreating for 30 s.
  3. Fight hostile mobs within 8 blocks, and anything that hits it. At health ≤ 12 it only hits back, and flyers (phantoms, ghasts, blazes, vexes) are only hit when within reach, never chased. It equips its best sword or axe and only hits at full attack strength. It never attacks creepers or wardens. It leaves endermen and piglins alone unless they attack. It never fights players, golems or villagers, and never blames unattributed damage (falls, starving) on a bystander.
  4. Eat the best safe food when food ≤ 14, or when health ≤ 14 and food < 20.
  5. Wear the best armor it carries.

  Fighting and escaping take the activity slot: `get_state.activity` shows `fighting zombie`, and MCP tools wait it out instead of failing: a call made during a reflex starts when it ends (up to 30 s), and `go_to`, `come_to_player`, `mine_block` (for what's still missing), `give` and `place_block` carry on after one (`mcp.resume`; the result ends with `(paused 1x for fighting husk, then carried on)`). `craft` and `smelt` only wait before they start. A newer command, `stop` or a plan taking the slot still ends a call. `follow_player` during a reflex is queued and starts when it ends. The cerebellum and local chat commands still see `busy:` / `interrupted by …` as before. An interrupted follow resumes by itself.
- `cerebellum.ts` is the cerebellum (M4), see below. `jev.ts` wraps the TypeSafe SDK (timeouts, logging, cost), `plan.ts` holds the typed plan model, `worldstate.ts` builds the compact state Jev reads, and `triage.ts` decides which chat lines the body answers itself.
- `surroundings.ts` describes the blocks around the body in words for `get_state`, and finds shelter spots (see *Surroundings and shelter*).
- `items.ts` is the item knowledge the reflexes and verbs share: food quality, weapon damage, armor rank, and what a mined block drops (`iron_ore` → `raw_iron`) for gather progress.
- `crafting.ts` is crafting and smelting knowledge, pure: the smelting and fuel tables, and the crafting resolver (see *Making things*).
- `mcp.ts` is a stateless MCP Streamable HTTP server at `/mcp` that exposes those verbs as tools, plus the plan tools (M5). It requires `Authorization: Bearer $MCP_TOKEN`. `/health` takes no auth.
- `events.ts` posts `[EVENT] …` escalations to the room (coalesced, rate-limited); `lookout.ts` spots rare ores for "notable find" events.

Every tool call is logged as an `mcp.call` event, with its arguments, duration and result. Reflexes log `reflex.fight`, `reflex.retreat`, `reflex.eat`, `reflex.escape`, `reflex.armor`, `reflex.shelter` and `reflex.resume`; a tool carrying on after a reflex logs `mcp.resume`.

Why reflexes are hand-written rather than plugins (checked against mineflayer 4.39 and MC 26.1):
- `mineflayer-pvp` 1.3.2 (2022) calls `pathfinder.stop()`, which kills the next goto.
- `mineflayer-armor-manager` 2.0.1 (2023) has a hardcoded armor table with no copper armor.
- `mineflayer-auto-eat` 5.0.3 does load and read the 26.1 food registry. But it equips and eats on its own loop, independent of the activity slot, so it would swap items mid-fight or mid-dig.

Also, don't use `bot.oxygenLevel` in 4.39: it is overwritten by any nearby entity's air supply. `items.ts` `ownOxygen()` reads the bot's own metadata.

Loop prevention: the bot ignores its own game messages (by uuid and by name) and its own Matrix messages. System, death and join lines are not forwarded.

## Cerebellum (M4)

The brain (Hermes) is slow and expensive; the reflexes are instant but dumb. The cerebellum sits between them: a ~1 Hz loop that asks **Jev** (TypeSafe's System One model, `jev-1.14.0`) one batched request per tick and turns the typed answers into `Actions` calls. It needs `JEV_API`; without it the cerebellum and triage switch off and the bot behaves as in M3.

Each tick sends a compact world state (health/food as words, nearest hostile and how close, players, inventory summary, current activity and reflex, plan step with code-measured progress like "gathered 3 of 5, 2 more needed", last action and outcome) and four questions:
- **Choice** `behavior`: `FOLLOW_PLAYER | COME_TO_PLAYER | GATHER | CRAFT | SMELT | MOVE_TO | FLEE | EAT | IDLE`. Only the options that make sense this tick are offered, always in that order (e.g. `GATHER` only during a gather step, `FLEE` only with a creeper/warden within 10 blocks, `EAT` only when hungry with food). There is no `FIGHT` (that's the reflexes). `CRAFT` and `SMELT` were added later (see *Making things*).
- **Noul** `step_done`, `step_feasible`, `danger`.

Policy (all in code, thresholds via env):
- Reflexes win: while one holds the activity slot, no call is made at all. An interrupted gather (`interrupted by fighting zombie`) is retried after the fight, never escalated.
- Commands from outside win over the plan: if Hermes (MCP) or a local chat command holds the slot, the cerebellum only watches, and may interject `FLEE`/`EAT`. After fleeing from a follow, it follows again.
- Switch only when the new behavior has p ≥ `CEREBELLUM_SWITCH_P` and beats the current one by `CEREBELLUM_MARGIN` (hysteresis); a high `danger` lowers the bar for `FLEE`/`EAT`.
- Step completion and progress are measured by code (inventory delta, distance); Jev's `step_done` is logged as a second opinion (`cerebellum.done_disagree`).
- Escalations (`cerebellum.escalate`, then the `onEvent` hook M5 will post to Matrix): top probability < `CEREBELLUM_LOW_CONF_P` for `CEREBELLUM_LOW_CONF_TICKS` ticks; the step judged infeasible for `CEREBELLUM_INFEASIBLE_TICKS` ticks or failing with "no more X nearby" / "player not online" (the plan pauses); a step failing twice; plan done. Same type + step at most once per `CEREBELLUM_ESCALATE_COOLDOWN_MS`.
- Calls are skipped when nothing changed (bucketed fingerprint; re-asked every `CEREBELLUM_MAX_STALE_MS` while something runs), when idle with no plan, and while a reflex or an outside command has nothing to interject. Skips are counted in `jev.usage`.
- Any explicit stop (chat or the MCP `stop` tool) pauses the plan.

Plans are typed (`plan.ts`): `gather {block, count}`, `craft {item, count}`, `smelt {item, count, fuel?}`, `move_to {x, y?, z}`, `come_to_player {player?}`, `wait {seconds}`, held in memory with a step index. The zod schemas in `plan.ts` are the single source of truth: the MCP tool schema, `!plan {json}` and `CEREBELLUM_PLAN` all parse with them. Hermes writes plans (M5, below); code owns the step index.

### Chat triage

Before a game chat line goes to Matrix, the body checks whether it is a bare **follow / come / stop / wait** command for the bot. A wrong "handled locally" means Hermes never sees the line, so it is conservative:
1. A strict grammar must match first (after dropping fillers like "please", "mcbot", "me", "here"): no `?`, no negation, nothing else asked. "stop following me and chop trees" never goes local.
2. Jev must agree: command probability ≥ `TRIAGE_COMMAND_P` (0.9) and "addressed to the bot" ≥ `TRIAGE_ADDRESSED_P` (0.6; 0.85 when other players are online and the bot isn't named).
3. Jev slow (`TRIAGE_TIMEOUT_MS`) or down: the grammar alone decides (and only for a named bot when others are online).
4. If the local action fails (e.g. `busy: fighting zombie`), the line is forwarded after all.

Handled lines get a canned reply ("ok, following you") and are prepended to the next forwarded line as `[MC] (handled locally) steve: follow me → …`, so Hermes keeps the context without being woken. Every decision is logged as a `triage` event.

### Running a test plan

Without Hermes, either:
- `CEREBELLUM_PLAN=logs docker compose up -d mcbot` loads a preset on spawn (`logs`: gather 5 `*_log`, then come back to the player; `logs_only`). It also accepts JSON: `{"goal":"…","steps":[{"kind":"gather","block":"*_log","count":5},{"kind":"come_to_player"}]}`.
- In game chat: `!plan logs`, `!plan {json}`, `!plan show`, `!plan pause`, `!plan resume`, `!plan clear`. These lines are never forwarded.

Watch it with `docker compose logs -f mcbot | grep -E 'cerebellum|plan|triage|jev.usage'`.

### Jev cost and latency

Jev bills input tokens only, $0.042 per million (`jev-1.14.0`, Nov 2026). Measured here: a cerebellum request is ~800 tokens and 100–330 ms (p50 ~150 ms); a triage request is ~520 tokens and ~130 ms.
- Ceiling, a call every tick at 1 Hz: ~2.9 M tokens/h ≈ **$0.12/hour**.
- Actual, with change detection: ~7 calls in 45 s of plan work (≈ $0.02/hour), and **zero** while idle with no plan. Exception: idle but slightly hungry (food 15–16, below the reflex's eat threshold) or next to a creeper that doesn't move re-asks every `CEREBELLUM_MAX_STALE_MS` (10 s), about 360 calls ≈ $0.01/hour.

Each answer logs `jev.answer` (ms, model, tokens, usd, probabilities); `jev.usage` every `JEV_USAGE_LOG_MS` (5 min) logs the rolling last-hour requests/tokens/USD by purpose, totals, errors and skipped calls.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `JEV_API` | (unset) | TypeSafe API key. Unset = no cerebellum, no triage. |
| `JEV_MODEL` | `jev-1.14.0` | Pinned model id (thresholds are tuned against it). |
| `JEV_PRICE_PER_MTOK` | `0.042` | USD per million input tokens, for the cost log. |
| `JEV_USAGE_LOG_MS` | `300000` | How often `jev.usage` is logged. |
| `CEREBELLUM_ENABLED` | `true` | Set `false` to keep triage but not the loop. |
| `CEREBELLUM_PLAN` | (unset) | Preset name or JSON plan loaded on first spawn. |
| `CEREBELLUM_TICK_MS` | `1000` | Loop period. |
| `CEREBELLUM_TIMEOUT_MS` | `800` | Per-call timeout (no retries). |
| `CEREBELLUM_SWITCH_P` / `CEREBELLUM_MARGIN` | `0.6` / `0.25` | Switch threshold and hysteresis margin. |
| `CEREBELLUM_LOW_CONF_P` / `CEREBELLUM_LOW_CONF_TICKS` | `0.5` / `5` | Low-confidence escalation. |
| `CEREBELLUM_INFEASIBLE_P` / `CEREBELLUM_INFEASIBLE_TICKS` | `0.2` / `3` | Infeasible-step escalation. |
| `CEREBELLUM_DANGER_P` | `0.7` | "In danger" threshold that lowers the bar for FLEE/EAT. |
| `CEREBELLUM_MAX_STALE_MS` | `10000` | Re-ask at least this often while something runs. |
| `CEREBELLUM_ESCALATE_COOLDOWN_MS` | `120000` | Dedupe window per escalation type + step. |
| `TRIAGE_ENABLED` | `true` | Set `false` to forward all chat to Hermes. |
| `TRIAGE_TIMEOUT_MS` | `1000` | Jev timeout before the grammar-only fallback. |
| `TRIAGE_ADDRESSED_P` / `TRIAGE_COMMAND_P` | `0.6` / `0.9` | Triage thresholds. |

## Brain → cerebellum (M5)

### Plan tools

- `set_plan {goal, steps[]}`: replaces any plan, takes over from a running follow/go_to (never from a reflex), returns the plan summary. Refused when the cerebellum is off (no `JEV_API`).
  - Steps are validated against the zod union. Unknown kinds or fields give a readable error (`unknown step kind; \`kind\` must be one of gather, move_to, come_to_player, wait at steps[0].kind`).
  - Gather blocks are checked against the 26.1 block registry (minecraft-data, so it works while the bot is offline), with suggestions: `"coal" is not a Minecraft block id; did you mean coal_ore, coal_block, deepslate_coal_ore? (gather mines the block, not the item it drops)`.
- Craft items are checked against the item registry (`"iron_ingot" is smelted (or mined), not crafted: use a smelt step with raw_iron / iron_ore / deepslate_iron_ore`), smelt items against the smelting table.
- `get_plan`: goal, status, `step: "1/2"`, current step, code-measured progress (`gathered 3 of 5, 2 more needed`), pause reason, all steps. `get_state` includes the same object as `plan`.
- `clear_plan`: drops the plan and cancels its running work.

**Who advances the step:** code. Completion is measured (inventory delta since the step started, distance, elapsed time). Jev's `step_done` answer is only a logged second opinion (`cerebellum.done_disagree`), as in M4. A new or cleared plan cancels the old plan's running executor, even when the new step maps to the same behavior, and resets the escalation dedupe so a re-sent plan's failure is reported again.

### `[EVENT]` escalations

Hermes is never polled; it wakes on room messages. So the bot account posts `[EVENT] <kind>: <what happened>` and a `now:` line with compact context: position, hp/food, current activity or reflex, plan status and step, players and distances, nearest hostile, top inventory. Hermes can act without calling `get_state` first.

| Event | Source |
|---|---|
| `plan complete` | last step measured done |
| `step stuck` | "no more X within 48 blocks", unknown block, player not online, or Jev judged the step infeasible N ticks in a row; the plan pauses |
| `step failed` | a step failed twice for another reason; the plan pauses |
| `unsure` | Jev's top behavior below `CEREBELLUM_LOW_CONF_P` for `CEREBELLUM_LOW_CONF_TICKS` ticks |
| `died` | the server's death message (cause), death position, whether the plan continues |
| `notable find` | `EVENT_FIND_BLOCKS` within `EVENT_FIND_RADIUS` with at least one face open to air or water, once per vein |

A player talking to the bot is not an event: triage-forwarded speech stays the normal `[MC] <player>: …` line, never double-posted.

Bursts: events within `EVENT_COALESCE_MS` of the first go out as one `[EVENT] N events:` message; messages are at least `EVENT_MIN_INTERVAL_MS` apart and at most `EVENT_MAX_PER_MIN` per rolling minute. Events held back by either limit are merged into the next message, not dropped (exact duplicates are; past `EVENT_MAX_LINES` the oldest lines are collapsed to "+N earlier"). Every post costs a Hermes turn, so the defaults are quiet. Logs: `event.report` per event, `event.post` per message.

Loop safety is unchanged: the bridge ignores its own Matrix messages, so `[EVENT]` lines never reach game chat; Hermes's replies are spoken in game as usual.

| Variable | Default | Meaning |
|---|---|---|
| `EVENTS_ENABLED` | `true` | `false` = log events only, post nothing. |
| `EVENT_COALESCE_MS` | `3000` | Merge window after the first event. |
| `EVENT_MIN_INTERVAL_MS` | `20000` | Minimum gap between two posts. |
| `EVENT_MAX_PER_MIN` | `3` | Posts per rolling minute. |
| `EVENT_MAX_LINES` | `6` | Event lines per merged message. |
| `EVENT_FIND_BLOCKS` | `diamond_ore,deepslate_diamond_ore,emerald_ore,deepslate_emerald_ore,ancient_debris` | Notable-find blocks; empty = off. |
| `EVENT_FIND_RADIUS` | `16` | Search radius in blocks. |
| `EVENT_FIND_EVERY_MS` | `10000` | Scan period. |

After changing the MCP tool set, send `/new` in the room so Hermes's session picks up the new tools.

## Making things (crafting, smelting, placing)

Three verbs in `actions.ts`, as MCP tools and as plan steps. Each takes the activity slot (`crafting 1 wooden_pickaxe`, `smelting 3 iron_ingot`, `placing torch`), so a reflex pre-empts it (`interrupted by fighting zombie`) and the cerebellum may interject FLEE.

- **`craft {item, count}`**: crafts `count` more of an item id (`*_planks` picks a wood the bag can make).
  - `crafting.ts` `resolveCraft` plans the `bot.craft` calls on a simulated inventory. It makes missing intermediates up to 3 levels deep (log → planks → sticks → pickaxe). Ingredients are reserved as they are resolved, so planks used for sticks are not counted again for the pickaxe. Of the per-wood recipe variants, it prefers the one the bag can already satisfy.
  - Smelted or mined items (ingots, coal, diamonds) are base materials, never "crafted" from their storage block.
  - 3×3 recipes use a crafting table within 16 blocks (it walks over), or it crafts one from planks and places it next to the bot.
  - On failure: `can't craft 1 iron_pickaxe: need 1 more iron_ingot (have 2); have: …`.
- `begin()` closes any open container window when something new claims the slot. Otherwise a reflex's sword equip would click the furnace's slots.
- **`smelt {item, count, fuel?}`**: `item` is the input (`raw_iron`, `*_log`) or the output (`iron_ingot`, `charcoal`).
  - Uses a furnace within 16 blocks, or crafts one from 8 cobblestone (through `craft`, so a table is made if needed) and places it.
  - Fuel is one type from the bag, best first: coal, charcoal, planks, logs, sticks. It never burns the input itself (no logs as fuel when making charcoal).
  - It loads input and fuel, waits (10 s per item + slack), and takes the output.
  - Re-entry is safe: matching output already in the furnace is collected first, and matching input already loaded counts.
  - The MCP tool caps `count` at 24 (Hermes's 300 s tool timeout). A plan smelt step runs in loads of 24.
- **`place_block {item, x?, y?, z?}`**: places at the given cell (it walks into reach with `GoalPlaceBlock`), or at the nearest free cell with solid ground 1–3 blocks away.
  - It never places into a cell a player, mob or the bot stands in, and never against a block that opens a screen (tables, furnaces, chests, doors…).
  - Flowers are not replaceable; grass is.
- **Recipe data:** minecraft-data 3.119 has the 26.1 crafting recipes (planks, stick, crafting_table, wooden_pickaxe, furnace, torch all present). It has **no furnace recipes**, so `crafting.ts` carries a typed smelting table (ores and raw metals → ingots, logs → charcoal, sand → glass, cobblestone → stone, raw meat/fish → cooked, …) and a fuel table.
- **26.1 inventory quirk:** after a 2×2 inventory craft, mineflayer 4.39 leaves the last click unconfirmed. The next craft can start from a wrong inventory model and hang: logs → planks → crafting_table timed out about 1 run in 2. `craft` now asks the server for the full inventory state before and after each 2×2 craft (`bot._syncWindow`, mineflayer's own no-op click). On a failure it also empties the 2×2 grid and retries once.
- **Gather progress counts drops:** a `gather iron_ore` step now completes on `raw_iron`, and `stone` on `cobblestone`. Before, those steps could never complete.

Cerebellum: `CRAFT` and `SMELT` join the behavior choice (GATHER/CRAFT/SMELT/MOVE_TO map 1:1 to the step kinds). Step completion is the code-measured inventory delta of the item (craft), or of the output (smelt: `iron_ingot` for `raw_iron`). A craft or smelt that fails for missing materials or fuel pauses the plan at once with `step stuck` (retrying won't conjure materials). `!plan pickaxe` is a preset: gather 3 `*_log`, then craft a `wooden_pickaxe`.

## Surroundings and shelter

Before this, the brain could not see blocks at all. Asked to hide at night, it ran `mine_block dirt` (which digs the nearest dirt anywhere, not under its feet) and `place_block` at guessed coordinates. It was standing in a birch tree, so half the placements hit leaves, stone or gravel, and it never got a shelter. It then fist-fought zombies down to 1.5 health and died to a skeleton.

- **`get_state.surroundings`** (`surroundings.ts`, computed only for the MCP call, not for Jev):
  - `standing_on` and `footing`: ground, tree, loose (sand/gravel), water, lava or in the air.
  - `ground_below` when up a tree or in the air, e.g. `grass_block 10 blocks down`.
  - `sides`: north/south/east/west at feet and head height, e.g. `open`, `open, drop of 5+`, `wall (dirt)`, `half-blocked (…)`.
  - `overhead` (`open sky` or e.g. `pale_oak_leaves 7 above`), `sheltered`, and the 8 most common blocks within 3.
- **`shelter`** (MCP tool, `Actions.shelter`):
  - Finds natural ground within 16 blocks (dirt/stone, not tree, sand or gravel). The column must be 3 deep with solid walls, a solid floor and no liquid next to it.
  - Walks there and centers on the block, digs 3 straight down, and plugs the top with the cheapest block it carries (dirt, cobblestone, planks…). The body ends up in a closed 1×1, 2-high pit.
  - It refuses up front if it has no cover block and the pit won't yield one. It waits up to 15 s for a running fight or retreat to finish instead of answering `busy`.
  - An active plan is paused, since the plan would dig the body out. It is resumed if the shelter fails.
- **While sheltered or digging in:**
  - No proactive fights; it only hits back at a mob within reach.
  - No retreat, and no cerebellum FLEE.
  - It eats even with mobs right outside.
- **Getting out:** the pathfinder's way up a 1×1 shaft (placing blocks under itself) stalls on 26.1, so `goto` first digs a staircase toward the target (`climb.out`), whenever the only way out is 2+ blocks up. `go_to`, `come_to_player`, `follow_player`, mining and plan steps all go through it.

## Surroundings and shelter check

Live bot on 26.1 (difficulty easy), only mcbot online:
- Teleported onto a pale oak canopy: `footing: tree`, `ground_below: grass_block 10 blocks down`, every side `open`. On flat ground, walls and the canopy 7 above read correctly.
- `shelter` from the canopy (day): down to the ground, dug in at `2 132 -2` and sealed with dirt in 7.4 s, `sheltered: true`. At night with mobs about: 4.7 s.
- Two zombies summoned next to the closed pit, plus the hunger effect: no fight, and it ate 3 bread in the pit.
- Before the staircase fix, `go_to` out of the pit gave up after 120 s (it towered one block and stalled). With it: `climb.out`, then arrived in 8.9 s.
- `/damage` to 6 with a zombie 4 blocks away: `reflex.retreat` to 19.7 blocks in 4.7 s, then it ate. A creaking then hit it at 4.5 health: it retreated again (the attacker came from the hit) and healed to 17.

Not checked: the refusals (no spot within 16, no cover block), and retreating from a skeleton that is shooting from more than 12 blocks.

Waiting out reflexes (live, day, only mcbot online):
- `mine_block stone 5`, husk summoned 3 s in: the fight interrupted it, `mcp.resume`, and the call returned with 5 stone gathered after one pause (13 s).
- At 8.5 health, night, skeleton 9 blocks away: it was shot to 5.8, `reflex.shelter` dug in and sealed in 4.6 s, `[EVENT] took shelter` posted.
- `go_to` 15 blocks from that pit with a husk summoned on the way: climbed out, fought, carried on, arrived in 11 s. `follow_player` during a fight was queued and started when the fight ended.
- A phantom summoned 5 blocks away at full health: no fight.
- At 8 health with three husks around: two retreats got it clear, so no shelter was needed.

## Crafting check

Verified over MCP against the live bot (26.1, difficulty easy), with materials from `give mcbot …`:
- craft `*_planks` 4 → `stick` 4 → `crafting_table` 1 → `place_block crafting_table` (auto spot) → `wooden_pickaxe` 1 at the placed table.
- From 3 birch logs and no table within 16 blocks: `craft wooden_pickaxe` made planks, a table, sticks, placed the table and crafted the pickaxe in 2.1 s.
- `smelt iron_ingot 3` with no furnace near (night, mobs about), three calls:
  1. The first crafted a furnace from 8 cobblestone at the nearby table and placed it. The cerebellum then fled a creeper: `interrupted by fleeing creeper`.
  2. The second came from 21 blocks away. It found no furnace within 16 and tried to craft a new one: `need 8 more cobblestone`.
  3. After a manual `go_to` back, the third loaded 3 raw_iron + 1 coal and 31 s later took 3 iron_ingot.
  
  Smelt now remembers the furnace it used last and goes back to it if it is within 64 blocks.
- Interrupt and re-entry: a zombie was summoned 4 blocks away during a smelt. The furnace window was closed on pre-empt, the reflex equipped its `stone_sword`, and smelt failed with `interrupted by fighting zombie`.
  - The next `smelt raw_iron 3` collected the 3 ingots waiting in the furnace.
  - In a second run, the re-entry counted the 2 raw_iron still loaded (`loaded 2, add 0`), and a last call collected the rest.
- `mine_block iron_ore` with only a wooden pickaxe: `need a tool: iron_ore drops nothing without stone_pickaxe or better; craft one first`. This used to dig forever with `+0`. In a plan it pauses the gather step as `step stuck`.
- Plan `gather 3 *_log → craft 1 wooden_pickaxe → craft 2 stick`: Jev chose `CRAFT` (p 0.99) for each craft step. Every step was completed by code, then `plan_done`.
- Plan `smelt 2 raw_iron → craft 1 stone_pickaxe`: done.
- Plan `craft 1 diamond_pickaxe`: paused at once with `can't craft 1 diamond_pickaxe: need 3 more diamond (have 0)`.
- `set_plan` refused `craft iron_ingot`, `craft woden_pickaxe` and `smelt dirt` with readable errors.
- `place_block torch` at explicit coordinates and at an auto spot. It refused an occupied cell (`-46 84 -2 is not empty (dirt)`) and an unsupported one (`nothing solid next to …`).

Test blocks (two tables, two furnaces, two torches) were removed with `setblock … air`, and the bot's inventory was restored afterwards. During testing:
- the time was set to day and not set back;
- the bot's pathing dug some terrain and used dirt and cobblestone as scaffolding;
- the zombie tests cost it health (topped up with instant_health).

## M5 check

Done on the server (difficulty easy), with a test client as steve standing still, then restored (position, health and inventory as before):
- `set_plan` "5 logs for steve" (gather 5 `*_log`, then come_to_player) via curl: the bot mined 5 pale oak logs (step done by code at 5/5), walked to steve, and `[EVENT] plan complete` posted 3 s later. Hermes (fresh session after `/new`) woke, called `give` for the 5 logs and answered in game.
- `gather deepslate_emerald_ore` → `dug 0/1 … no more … within 48 blocks` → `[EVENT] step stuck`, plan paused. Hermes explained in character that it needs an iron pickaxe and a way down.
- Burst: two infeasible plans 20 ms apart plus a temporary exposed `diamond_ore` 5 blocks away. The replaced plan emitted nothing, and the stuck event (held back by the min interval) and the diamond find went out as one `[EVENT] 2 events:` message.
- `kill mcbot` (temporary keep_inventory) → `[EVENT] died: mcbot was killed, at -40 77 38 …`.
- Validation: unknown kind, unknown key (`item`), non-numeric count, empty steps, and an item name for a block (`coal`) all fail with readable errors.
- Limiter against a fake clock: a 5-event burst plus a duplicate becomes one message at +3 s; later events wait out the 20 s interval and merge; with no interval, the 3-per-minute cap holds and merges the rest.

To check in game: in the room or game chat, ask Hermes "get me 20 logs". It should call `set_plan` (gather 20 `*_log`, then come_to_player). The bot works on its own, then `[EVENT] plan complete` (or `step stuck` if the trees run out) appears in the room and Hermes answers in game, normally with a `give`.

## M4 check

Verified on the server (difficulty easy), with a temporary 5-log column placed with `fill` and removed by the bot's mining:
- `CEREBELLUM_PLAN=logs`: the bot chose `GATHER` (p 1.0) and dug 2 logs. A zombie summoned 3 blocks away interrupted it: the reflex fought, the gather failed as `interrupted by fighting zombie` (transient), and the next tick restarted it for the 3 missing logs. Step done by code at 5/5. Then `come_to_player` with steve offline → `step_infeasible` escalation and the plan paused. No `mcp.call` and no Hermes traffic during the run.
- A (NoAI) creeper 4 blocks away: `FLEE` p 0.99, fled to 18 blocks, back to idle.
- With a test client as steve: `!plan {come_to_player}` → walked over, `plan_done`. "follow me" → local, followed 11 → 2 blocks. "stop" and "mcbot, wait here" → local. When "follow me" arrived during a reflex fight it failed open and went to Hermes.
- 19 tricky triage lines against live Jev: all bare commands local; "stop following me and chop some trees", "don't follow me", "follow me?", "wait what", "stop it lol", and an unnamed "stop" with another player online were forwarded.

Still to check in game with a real player: a long plan with steve actually walking around, ordinary chat still reaching Hermes with the `(handled locally)` prefix, and Hermes reacting to it sensibly after `/new`.

## Setup

1. Add the keys from `.env.example` to your `.env` (including `JEV_API` for the cerebellum). On a fresh checkout, copy it instead. Set `MC_EULA=TRUE` only after reading the EULA.
2. Matrix (one time): run `scripts/matrix-setup.sh` from the repo root. The brain is a Hermes profile, `PERSONA`, which defaults to `nova`. To use another, run `PERSONA=luna scripts/matrix-setup.sh`. The script:
   - registers the body's **own**, persona-neutral account, `@mcbot:example.com`. It refuses any account a Hermes profile already uses, such as `@nova` or `@luna`.
   - creates an **unencrypted** room (the bridge can't read E2EE) and invites the persona (`@nova`) and, optionally, you.
   - writes `MATRIX_ACCESS_TOKEN`, `MATRIX_ROOM` and `MATRIX_ALLOWED_SENDERS=<persona id>` into `.env`.
   - optionally updates `~/.hermes/profiles/<persona>/.env` (after a backup):
     - adds the bot to `MATRIX_ALLOWED_USERS`.
     - if the room has 3 members, adds it to `MATRIX_FREE_RESPONSE_ROOMS`. Hermes otherwise only replies to @-mentions in group rooms, and a 2-member room counts as a DM.
     - optionally sets `MATRIX_SESSION_SCOPE=room`, so the room is one continuous session rather than a thread per message. This applies to all of the persona's group rooms.

   Switching personas later: re-run the script with the new `PERSONA`. It logs into the existing `@mcbot` and makes a new room. Also set `MC_NAME` in `.env` to match; the in-game name is currently `mcbot`.

   Then restart the Hermes gateway, and accept the room invite in Element.
3. Persona and memory live in Hermes, not in this repo. Set up how luna behaves in the Minecraft room on the Hermes side.
4. `docker compose up -d --build`, then join `localhost:25565` with a 26.1 client.
5. The server is private: the port only listens on 127.0.0.1, and a whitelist is enforced. To allow a player, run `scripts/whitelist.sh steve mcbot <other names...>`, listing everyone who should be allowed. It rewrites the whole list with offline-mode uuids. Don't use `/whitelist add` or itzg's `WHITELIST` env var: both store Mojang uuids, which never match on this offline server. Keep the bot's `MC_NAME` in the list.

## Hermes MCP config

Add this to the persona profile's `config.yaml` (`~/.hermes/profiles/<persona>/config.yaml`), and put `MINECRAFT_MCP_TOKEN=<same value as MCP_TOKEN>` in that profile's `.env`:

```yaml
mcp_servers:
  minecraft:
    url: http://127.0.0.1:3333/mcp
    headers:
      Authorization: "Bearer ${MINECRAFT_MCP_TOKEN}"
    timeout: 300
    connect_timeout: 15
```

How Hermes connects:
- The gateway keeps one persistent HTTP connection per server, sends a keepalive ping every 180 s, and reconnects with backoff.
- After repeated failures it parks the server, then retries every 5 minutes.
- `${VAR}` is filled in from the active profile's `.env`.

The server is stateless, so restarting Hermes or the bot never strands a session. The bot stays in the world while Hermes restarts.

Two things about Hermes sessions:
- **Tool lists are fixed per session.** A session keeps the tool list it started with. After adding or changing the MCP server, send `/new` in the game room to start a fresh session.
- **One conversation per room.** For this, set `group_sessions_per_user: false` in the root `~/.hermes/config.yaml` (the root config is the only place it's read), then restart the gateway. Its default, `true`, keeps a separate session per sender. Game chat, relayed by `@mcbot`, and your own messages in Element share one Hermes session. Each line still says who spoke: `[MC] steve: …` or your own name.

## M3 check (in game)

Tested from the server console, with no MCP or LLM calls in the logs:
- A summoned zombie and skeleton were killed with an auto-equipped iron sword.
- Under the Hunger effect it ate bread from food 0 to 20 and skipped the rotten flesh.
- Teleported to the bottom of a 5-deep river, it surfaced and walked ashore in about 5 s.
- It stepped out of fire (0.6 s) and lava (4 s).
- Armor was worn automatically.

Still to check with a player online:
1. `follow_player`, then a zombie: the bot fights, then resumes following.
2. `give` hands items to you.
3. Hermes uses `equip`/`eat` instead of narrating them.

Watch `docker compose logs -f mcbot | grep reflex`.

## M1 check

Say "hi" in game. Hermes's reply should appear in game chat within a few seconds, with no echo loop.
`docker compose logs -f mcbot` shows `bridge.game_to_matrix` / `bridge.matrix_to_game` events.
