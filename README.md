# claude-tips-bot

Daily curated digest of high-signal tips, tools, and repos to help you use **Claude / AI agents** more effectively. Delivered to Telegram at **09:00 Asia/Ho_Chi_Minh** every day.

## What it does

1. **Scrape** curated sources (RSS + Reddit JSON + GitHub Search API):
   - Simon Willison, Latent Space, Hamel Husain, Lilian Weng, Anthropic News
   - HN filtered for `claude / agent / anthropic` (min 20 points)
   - r/ClaudeAI, r/LocalLLaMA, r/AI_Agents (top of day)
   - GitHub repos under topics `claude-code`, `ai-agent`, `mcp`, `llm+agent` pushed in the last 7 days
2. **Curate** with Gemini (`gemini-2.0-flash`) — keeps only actionable tips / useful tools / noteworthy repos / deep technical writeups; drops hype, funding, and drama.
3. **Format** each item into a compact card (Vietnamese title + 1-2 sentence why-it-matters + source + link).
4. **Send** to Telegram (HTML mode, auto-chunked under the 4096-char limit) and save a JSON archive under `digests/`.

## Run

```bash
npm run tips              # one-shot run
npm run tips:start        # start cron (09:00 UTC+7 daily)
npm run tips:test-telegram # send a hello-world to verify the bot is wired up
```

## Env

On the VPS, `.env` lives at `/root/claude-tips-bot/.env`. Locally during dev, the file is read from the ai-bot repo root (one level above the bot dir).

```
OPENAI_API_KEY=        # required (comma-separated allowed for key rotation)
OPENAI_MODEL=          # optional, default gpt-4o-mini
TELEGRAM_BOT_TOKEN=    # required
TELEGRAM_CHAT_ID=      # required (the chat to deliver to)
GITHUB_TOKEN=          # optional — raises GitHub search rate limit
```

`.env` is gitignored AND excluded from rsync in the deploy workflow, so the VPS copy never gets clobbered. Update it directly on the VPS to rotate keys.

## Files

- `config.js` — sources, schedule, Gemini settings
- `scraper.js` — fetches RSS / Reddit / GitHub in parallel
- `curator.js` — Gemini batch filter with JSON-mode + key rotation
- `telegram.js` — message formatting + chunked sendMessage
- `scheduler.js` — pipeline orchestration + cron entrypoint
- `index.js` — CLI (`run` / `start` / `test-telegram`)
- `digests/digest_YYYY-MM-DD.json` — daily archive (gitignored)
