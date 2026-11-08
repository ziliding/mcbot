#!/usr/bin/env bash
# One-time Matrix setup for the bot. Run it yourself from the repo root:
#   scripts/matrix-setup.sh
#
# The "brain" is a Hermes profile (PERSONA, default nova). The bot's body has
# its own persona-neutral account, so you can swap brains without a new one:
#   PERSONA=luna scripts/matrix-setup.sh
#
# 1. Registers the body's account (default @mcbot) with the homeserver's
#    registration token, or logs in if it already exists.
# 2. Creates an UNENCRYPTED room and invites the persona (e.g. @nova) and you.
# 3. Writes MATRIX_ACCESS_TOKEN / MATRIX_ROOM / MATRIX_ALLOWED_SENDERS into ./.env.
# 4. Optionally updates the persona's Hermes profile so it answers the bot without @-mentions.
#
# Re-running with an existing account just logs in and makes a new room.
# Nothing secret is printed. Needs curl and jq.
set -euo pipefail

PERSONA="${PERSONA:-nova}"
HS="${HS:-http://127.0.0.1:6167}"
SERVER_NAME="${SERVER_NAME:-example.com}"
HERMES_ENV="${HERMES_ENV:-$HOME/.hermes/profiles/$PERSONA/.env}"
HERMES_ID="${HERMES_ID:-$(grep -E '^MATRIX_USER_ID=' "$HERMES_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)}"
HERMES_ID="${HERMES_ID:-@$PERSONA:$SERVER_NAME}"
HUMAN_ID="${HUMAN_ID:-@you:$SERVER_NAME}"
MATRIX_COMPOSE="${MATRIX_COMPOSE:-$HOME/projects/apps/matrix/docker-compose.yml}"
BOT_ENV="${BOT_ENV:-.env}"

die () { echo "error: $*" >&2; exit 1; }
ask () { local a; read -r -p "$1 [${2}] " a; echo "${a:-$2}"; }
confirm () { local a; read -r -p "$1 [Y/n] " a; [[ ! "$a" =~ ^[Nn] ]]; }

