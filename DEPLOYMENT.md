# Deploying MEME SNIPER

Everything you need to run this locally, and to run it on Render.

**Read §2 before you deploy anywhere.** Hosting turns two local conveniences
into fund-losing bugs: an ephemeral disk, and a publicly reachable dashboard.

---

## 1. Local

### Requirements

- **Node 20+** (`node -v`)
- npm

### Run it

```bash
npm install
cp .env.example .env     # then edit it — at minimum set RPC_URL
npm start
```

Open **http://localhost:8787**. The session token is printed at boot; the
dashboard picks it up automatically because it is served from the same origin.

Then, in the UI:

1. **Keystore** → choose a passphrase. Creates `data/keystore.enc`.
2. **Add wallet** → creates a **burner wallet**. A fresh one is generated for you.
3. **Fund** it from your own wallet, or skip this — dry run uses a paper balance.
4. **Start engine**.

### Files it creates

| Path | What it is | Back it up? |
|---|---|---|
| `data/keystore.enc` | Your wallets' private keys, AES-256-GCM encrypted | **Yes, absolutely** |
| `data/config.json` | Wallets and settings (no secrets) | Nice to have |

**If you lose `data/keystore.enc` you lose the private keys**, and any SOL in those
wallets is gone. The passphrase is not recoverable — there is no reset, by design.
Copy the file somewhere safe, and store the passphrase in a password manager.

Both are in `.gitignore`. If you ever see `data/` staged in git, stop and fix it.

### Scripts

```bash
npm start              # run it
npm run dev            # run with auto-restart on file changes
npm test               # 71 tests
npm run keygen         # generate a keypair offline (prints public key only)
```

### Local troubleshooting

| Symptom | Cause |
|---|---|
| "PRICE FEED DOWN … exits are SUSPENDED" | Your RPC is rate-limiting. Use a paid endpoint. |
| Engine runs, never buys | `filters.minLiquiditySol` — see the tuning section in the README. |
| Wallet list empty | Keystore is locked. Unlock it; wallets load on unlock. |
| `EADDRINUSE` | Something is on the port. Set `PORT=8788`. |

---

## 2. ⚠ Hosting: two things that will bite you

### 2a. The filesystem is ephemeral — you need a persistent disk

On Render (and Railway, Fly, Heroku, most PaaS), **anything written inside the
repo is destroyed on every deploy and every restart.**

`data/keystore.enc` lives there by default. Deploy without a disk and you will
watch your encrypted keys evaporate — and with them, access to the funds in
those wallets. It will be silent until the day you need them.

Fix: a persistent disk, plus `DATA_DIR` pointing at it.

```yaml
disk:
  name: snipersol-data
  mountPath: /var/data
  sizeGB: 1
envVars:
  - key: DATA_DIR
    value: /var/data
```

`DATA_DIR` is honoured by both the keystore and the config loader, and a test
asserts they resolve to the same directory.

> **Render disks require a paid instance.** On the free tier there is no
> persistent storage, so the free tier is only safe for dry-run evaluation —
> anything you do there is wiped, keys included.

### 2b. The dashboard is publicly reachable

The service binds `0.0.0.0` and is exposed on a public URL. There is no user
account system — **the session token is the only authentication**, and it gates
config changes *and withdrawals*.

So on a hosted deployment:

- **Set `SESSION_TOKEN` explicitly** to a long random value
  (`openssl rand -hex 32`). Otherwise a new token is generated each boot and
  printed into the log stream, which on a team workspace may be readable by
  others. When the token comes from the environment it is *not* echoed at boot.
- Treat that token like a password. Anyone who has it can move your funds out.
- Prefer Render's IP allowlist or a private service if you have that option.

This is a deliberate design choice — one local tool, no accounts — but it means
*you* are the access control layer.

### 2c. The service must not sleep

A sniping bot has to be running when a token launches. Free instances spin down
after ~15 minutes without inbound traffic, so the bot simply is not running most
of the time. **Use a paid plan for anything beyond evaluation.**

### 2d. The keystore locks on every restart

Keys are held in memory and the keystore re-locks whenever the process restarts.
After a deploy you must open the dashboard and unlock it again.

That is fail-closed by design: a restart halts trading rather than resuming with
keys sitting in an environment variable. Plan for it — and note that any open
positions are **not** auto-closed on shutdown, so check them after a redeploy.

---

## 3. Render

### Option A — Blueprint (recommended)

`render.yaml` is included. It sets the disk, `DATA_DIR`, and the env vars.

