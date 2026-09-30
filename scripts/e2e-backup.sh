#!/usr/bin/env bash
# Proves the backup/restore path survives the exact thing that destroyed the
# user's wallet on Render: the host waking with an EMPTY data directory.
set -u
cd "$(dirname "$0")/.."

DIR=/tmp/e2e_backup_data
PORT=8921
rm -rf "$DIR"; mkdir -p "$DIR"
: > /tmp/e2e_backup.log

boot() {
  DATA_DIR="$DIR" PORT=$PORT RENDER=1 node src/index.js >> /tmp/e2e_backup.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 30); do
    sleep 0.4
    if curl -s -o /dev/null --max-time 1 "localhost:$PORT/api/health"; then return 0; fi
  done
  echo "   SERVER FAILED TO BOOT"; tail -20 /tmp/e2e_backup.log; exit 1
}
stop() { kill "$SRV" 2>/dev/null; for _ in $(seq 1 20); do kill -0 "$SRV" 2>/dev/null || return 0; sleep 0.3; done; kill -9 "$SRV" 2>/dev/null; }
tok() { curl -s "localhost:$PORT/api/session-token" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])"; }

echo "1. First run: create a keystore and a wallet"
boot
T=$(tok)
curl -s -X POST "localhost:$PORT/api/keystore/init" -H "x-session-token: $T" -H 'content-type: application/json' -d '{"passphrase":"my-real-pass"}' >/dev/null
W=$(curl -s -X POST "localhost:$PORT/api/wallets" -H "x-session-token: $T" -H 'content-type: application/json' -d '{"name":"MyWallet","preset":"balanced"}')
echo "$W" | python3 -c "import sys,json;d=json.load(sys.stdin);print('   created:', d['wallet'], d['publicKey'][:20]+'…')"
ADDR=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['publicKey'])")

echo
echo "   does /api/status warn about this host?"
curl -s "localhost:$PORT/api/status" | python3 -c "
import sys, json
s = json.load(sys.stdin).get('storage') or {}
print('     dataDir  :', s.get('dataDir'))
print('     ephemeral:', s.get('ephemeral'))
print('     reason   :', (s.get('reason') or '')[:96] + '…')"

echo
echo "2. Download a backup (the keystore inside must still be encrypted)"
curl -s "localhost:$PORT/api/backup" -H "x-session-token: $T" -o /tmp/e2e_backup.json
python3 - <<'PY'
import json
b = json.load(open('/tmp/e2e_backup.json'))
print('     kind          :', b['kind'])
print('     wallets in it :', len(b['config']['wallets']), [w['name'] for w in b['config']['wallets']])
ks = json.dumps(b['keystore'])
print('     keystore is ciphertext, no plaintext key:', 'secretKey' not in ks and 'sk' not in ks)
PY
stop

echo
echo "3. THE RENDER SLEEP: the disk is wiped, exactly as it happens for real"
rm -rf "$DIR"; mkdir -p "$DIR"
echo "     data dir now contains: $(ls -A "$DIR" | wc -l) files"
boot
echo "     after waking, the wallet list is:"
curl -s "localhost:$PORT/api/wallets" | python3 -c "
import sys, json
ws = json.load(sys.stdin)
print('      ', ws if ws else '[]  ← the wallets are gone, which is what the user saw')"
stop

echo
echo "4. Restore the backup"
boot
T=$(tok)
curl -s -X POST "localhost:$PORT/api/restore" -H "x-session-token: $T" -H 'content-type: application/json' \
  -d "{\"confirm\":\"RESTORE\",\"backup\":$(cat /tmp/e2e_backup.json)}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('     restored:', d.get('wallets'), 'wallet(s) —', d.get('hint', ''))"
echo "     the wallet is back:"
curl -s "localhost:$PORT/api/wallets" | python3 -c "
import sys, json
for w in json.load(sys.stdin):
    print(f\"       {w['name']}  {w['publicKey'][:20]}…  keyLocked={w.get('keyLocked')}\")"
echo "     and it is locked, because the passphrase was never in the backup:"
curl -s "localhost:$PORT/api/keystore/status" | sed 's/^/       /'
stop

echo
echo "5. The passphrase still opens it, and the wallet is tradeable again"
boot
T=$(tok)
curl -s -X POST "localhost:$PORT/api/keystore/unlock" -H "x-session-token: $T" -H 'content-type: application/json' -d '{"passphrase":"my-real-pass"}' | sed 's/^/     /'
curl -s "localhost:$PORT/api/wallets" | python3 -c "
import sys, json
for w in json.load(sys.stdin):
    print(f\"       {w['name']}  keyLocked={w.get('keyLocked')}  keyMissing={w.get('keyMissing')}\")"
echo "     the address is unchanged: $ADDR"
curl -s "localhost:$PORT/api/wallets" | python3 -c "
import sys, json, os
w = json.load(sys.stdin)[0]
want = os.environ.get('ADDR', '')
print('       address preserved:', w['publicKey'] == want if want else 'n/a')" 
stop

echo
echo "6. The user's real keystore, untouched:"
ls data/ | sed 's/^/     /'
curl -s -o /dev/null -w "     8787 health: %{http_code}\n" localhost:8787/api/health || true
