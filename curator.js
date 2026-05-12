const { GoogleGenerativeAI } = require('@google/generative-ai')
require('dotenv').config()
const config = require('./config')

class Curator {
  constructor() {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing in .env')
    this.keys = process.env.GEMINI_API_KEY.split(',').map((k) => k.trim()).filter(Boolean)
    this.keyIdx = 0
    this._buildClient()
  }

  _buildClient() {
    const genAI = new GoogleGenerativeAI(this.keys[this.keyIdx])
    this.model = genAI.getGenerativeModel({
      model: config.ai.model,
      generationConfig: {
        temperature: config.ai.temperature,
        maxOutputTokens: config.ai.maxOutputTokens,
        responseMimeType: 'application/json',
      },
    })
  }

  _rotateKey() {
    if (this.keys.length < 2) return false
    this.keyIdx = (this.keyIdx + 1) % this.keys.length
    this._buildClient()
    console.log(`  🔁 Rotated to Gemini key #${this.keyIdx + 1}/${this.keys.length}`)
    return true
  }

  async _safeCall(prompt) {
    let lastErr
    for (let attempt = 0; attempt < config.ai.maxRetries; attempt++) {
      try {
        const r = await this.model.generateContent(prompt)
        return r.response.text()
      } catch (e) {
        lastErr = e
        const msg = String(e.message || '')
        const is429 = msg.includes('429') || /quota|rate/i.test(msg)
        if (is429 && this._rotateKey()) continue
        const wait = 1500 * Math.pow(2, attempt)
        console.warn(`  ⚠️  Gemini error attempt ${attempt + 1}: ${msg.slice(0, 140)} → wait ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
    throw lastErr
  }

  _buildPrompt(batch) {
    const listing = batch
      .map((it, idx) => {
        return `ID ${idx} [${it.type}/${it.source}]
Title: ${it.title}
URL: ${it.url}
Summary: ${(it.summary || '').slice(0, 400)}`
      })
      .join('\n\n---\n\n')

    return `You are curating a daily digest for a software engineer who uses Claude (Anthropic) heavily and builds AI agents. He wants ONLY actionable, high-signal items that help him use AI/Claude/agents BETTER.

KEEP if the item is:
- A concrete tip / technique (prompting, agent design, evals, dev workflow with AI)
- A useful tool, library, MCP server, or Claude Code addon
- A noteworthy open-source repo for AI agents / LLM apps
- A deep technical writeup that teaches a method or pattern
- A new model / API capability with clearly explained usefulness

REJECT if the item is:
- General news, funding rounds, hype, marketing, drama, opinion with no actionable takeaway
- Not specifically about AI / LLMs / agents / developer tooling for AI
- Vague aggregator titles ("Best of...", "Top 10 AI news today")
- Pure jobs / hiring posts

Rules:
- Output ONLY a JSON array. No prose, no markdown fences.
- Each kept item: {"id": number, "category": "tip"|"tool"|"repo"|"insight"|"news", "title_vi": string, "why_useful_vi": string}
- title_vi: a concise Vietnamese rewrite of the title (≤ 100 chars).
- why_useful_vi: 1-2 short Vietnamese sentences on what's concretely actionable.
- Priority order: most useful first. Max ${config.curator.maxItemsToSend} items per batch.

Items:

${listing}

JSON array:`
  }

  async curate(items) {
    if (!items.length) return []
    console.log(`🤖 Curating ${items.length} items via Gemini (${config.ai.model})...`)

    const batches = []
    for (let i = 0; i < items.length; i += config.ai.batchSize) {
      batches.push(items.slice(i, i + config.ai.batchSize))
    }

    const curated = []
    let allBatchesFailed = true
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]
      console.log(`  → batch ${b + 1}/${batches.length} (${batch.length} items)`)
      const prompt = this._buildPrompt(batch)
      let text
      try {
        text = await this._safeCall(prompt)
        allBatchesFailed = false
      } catch (e) {
        console.warn(`  ⚠️  Batch ${b + 1} failed entirely: ${e.message}`)
        continue
      }
      let picks = []
      try {
        picks = JSON.parse(text)
      } catch {
        const start = text.indexOf('[')
        const end = text.lastIndexOf(']')
        if (start >= 0 && end > start) {
          try {
            picks = JSON.parse(text.slice(start, end + 1))
          } catch {
            console.warn(`  ⚠️  Batch ${b + 1}: failed to parse JSON. Head: ${text.slice(0, 200)}`)
          }
        }
      }
      if (!Array.isArray(picks)) picks = []
      for (const p of picks) {
        const orig = batch[p.id]
        if (!orig) continue
        curated.push({
          ...orig,
          category: ['tip', 'tool', 'repo', 'insight', 'news'].includes(p.category) ? p.category : 'news',
          titleVi: p.title_vi || orig.title,
          whyVi: p.why_useful_vi || '',
        })
      }
      if (b < batches.length - 1) await new Promise((r) => setTimeout(r, config.ai.delayBetweenRequests))
    }

    if (curated.length === 0 && items.length > 0) {
      console.warn(
        `⚠️  Gemini returned no items (${allBatchesFailed ? 'all batches failed' : 'no picks'}); falling back to heuristic ranker.`,
      )
      return heuristicCurate(items, config.curator.maxItemsToSend)
    }

    return curated.slice(0, config.curator.maxItemsToSend)
  }
}

// Source weights for heuristic ranking when Gemini is unavailable.
const SOURCE_WEIGHT = {
  'Simon Willison': 10,
  'Anthropic News': 10,
  'Latent Space': 9,
  'Hamel Husain': 8,
  'Lilian Weng': 8,
  'HN - Claude/Agent': 6,
  'HN - Frontpage AI': 5,
  'r/ClaudeAI': 6,
  'r/LocalLLaMA': 5,
  'r/AI_Agents': 5,
}

const GOOD_KEYWORDS = [
  'claude code',
  'agent',
  'mcp',
  'prompt',
  'rag',
  'eval',
  'fine-tun',
  'workflow',
  'how to',
  'guide',
  'tutorial',
  'tip',
  'tricks',
  'patterns',
  'best practices',
  'open source',
]

const BAD_KEYWORDS = [
  'raises',
  'funding',
  'ipo',
  'acquires',
  'acquisition',
  'lawsuit',
  'valuation',
  'unicorn',
  'billion',
  'million',
  'startup raises',
  'lays off',
]

function scoreItem(it) {
  let s = 0
  if (it.source && it.source.startsWith('GitHub')) s += 7
  else s += SOURCE_WEIGHT[it.source] || 4

  const t = (it.title || '').toLowerCase()
  for (const k of GOOD_KEYWORDS) if (t.includes(k)) s += 2
  for (const k of BAD_KEYWORDS) if (t.includes(k)) s -= 5

  if (typeof it.stars === 'number') s += Math.min(5, Math.log10(it.stars + 1))
  if (typeof it.score === 'number') s += Math.min(3, Math.log10(it.score + 1))

  if (it.publishedAt) {
    const ageH = (Date.now() - new Date(it.publishedAt).getTime()) / 3600000
    if (ageH < 24) s += 2
    else if (ageH < 48) s += 1
  }

  return s
}

function heuristicCurate(items, maxItems) {
  const scored = items.map((it) => ({ ...it, _score: scoreItem(it) }))
  scored.sort((a, b) => b._score - a._score)
  return scored.slice(0, maxItems).map((it) => ({
    ...it,
    category: it.type === 'repo' ? 'repo' : 'insight',
    titleVi: it.title,
    whyVi: `(auto-ranked — Gemini unavailable, score ${it._score.toFixed(1)})`,
  }))
}

module.exports = Curator