1. Push the repo to GitHub.
2. Render → **New → Blueprint** → pick the repo.
3. Set the secrets marked `sync: false`:
   - `SESSION_TOKEN` — generated for you by the blueprint
   - `RPC_URL` — **your paid endpoint.** The public one will not hold up.
4. Apply. First deploy builds and starts.

### Option B — Manual web service

| Setting | Value |
|---|---|
| Environment | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instance type | Starter or above (disks need a paid plan) |

Then add:

- **Disk** → mount at `/var/data`, 1 GB
- **Env var** `DATA_DIR` = `/var/data`
- **Env var** `SESSION_TOKEN` = `openssl rand -hex 32`
- **Env var** `RPC_URL` = your endpoint

`PORT` is injected by Render and honoured automatically — do not set it yourself.

### Arming live trading headlessly

The dashboard has an arm button with a typed confirmation. For a server with no
browser, the same decision can be made from the environment — and it takes
**two** variables on purpose, because one variable is a typo away from arming a
bot with real money:

```bash
DRY_RUN=false
I_UNDERSTAND_THE_RISK=yes
```

`DRY_RUN=false` **alone will not arm it.** The app stays in dry run and logs why.
When both are present it logs a loud warning and trades live.

### First-run checklist on Render

1. Open the URL, unlock the keystore with your passphrase.
2. **Add wallet** → a burner is generated. Leave it unfunded for now.
3. Fund it from your own wallet via the **Fund** panel.
4. Start the engine in dry run. Confirm the scanner reports tokens and the
   price feed is healthy (`priceFeed.ok: true`).
5. Only then arm live trading.

### Verify a deployment

```bash
curl -s https://YOUR-APP.onrender.com/api/health
curl -s -H "x-session-token: $SESSION_TOKEN" https://YOUR-APP.onrender.com/api/status
```

In `/api/status`, check:

- `engine.scanner.connected` is `true` — the token feed is live
- `engine.priceFeed.ok` is `true` — exits can actually fire
- `engine.stats.infraErrors` is low relative to `evaluated` — your RPC is keeping up

If `priceFeed.ok` is `false` with 429s, stop. Nothing will exit.

---

## 4. Docker (any host)

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/var/data PORT=8787
VOLUME /var/data
EXPOSE 8787
CMD ["npm", "start"]
```

```bash
docker build -t snipersol .
docker run -d --name snipersol \
  -p 8787:8787 \
  -v snipersol-data:/var/data \
  -e RPC_URL=https://your-rpc \
  -e SESSION_TOKEN=$(openssl rand -hex 32) \
  snipersol
```

The `-v` volume is the same requirement as §2a. Without it, `docker rm` loses
your keys.

---

## 5. Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `./data` | Where keystore + config live. **Set this on any host with an ephemeral disk.** |
| `SESSION_TOKEN` | random per boot | Auth for all mutating routes. **Set this on any public host.** |
| `RPC_URL` | public mainnet | Solana endpoint. The public one rate-limits hard. |
| `RPC_WS_URL` | — | Optional websocket endpoint. |
| `PORT` | `8787` | HTTP port. Hosts usually inject this. |
| `SWAP_PROVIDER` | `pumpportal` | `pumpportal` \| `direct` \| `jupiter` |
| `PUMPPORTAL_API` | — | Optional PumpPortal key. |
| `DRY_RUN` | `true` | `false` requires `I_UNDERSTAND_THE_RISK=yes` too. |
| `I_UNDERSTAND_THE_RISK` | — | Must be exactly `yes` to arm live headlessly. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `trade` \| `warn` \| `error` |
| `LOG_RING_SIZE` | `500` | In-memory log records exposed to the UI. |
| `PRICE_POLL_MS` | `1200` | How often open positions are marked to market. |
| `OPENAI_API_KEY` etc. | — | Enables the AI veto layer. |

---

## 6. Operational notes

- **Back up `data/keystore.enc` once, and again after adding wallets.** A
  snapshot is only current if it includes the wallets you have now.
- **Withdrawals ignore dry run.** That is deliberate — see the README.
- **Shutdown does not close positions.** If you stop the service with positions
  open, they stay open on chain. Flatten first if you want a clean stop.
- **Rotating the RPC** is a config change: update `RPC_URL` and restart. Open
  positions keep tracking as long as the endpoint can read the bonding curve.
- **Scaling past one instance is not supported.** Positions, stats and the
  price cache are in-process; a second instance would double-trade. Render's
  `numInstances` must stay at 1.
