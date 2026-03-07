# Bill and Danney Solana Token

This creates a Solana SPL token with:
- Name: `Bill and Danney`
- Symbol: `BND`
- Supply: `69,000,000,000`
- Decimals: `8` (default)

## 1) Install dependencies

```bash
npm install
```

## 2) Run token creation

By default this runs on devnet and uses `~/.config/solana/id.json` as the payer keypair.

```bash
npm run create-token
```

If you do not have a keypair yet, create one:

```bash
node -e 'const fs=require("fs");const {Keypair}=require("@solana/web3.js");const kp=Keypair.generate();fs.writeFileSync("devnet-id.json", JSON.stringify(Array.from(kp.secretKey)));console.log("Pubkey:", kp.publicKey.toBase58());'
```

Then run:

```bash
KEYPAIR_PATH=/absolute/path/to/devnet-id.json npm run create-token
```

If devnet faucet requests are rate-limited, fund the wallet manually at [faucet.solana.com](https://faucet.solana.com/) and rerun.

## Optional environment variables

```bash
RPC_URL=https://api.devnet.solana.com
KEYPAIR_PATH=/absolute/path/to/id.json
TOKEN_NAME="Bill and Danney"
TOKEN_SYMBOL=BND
TOKEN_URI=https://example.com/bill-and-danney.json
SUPPLY=69000000000
DECIMALS=8
```

Example:

```bash
RPC_URL=https://api.devnet.solana.com KEYPAIR_PATH=$HOME/.config/solana/id.json npm run create-token
```

## Mainnet

To create on mainnet, set:

```bash
RPC_URL=https://api.mainnet-beta.solana.com npm run create-token
```

Use a funded keypair and double-check settings before mainnet execution.

## Creative Function: Proof-of-Burn Jackpot

This adds a game mechanic to your existing token mint:
- `enter`: burn tokens to enter a round
- `draw`: verifiably pick weighted winner + mint jackpot reward

Streak multiplier:
- each consecutive day entered increases entry weight
- weight uses basis points: `10000 + bonus`
- default bonus is `+1000` bps per day (`+10%`) up to `7` bonus days

It works with your current mint (must still have mint authority for `draw`).

### Enter a round

```bash
MINT_ADDRESS=76oyjeJhvauL1zGXQAP8vP4D3q45GLgWaPqzfxVccjFX \
KEYPAIR_PATH=/Users/alfredmunoz/Documents/Playground/my-keypair.json \
ROUND_ID=2026-03-01 \
ENTRY_AMOUNT=1000 \
STREAK_BONUS_BPS=1000 \
STREAK_MAX_BONUS_DAYS=7 \
npm run jackpot -- enter
```

### Draw winner for that round

```bash
MINT_ADDRESS=76oyjeJhvauL1zGXQAP8vP4D3q45GLgWaPqzfxVccjFX \
KEYPAIR_PATH=/Users/alfredmunoz/Documents/Playground/my-keypair.json \
ROUND_ID=2026-03-01 \
JACKPOT_AMOUNT=1000000 \
npm run jackpot -- draw
```

Round files and draw proof are saved in:

```bash
./jackpot-rounds/
```

## Reveal Market App (Polymarket-style MVP on Solana)

This repo now includes a local web app where users:
- hear teaser audio first
- bet HOT vs NOT using SOL transfer to escrow
- see reveal video only after reveal time
- resolve outcome and compute claim payouts

### Start app

```bash
npm install
PORT=8787 \
RPC_URL=https://api.devnet.solana.com \
ESCROW_WALLET=4Wu7JUY14o7K7VUZLZKeAqZNmvnHUTSDDW7P4EpCbyDD \
ADMIN_KEY=your-admin-secret \
npm run app:start
```

Open:

```bash
http://localhost:8787
```

### How betting works

1. User connects Phantom.
2. App sends SOL transfer from user wallet to escrow wallet.
3. Server verifies that transfer on-chain via transaction signature.
4. Bet is recorded only if signature is valid and unused.

### Commit-reveal flow

1. On create:
   - UI computes `sha256(revealVideoUrl|revealSecret)`
   - server stores only the commitment hash
2. On reveal:
   - admin submits `revealVideoUrl + revealSecret`
   - server verifies commitment hash and unlocks video

### Resolve and claims

1. Admin resolves market as `HOT` or `NOT`.
2. Winners get proportional payout claims from total pool.
3. Claims are written to `data/markets-db.json`.

### Execute payouts from escrow

Use escrow private key to pay pending claims:

```bash
MARKET_ID=<market-id> \
RPC_URL=https://api.devnet.solana.com \
ESCROW_KEYPAIR_PATH=/absolute/path/to/escrow-id.json \
npm run app:settle
```

Dry run:

```bash
MARKET_ID=<market-id> DRY_RUN=true npm run app:settle
```

### Files

- API server: `server/index.js`
- DB helpers: `server/db.js`
- UI: `public/index.html`, `public/app.js`, `public/styles.css`
- Settlement script: `scripts/settle-market.js`

### Safety notes

- This is an MVP, not production custody infra.
- Add content moderation, legal compliance, KYC/geo controls, and consent verification before public launch.

## Added: Creator Verification + Moderation

The app now includes:
- creator verification submissions
- admin approval/rejection flow
- optional publish gate (`REQUIRE_VERIFIED_CREATOR=true`)
- user reports on markets
- admin report triage (resolved/dismissed/open + optional hide market)

Key endpoints:
- `POST /api/creator-verifications`
- `GET /api/creator-verifications/:wallet`
- `GET /api/admin/creator-verifications` (admin key)
- `POST /api/admin/creator-verifications/:wallet` (admin key)
- `POST /api/markets/:marketId/reports`
- `GET /api/admin/reports` (admin key)
- `POST /api/admin/reports/:reportId` (admin key)

## Added: Managed Postgres Option

By default app uses `data/markets-db.json`.

To use managed Postgres, set:

```bash
DATABASE_URL=postgres://...
```

Storage mode appears in `/api/config` as:
- `json-file`
- `postgres-jsonb`

## Added: On-Chain Anchor Program (Phase 2)

Folder:

```bash
onchain/
```

## Telegram Remote Control For Local Codex

This repo includes a small polling bot at `scripts/telegram-codex-bot.js` so you
can send Telegram messages to your local machine and have Codex run them without
interactive approval prompts.

### Setup

1. Create a Telegram bot with `@BotFather`.
2. Add these values to `.env`:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_ID=1603197641
TELEGRAM_ALLOWED_USER_ID=1603197641
TELEGRAM_WORKDIR=/Users/alfredmunoz/clawbot
TELEGRAM_ENABLE_SHELL=false
TELEGRAM_BOT_LOG_PATH=~/.spicywhite/logs/telegram-codex-bot.log
CODEX_DEFAULT_MODE=safe
CODEX_SAFE_SANDBOX=workspace-write
CODEX_SAFE_BYPASS=false
# optional if you want /codex_mode fast
# CODEX_FAST_SANDBOX=danger-full-access
# CODEX_FAST_BYPASS=false
```

Get your chat ID by sending the bot a message once, then opening:

```bash
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

### Run

```bash
npm run telegram:bot
```

### Telegram commands

- `/codex <prompt>` runs `codex exec` locally in the current mode.
- `/codex_plan <prompt>` asks Codex for a plan only using a read-only bridge setup.
- `/codex_status` shows mode, active run, workdir, and audit log location.
- `/codex_stop` stops the active run.
- `/codex_tail [bot|web|telegram|errors] [lines]` tails known logs only.
- `/codex_mode safe|fast` changes Codex execution mode.
- `/sh <command>` runs only an allowlisted command.
- plain text messages are treated as `/codex` prompts.

### Shell allowlist

When `TELEGRAM_ENABLE_SHELL=true`, `/sh` is restricted to:

- `ls`
- `pwd`
- `git status`
- `./spicywhite_ctl.sh status`
- `tail [-n N] bot|web|telegram|errors`

Arbitrary shell is not supported.

### Logging

Every Telegram bridge action is appended to:

```bash
~/.spicywhite/logs/telegram-codex-bot.log
```

Each entry includes sender info, exact prompt or command, cwd, exit code, and
git-tracked files changed in the configured workdir.

### Security

This is remote code execution by design. Restrict it to your own Telegram
chat/user IDs, keep the bot token secret, and prefer `CODEX_DEFAULT_MODE=safe`
with `TELEGRAM_ENABLE_SHELL=false`.

Program supports:
- `init_market`
- `place_bet`
- `lock_market`
- `reveal`
- `resolve`
- `claim`

Vault model:
- bets are transferred into the market PDA account
- winner claims are paid from that PDA via `invoke_signed`

### Build/Test on-chain program

Prereqs:
- Rust + Solana toolchain
- Anchor CLI

Commands:

```bash
cd onchain
npm install
anchor build
anchor test
```

Or from repo root:

```bash
npm run onchain:build
npm run onchain:test
```

## Deployment (Vercel + Render + Managed DB)

Files added:
- `render.yaml` (API + managed Postgres blueprint)
- `vercel.json` (frontend static deploy)
- `scripts/build-frontend.js` (injects runtime API origin)
- `public/runtime-config.js` (API base fallback)

### Deploy backend (Render)

1. Create Render blueprint from `render.yaml`.
2. Set `ESCROW_WALLET` to your custody wallet.
3. Use generated `ADMIN_KEY`.
4. Keep `DATABASE_URL` from Render managed Postgres.

### Deploy frontend (Vercel)

Set env var in Vercel project:

```bash
REVEAL_API_BASE=https://your-render-service.onrender.com
```

Vercel build command (already in `vercel.json`):

```bash
npm install && npm run frontend:build
```

This writes `dist/runtime-config.js` with your API origin.

## Quick Local Run (All Features)

```bash
npm install
cp .env.example .env
npm run app:start
```
