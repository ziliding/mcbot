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

1. `cp .env.example .env` and fill it in. Set `MC_EULA=TRUE` only after reading the EULA.
2. Matrix account for the bot (one time): register `@luna:example.com` with the registration token (for example in Element at http://127.0.0.1:18080). Then get a token for a dedicated device:
   ```bash
   curl -s -XPOST http://127.0.0.1:6167/_matrix/client/v3/login -H 'content-type: application/json' -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"luna"},"password":"<password>","initial_device_display_name":"uta-mcbot"}'
   ```
   Put `access_token` into `MATRIX_ACCESS_TOKEN`.
3. Create an **unencrypted** room. The bridge can't read E2EE rooms. Invite the bot and Hermes, and set `MATRIX_ROOM` and `MATRIX_ALLOWED_SENDERS` (Hermes's Matrix id).
4. Hermes side: add `@luna:example.com` to Hermes's allowed users for Matrix, or Hermes will ignore the bot's messages. Set up the room's persona there as well; persona and memory live in Hermes, not in this repo.
5. `docker compose up -d --build`, then join `localhost:25565` with a 26.1 client.

## M1 check

Say "hi" in game. Hermes's reply should appear in game chat within a few seconds, with no echo loop.
`docker compose logs -f mcbot` shows `bridge.game_to_matrix` / `bridge.matrix_to_game` events.
