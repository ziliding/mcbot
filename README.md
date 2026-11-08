# uta-mcbot

A Minecraft companion bot. Mineflayer controls the body in game, and a Matrix room carries the conversation with Hermes.
The full design (brain / cerebellum / reflexes, milestones M1–M6) is in the implementation plan. Status: **M1 (conversation round trip), M2 (MCP over HTTP in the same process), M3 (reflexes: fight, eat, escape water/lava/fire, wear armor) and M4 (cerebellum: Jev-driven behavior loop over typed plans, plus local chat triage) are done.** M5 (plan tools for Hermes, `[EVENT]` escalations into the room) is next.

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
  2. Fight hostile mobs within 8 blocks, and anything that hits it. It equips its best sword or axe and only hits at full attack strength. It never attacks creepers or wardens. It leaves endermen and piglins alone unless they attack. It never fights players, golems or villagers, and never blames unattributed damage (falls, starving) on a bystander.
  3. Eat the best safe food when food ≤ 14, or when health ≤ 14 and food < 20.
  4. Wear the best armor it carries.

  Fighting and escaping take the activity slot: `get_state.activity` shows `fighting zombie`, movement tools answer `busy: …`, and an interrupted `go_to` or `mine_block` fails with `interrupted by fighting zombie`. An interrupted follow resumes by itself.
- `cerebellum.ts` is the cerebellum (M4), see below. `jev.ts` wraps the TypeSafe SDK (timeouts, logging, cost), `plan.ts` holds the typed plan model, `worldstate.ts` builds the compact state Jev reads, and `triage.ts` decides which chat lines the body answers itself.
- `items.ts` is the item knowledge the reflexes and verbs share: food quality, weapon damage, armor rank.
- `mcp.ts` is a stateless MCP Streamable HTTP server at `/mcp` that exposes those verbs as tools. It requires `Authorization: Bearer $MCP_TOKEN`. `/health` takes no auth.

Every tool call is logged as an `mcp.call` event, with its arguments, duration and result. Reflexes log `reflex.fight`, `reflex.eat`, `reflex.escape`, `reflex.armor` and `reflex.resume`.

Why reflexes are hand-written rather than plugins (checked against mineflayer 4.39 and MC 26.1):
- `mineflayer-pvp` 1.3.2 (2022) calls `pathfinder.stop()`, which kills the next goto.
- `mineflayer-armor-manager` 2.0.1 (2023) has a hardcoded armor table with no copper armor.
- `mineflayer-auto-eat` 5.0.3 does load and read the 26.1 food registry. But it equips and eats on its own loop, independent of the activity slot, so it would swap items mid-fight or mid-dig.

Also, don't use `bot.oxygenLevel` in 4.39: it is overwritten by any nearby entity's air supply. `items.ts` `ownOxygen()` reads the bot's own metadata.

Loop prevention: the bot ignores its own game messages (by uuid and by name) and its own Matrix messages. System, death and join lines are not forwarded.

## Cerebellum (M4)

The brain (Hermes) is slow and expensive; the reflexes are instant but dumb. The cerebellum sits between them: a ~1 Hz loop that asks **Jev** (TypeSafe's System One model, `jev-1.14.0`) one batched request per tick and turns the typed answers into `Actions` calls. It needs `JEV_API`; without it the cerebellum and triage switch off and the bot behaves as in M3.

Each tick sends a compact world state (health/food as words, nearest hostile and how close, players, inventory summary, current activity and reflex, plan step with code-measured progress like "gathered 3 of 5, 2 more needed", last action and outcome) and four questions:
- **Choice** `behavior`: `FOLLOW_PLAYER | COME_TO_PLAYER | GATHER | MOVE_TO | FLEE | EAT | IDLE`. Only the options that make sense this tick are offered, always in that order (e.g. `GATHER` only during a gather step, `FLEE` only with a creeper/warden within 10 blocks, `EAT` only when hungry with food). There is no `FIGHT` (that's the reflexes) and no `CRAFT` (no crafting verb yet).
- **Noul** `step_done`, `step_feasible`, `danger`.

Policy (all in code, thresholds via env):
- Reflexes win: while one holds the activity slot, no call is made at all. An interrupted gather (`interrupted by fighting zombie`) is retried after the fight, never escalated.
- Commands from outside win over the plan: if Hermes (MCP) or a local chat command holds the slot, the cerebellum only watches, and may interject `FLEE`/`EAT`. After fleeing from a follow, it follows again.
- Switch only when the new behavior has p ≥ `CEREBELLUM_SWITCH_P` and beats the current one by `CEREBELLUM_MARGIN` (hysteresis); a high `danger` lowers the bar for `FLEE`/`EAT`.
- Step completion and progress are measured by code (inventory delta, distance); Jev's `step_done` is logged as a second opinion (`cerebellum.done_disagree`).
- Escalations (`cerebellum.escalate`, then the `onEvent` hook M5 will post to Matrix): top probability < `CEREBELLUM_LOW_CONF_P` for `CEREBELLUM_LOW_CONF_TICKS` ticks; the step judged infeasible for `CEREBELLUM_INFEASIBLE_TICKS` ticks or failing with "no more X nearby" / "player not online" (the plan pauses); a step failing twice; plan done. Same type + step at most once per `CEREBELLUM_ESCALATE_COOLDOWN_MS`.
- Calls are skipped when nothing changed (bucketed fingerprint; re-asked every `CEREBELLUM_MAX_STALE_MS` while something runs), when idle with no plan, and while a reflex or an outside command has nothing to interject. Skips are counted in `jev.usage`.
- Any explicit stop (chat or the MCP `stop` tool) pauses the plan.

Plans are typed (`plan.ts`): `gather {block, count}`, `move_to {x, y?, z}`, `come_to_player {player?}`, `wait {seconds}`, held in memory with a step index. M5 adds `set_plan`/`get_plan`/`clear_plan` on top of `PlanStore`.

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
