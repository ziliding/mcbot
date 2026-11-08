# uta-mcbot

A Minecraft companion bot. Mineflayer controls the body in game, and a Matrix room carries the conversation with Hermes.
The full design (brain / cerebellum / reflexes, milestones M1–M6) is in the implementation plan. Status: **M1 (conversation round trip) is built and not yet verified in game.**

## Layout

| Service | What | Ports |
|---|---|---|
| `mc` | `itzg/minecraft-server`, vanilla `${MC_VER}` (26.1), offline mode | `127.0.0.1:25565` only |
| `mcbot` | single Node process: mineflayer bot + Matrix bridge | none |

`mcbot` also joins the external `matrix_default` network to reach the homeserver at `http://tailscale:6167`. Start the matrix compose project first.

Source is in `src/` (strict TypeScript):

- `body.ts` owns the one mineflayer instance, reconnects with backoff, parses player chat, and paces outgoing chat (256-char limit, newline split, never sends a line starting with `/`).
- `matrix.ts` is a minimal client-server API client: whoami, join, long-poll `/sync`. It waits 1.5 s after the last edit so streamed replies are sent once, complete.
- `main.ts` wires them together: game chat → `[MC] <player>: <text>` in the room, and room messages from allowed senders → game chat.
- `legacyQueue.ts` keeps the old `data/cmds.jsonl` queue and `data/state.json` working until the MCP server (M2) replaces them.

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

## M1 check

Say "hi" in game. Hermes's reply should appear in game chat within a few seconds, with no echo loop.
`docker compose logs -f mcbot` shows `bridge.game_to_matrix` / `bridge.matrix_to_game` events.