# Set KEY=VALUE in an env file (replace if present, else append).
set_kv () {
  local file=$1 key=$2 val=$3 tmp
  tmp=$(mktemp)
  { grep -vE "^${key}=" "$file" 2>/dev/null || true; printf '%s=%s\n' "$key" "$val"; } > "$tmp"
  cat "$tmp" > "$file"; rm -f "$tmp"
}
get_kv () { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
# Add an item to a comma-separated KEY in an env file, if missing.
add_csv () {
  local file=$1 key=$2 item=$3 cur
  cur=$(get_kv "$file" "$key")
  if [[ ",$cur," == *",$item,"* ]]; then echo "  $key already contains $item"; return; fi
  set_kv "$file" "$key" "${cur:+$cur,}$item"
  echo "  $key += $item"
}

api () { # METHOD PATH [JSON] ; uses $TOKEN if set
  local m=$1 p=$2 d=${3:-}
  curl -sS -X "$m" "$HS/_matrix/client/v3$p" -H 'content-type: application/json' \
    ${TOKEN:+-H "authorization: Bearer $TOKEN"} ${d:+-d "$d"}
}

command -v jq >/dev/null || die "jq is required (brew install jq)"
[[ -f docker-compose.yml && -f src/main.ts ]] || die "run from the uta-mcbot repo root"
curl -sf "$HS/_matrix/client/versions" >/dev/null || die "homeserver not reachable at $HS"

echo "== Bot account"
LOCALPART=$(ask "Body account localpart (persona-neutral, not a Hermes profile account)" "mcbot")
BOT_ID="@$LOCALPART:$SERVER_NAME"
grep -qsxF "MATRIX_USER_ID=$BOT_ID" "$HOME"/.hermes/profiles/*/.env && die "$BOT_ID is a Hermes profile's account; pick another name"
[[ "$BOT_ID" != "$HERMES_ID" ]] || die "$BOT_ID is the persona's account"

read -r -s -p "Password for $BOT_ID (new account: choose one; existing: enter it): " PASS; echo
[[ -n "$PASS" ]] || die "empty password"

TOKEN=""
AVAIL=$(api GET "/register/available?username=$LOCALPART" | jq -r '.available // false')
if [[ "$AVAIL" == "true" ]]; then
  read -r -s -p "Re-enter password: " PASS2; echo
  [[ "$PASS" == "$PASS2" ]] || die "passwords differ"
  REG_TOKEN=$(sed -nE 's/^[[:space:]]*TUWUNEL_REGISTRATION_TOKEN:[[:space:]]*"?([^"#[:space:]]+)"?.*/\1/p' "$MATRIX_COMPOSE" 2>/dev/null | head -1)
  if [[ -z "$REG_TOKEN" ]]; then read -r -s -p "Registration token: " REG_TOKEN; echo; fi
  BODY=$(jq -nc --arg u "$LOCALPART" --arg p "$PASS" '{username:$u,password:$p,initial_device_display_name:"uta-mcbot"}')
  SESSION=$(api POST /register "$BODY" | jq -r '.session // empty')
  [[ -n "$SESSION" ]] || die "registration did not start a UIA session"
  BODY=$(jq -c --arg t "$REG_TOKEN" --arg s "$SESSION" '. + {auth:{type:"m.login.registration_token",token:$t,session:$s}}' <<<"$BODY")
  RES=$(api POST /register "$BODY")
  echo "  registered $BOT_ID"
else
  echo "  $BOT_ID exists; logging in"
  BODY=$(jq -nc --arg u "$LOCALPART" --arg p "$PASS" '{type:"m.login.password",identifier:{type:"m.id.user",user:$u},password:$p,initial_device_display_name:"uta-mcbot"}')
  RES=$(api POST /login "$BODY")
fi
unset PASS PASS2 REG_TOKEN
TOKEN=$(jq -r '.access_token // empty' <<<"$RES")
[[ -n "$TOKEN" ]] || die "no access token: $(jq -r '.errcode + " " + (.error // "")' <<<"$RES")"
api PUT "/profile/$(jq -rn --arg x "$BOT_ID" '$x|@uri')/displayname" '{"displayname":"Minecraft body"}' >/dev/null || true

echo "== Room"
INVITE=("$HERMES_ID")
if confirm "Invite yourself ($HUMAN_ID) too, so you can watch and talk in the room?"; then
  INVITE+=("$HUMAN_ID")
  GROUP=1
else
  GROUP=0  # 2 members: Hermes treats it as a DM (no mention needed)
fi
CREATE=$(jq -nc --arg p "$PERSONA" --args '{name:($p + " · Minecraft"),topic:("Game chat bridge for " + $p + " in Minecraft"),preset:"private_chat",invite:$ARGS.positional}' "${INVITE[@]}")
ROOM_ID=$(api POST /createRoom "$CREATE" | jq -r '.room_id // empty')
[[ -n "$ROOM_ID" ]] || die "createRoom failed"
ENC=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" \
  "$HS/_matrix/client/v3/rooms/$(jq -rn --arg x "$ROOM_ID" '$x|@uri')/state/m.room.encryption/")
[[ "$ENC" == "404" ]] || echo "  WARNING: room appears to be encrypted; the bridge can't read it"
echo "  created $ROOM_ID (unencrypted), invited ${INVITE[*]}"

echo "== Bot .env ($BOT_ENV)"
touch "$BOT_ENV"; chmod 600 "$BOT_ENV"
set_kv "$BOT_ENV" MATRIX_ACCESS_TOKEN "$TOKEN"
set_kv "$BOT_ENV" MATRIX_ROOM "$ROOM_ID"
set_kv "$BOT_ENV" MATRIX_ALLOWED_SENDERS "$HERMES_ID"
echo "  wrote MATRIX_ACCESS_TOKEN, MATRIX_ROOM, MATRIX_ALLOWED_SENDERS"
unset TOKEN

echo "== Hermes profile ($HERMES_ENV)"
if [[ -f "$HERMES_ENV" ]] && confirm "Update Hermes's $PERSONA profile (backup is made first)?"; then
  cp "$HERMES_ENV" "$HERMES_ENV.bak.$(date +%Y%m%d%H%M%S)"
  add_csv "$HERMES_ENV" MATRIX_ALLOWED_USERS "$BOT_ID"
  if [[ $GROUP == 1 ]]; then
    add_csv "$HERMES_ENV" MATRIX_FREE_RESPONSE_ROOMS "$ROOM_ID"
    if confirm "Set MATRIX_SESSION_SCOPE=room (one continuous session per room instead of per-thread; affects all of $PERSONA's group rooms)?"; then
      set_kv "$HERMES_ENV" MATRIX_SESSION_SCOPE room; echo "  MATRIX_SESSION_SCOPE=room"
    fi
  fi
  echo "  Restart the Hermes gateway so it picks these up."
else
  echo "  Skipped. Add $BOT_ID to MATRIX_ALLOWED_USERS yourself$([[ $GROUP == 1 ]] && echo ", and $ROOM_ID to MATRIX_FREE_RESPONSE_ROOMS")."
fi

echo
echo "Done. Next: accept the room invite in Element, set MC_EULA in .env, then"
echo "  docker compose up -d --build && docker compose logs -f mcbot"
