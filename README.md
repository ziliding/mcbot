# uta-mcbot

A Minecraft companion bot. Mineflayer controls the body in game, and a Matrix room carries the conversation with Hermes.
The full design (brain / cerebellum / reflexes, milestones M1–M6) is in the implementation plan. Status: **M1 (conversation round trip), M2 (MCP over HTTP in the same process) and M3 (reflexes: fight, eat, escape water/lava/fire, wear armor) are done.** M3 was tested from the server console; the in-game check with a player is still to do (see below).

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
  2. Fight hostile mobs within 8 blocks, and anything that hits it. It equips its best sword or axe and only hits at full attack strength. It leaves endermen and piglins alone unless they attack, and never fights players.
  3. Eat the best safe food when food ≤ 14, or when health ≤ 14 and food < 20.
  4. Wear the best armor it carries.

  Fighting and escaping take the activity slot: `get_state.activity` shows `fighting zombie`, movement tools answer `busy: …`, and an interrupted `go_to` or `mine_block` fails with `interrupted by fighting zombie`. An interrupted follow resumes by itself.
- `items.ts` is the item knowledge the reflexes and verbs share: food quality, weapon damage, armor rank.
- `mcp.ts` is a stateless MCP Streamable HTTP server at `/mcp` that exposes those verbs as tools. It requires `Authorization: Bearer $MCP_TOKEN`. `/health` takes no auth.

Every tool call is logged as an `mcp.call` event, with its arguments, duration and result. Reflexes log `reflex.fight`, `reflex.eat`, `reflex.escape`, `reflex.armor` and `reflex.resume`.

Why reflexes are hand-written rather than plugins (checked against mineflayer 4.39 and MC 26.1):
- `mineflayer-pvp` 1.3.2 (2022) calls `pathfinder.stop()`, which kills the next goto.
- `mineflayer-armor-manager` 2.0.1 (2023) has a hardcoded armor table with no copper armor.
- `mineflayer-auto-eat` 5.0.3 does load and read the 26.1 food registry. But it equips and eats on its own loop, independent of the activity slot, so it would swap items mid-fight or mid-dig.

Also, don't use `bot.oxygenLevel` in 4.39: it is overwritten by any nearby entity's air supply. `items.ts` `ownOxygen()` reads the bot's own metadata.

Loop prevention: the bot ignores its own game messages (by uuid and by name) and its own Matrix messages. System, death and join lines are not forwarded.

## Setup

1. Add the keys from `.env.example` to your `.env`. On a fresh checkout, copy it instead. Set `MC_EULA=TRUE` only after reading the EULA.
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
