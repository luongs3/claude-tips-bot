const path = require('path')
const fs = require('fs')

// .env lives either next to index.js (standalone deployment) or one level up (nested inside ai-bot/).
const envCandidates = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]
const envPath = envCandidates.find((p) => fs.existsSync(p))
require('dotenv').config(envPath ? { path: envPath } : {})

const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)

module.exports = {
  rssSources: [
    { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/' },
    { name: 'Latent Space', url: 'https://www.latent.space/feed' },
    { name: 'Anthropic News', url: 'https://www.anthropic.com/rss/feed.xml', allowFail: true },
    { name: 'Hamel Husain', url: 'https://hamel.dev/index.xml' },
    { name: 'Lilian Weng', url: 'https://lilianweng.github.io/index.xml' },
    {
      name: 'HN - Claude/Agent',
      url: 'https://hnrss.org/newest?q=claude+OR+%22ai+agent%22+OR+anthropic+OR+%22claude+code%22&points=20',
    },
    { name: 'HN - Frontpage AI', url: 'https://hnrss.org/frontpage?q=AI+OR+LLM+OR+agent+OR+claude' },
    // Reddit feeds via public .rss (the JSON API now 403s without OAuth).
    { name: 'r/ClaudeAI', url: 'https://www.reddit.com/r/ClaudeAI/top/.rss?t=day' },
    { name: 'r/LocalLLaMA', url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day' },
    { name: 'r/AI_Agents', url: 'https://www.reddit.com/r/AI_Agents/top/.rss?t=day' },
  ],

  githubSources: [
    { name: 'claude-code topic', query: `topic:claude-code pushed:>${sevenDaysAgo}`, perPage: 10 },
    { name: 'ai-agent topic', query: `topic:ai-agent stars:>30 pushed:>${sevenDaysAgo}`, perPage: 10 },
    { name: 'mcp topic', query: `topic:mcp stars:>20 pushed:>${sevenDaysAgo}`, perPage: 10 },
    { name: 'llm+agent', query: `topic:llm topic:agent stars:>50 pushed:>${sevenDaysAgo}`, perPage: 5 },
  ],

  scraper: {
    perFeedLimit: 15,
    maxAgeHours: 48,
    summaryMaxChars: 250, // truncated at fetch time to keep LLM prompts small
  },

  ai: {
    provider: 'openai',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.3,
    maxOutputTokens: 1500,
    delayBetweenRequests: 1500,
    maxRetries: 5,
    batchSize: 60, // big enough that maxItemsForLLM fits in one API call
  },

  curator: {
    maxItemsToSend: 12, // final cap in the Telegram digest
    maxItemsForLLM: 25, // heuristic pre-filter to top N before calling the LLM
    maxReposToLLM: 10, // of the LLM slots, at most this many can be repos
    maxReposInDigest: 4, // hard cap on repos in the final Telegram digest
    minRepoStars: 500, // drop GitHub repos below this star count
    dedupeAgainstRecentDays: 7, // skip items already curated in the last N digests
    // Permanent denylist for URLs known to have leaked through the 7-day dedup
    // window (e.g. due to a missing/corrupt digest_<date>.json on the VPS).
    // Add the canonical URL (lowercase, no query/hash) of repeat offenders.
    denylistUrls: [
      'https://github.com/farion1231/cc-switch',
    ],
  },

  scheduler: {
    cron: '0 9 * * *',
    timezone: 'Asia/Ho_Chi_Minh',
    xSlots: [
      { name: 'morning',   cron: '30 9 * * *'  },
      { name: 'afternoon', cron: '0 14 * * *'  },
      { name: 'evening',   cron: '0 20 * * *'  },
    ],
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    parseMode: 'HTML',
  },

  output: {
    saveLocally: true,
    outputDir: path.join(__dirname, 'digests'),
  },
}
