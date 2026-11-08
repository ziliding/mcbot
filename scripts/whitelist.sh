#!/usr/bin/env bash
# Whitelist players on the offline-mode server with their OFFLINE uuids
# (md5("OfflinePlayer:<name>") as a v3 uuid). The server's own `whitelist add`
# and itzg's WHITELIST env look names up on Mojang and store premium uuids,
# which never match here. Usage: scripts/whitelist.sh steve mcbot ...
set -euo pipefail
[[ $# -gt 0 ]] || { echo "usage: $0 <name>..." >&2; exit 1; }
python3 -I - "$@" > mc-data/whitelist.json <<'PY'
import hashlib, json, sys, uuid
out = []
for n in sys.argv[1:]:
    h = bytearray(hashlib.md5(("OfflinePlayer:" + n).encode()).digest())
    h[6] = h[6] & 0x0F | 0x30; h[8] = h[8] & 0x3F | 0x80
    out.append({"uuid": str(uuid.UUID(bytes=bytes(h))), "name": n})
print(json.dumps(out, indent=2))
PY
docker exec uta-mc rcon-cli whitelist reload
docker exec uta-mc rcon-cli whitelist list
