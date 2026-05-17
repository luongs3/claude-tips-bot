const OpenAI = require('openai')
require('dotenv').config()
const config = require('./config')

class Curator {
  constructor() {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing from environment')
    this.keys = process.env.OPENAI_API_KEY.split(',').map((k) => k.trim()).filter(Boolean)
    this.keyIdx = 0
    this._buildClient()
  }

  _buildClient() {
    this.client = new OpenAI({ apiKey: this.keys[this.keyIdx] })
  }

  _rotateKey() {
    if (this.keys.length < 2) return false
    this.keyIdx = (this.keyIdx + 1) % this.keys.length
    this._buildClient()
    console.log(`  🔁 Rotated to OpenAI key #${this.keyIdx + 1}/${this.keys.length}`)
    return true
  }

  async _safeCall(prompt) {
    let lastErr
    for (let attempt = 0; attempt < config.ai.maxRetries; attempt++) {
      try {
        const r = await this.client.chat.completions.create({
          model: config.ai.model,
          temperature: config.ai.temperature,
          max_completion_tokens: config.ai.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a meticulous curator who selects only actionable, high-signal items for a Vietnamese software engineer who builds AI agents and uses Claude heavily. All human-readable strings you produce (title_vi, why_useful_vi) MUST be written in Vietnamese (tiếng Việt) with proper diacritics. Never output Chinese, Japanese, Korean, or any other non-Vietnamese language in those fields — translate the source into Vietnamese instead. Always respond with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
        })
        return r.choices?.[0]?.message?.content || ''
      } catch (e) {
        lastErr = e
        const status = e.status || e.response?.status
        const msg = String(e.message || '')
        const isRateLimit = status === 429 || /quota|rate/i.test(msg)
        if (isRateLimit && this._rotateKey()) continue
        const wait = 1500 * Math.pow(2, attempt)
        console.warn(
          `  ⚠️  OpenAI error attempt ${attempt + 1} (status ${status || '?'}): ${msg.slice(0, 140)} → wait ${wait}ms`,
        )
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

    const maxItems = config.curator.maxItemsToSend
    const maxRepos = config.curator.maxReposInDigest

    return `Curate a daily digest for a software engineer who uses Claude (Anthropic) heavily and builds AI agents. KEEP only items that help him use AI/Claude/agents BETTER, or that materially affect most programmers.

KEEP if the item is:
- A concrete tip / technique (prompting, agent design, evals, dev workflow with AI) with a specific, repeatable takeaway
- A useful tool, library, MCP server, or Claude Code addon with a clear, non-obvious capability
- A noteworthy open-source repo whose specific differentiator you can name in one sentence
- A deep technical writeup that teaches a method or pattern
- A new model / API capability with concretely explained impact

REJECT if the item is:
- General news, funding rounds, hype, marketing, drama, opinion with no actionable takeaway
- Not specifically about AI / LLMs / agents / developer tooling for AI
- Aggregator titles ("Best of...", "Top 10 AI news today")
- Pure jobs / hiring posts
- A REPO whose only describable trait is a vague phrase like "powerful framework", "easy to use", "great for X" — for REPOS only, if you can't name a specific differentiator, REJECT.

HARD RULES:
- Return at most ${maxRepos} items with category "repo". Prefer tips / insights / tools.
- TARGET: aim to return ${maxItems} items. If you have fewer than ${maxItems} strong picks, fill the remaining slots with the next-best articles/tips/insights available — a short, slightly general takeaway from a quality source (Simon Willison, Anthropic, Latent Space, Lilian Weng, Hamel, HN front-page Claude/agent posts) is better than no item. Only drop items that are truly off-topic, pure hype, or duplicates.
- The "specific differentiator" requirement applies to REPOS. For articles/tips/insights, a clear topic sentence in why_useful_vi is enough.
- LANGUAGE: "title_vi" and "why_useful_vi" MUST be written in VIETNAMESE (tiếng Việt) with Vietnamese diacritics. NEVER use Chinese, Japanese, Korean, or any other language. If the source item is in Chinese/another language, TRANSLATE the meaning into Vietnamese — do not copy the original text. If you cannot translate it confidently into Vietnamese, DROP the item.
- Allowed exceptions inside Vietnamese text: proper nouns (product / repo / company names like "Claude Code", "CowAgent"), and short English technical terms that have no common Vietnamese equivalent (e.g. "LoRA", "MCP", "fine-tune", "agent"). Everything else must be Vietnamese.
- For REPOS, "why_useful_vi" should mention a specific technique, capability, number, or audience. Bad: "Cung cấp khung mạnh mẽ cho AI agents". Good: "Hỗ trợ tinh chỉnh 100+ LLM/VLM với LoRA/QLoRA; phù hợp khi cần fine-tune local".
- "title_vi" should be concise (≤100 chars) and informative — keep the original name for tools/repos, but any descriptive words must be Vietnamese.

Return JSON in EXACTLY this shape:
{
  "items": [
    {"id": <number>, "category": "tip"|"tool"|"repo"|"insight"|"news", "title_vi": "<concise Vietnamese rewrite, ≤100 chars>", "why_useful_vi": "<1-2 short Vietnamese sentences naming the specific takeaway/capability>"}
  ]
}

Priority order: most useful first (tips and insights before repos when quality is equal). Max ${maxItems} items.

Items:

${listing}`
  }

  async curate(items) {
    if (!items.length) return []

    // Drop low-quality repos before any scoring: tiny star counts and items
    // whose description is missing or just a marketing blurb are noise.
    const minStars = config.curator.minRepoStars ?? 0
    const beforeRepoFilter = items.length
    items = items.filter((it) => {
      if (it.type !== 'repo') return true
      if (typeof it.stars === 'number' && it.stars < minStars) return false
      if (!hasConcreteDescription(it)) return false
      return true
    })
    if (items.length < beforeRepoFilter) {
      console.log(
        `🧹 Dropped ${beforeRepoFilter - items.length} low-quality repos (<${minStars}⭐ or generic desc)`,
      )
    }

    if (!items.length) return []

    // Heuristic pre-filter with per-type quotas: guarantee articles reach the LLM
    // instead of being crowded out by repos.
    const cap = config.curator.maxItemsForLLM || items.length
    const repoCap = Math.min(config.curator.maxReposToLLM ?? cap, cap)
    const articleCap = cap - repoCap

    let candidates = items
    if (items.length > cap) {
      const scored = items.map((it) => ({ ...it, _score: scoreItem(it) }))
      scored.sort((a, b) => b._score - a._score)

      const repos = []
      const articles = []
      for (const it of scored) {
        if (it.type === 'repo' && repos.length < repoCap) repos.push(it)
        else if (it.type !== 'repo' && articles.length < articleCap) articles.push(it)
      }
      candidates = [...articles, ...repos]
      // Backfill any leftover slots with the next-best items regardless of type,
      // so a slow news day still uses the full LLM budget.
      if (candidates.length < cap) {
        const picked = new Set(candidates)
        for (const it of scored) {
          if (candidates.length >= cap) break
          if (!picked.has(it)) candidates.push(it)
        }
      }
      const repoCount = candidates.filter((x) => x.type === 'repo').length
      console.log(
        `✂️  Heuristic pre-filter: ${items.length} → ${candidates.length} (${candidates.length - repoCount} articles, ${repoCount} repos)`,
      )
    }

    console.log(`🤖 Curating ${candidates.length} items via OpenAI (${config.ai.model})...`)

    const batches = []
    for (let i = 0; i < candidates.length; i += config.ai.batchSize) {
      batches.push(candidates.slice(i, i + config.ai.batchSize))
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
        const parsed = JSON.parse(text)
        picks = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : []
      } catch {
        console.warn(`  ⚠️  Batch ${b + 1}: failed to parse JSON. Head: ${text.slice(0, 200)}`)
      }
      let droppedForCJK = 0
      for (const p of picks) {
        const orig = batch[p.id]
        if (!orig) continue
        if (containsCJK(p.title_vi) || containsCJK(p.why_useful_vi)) {
          droppedForCJK++
          continue
        }
        curated.push({
          ...orig,
          category: ['tip', 'tool', 'repo', 'insight', 'news'].includes(p.category) ? p.category : 'news',
          titleVi: p.title_vi || orig.title,
          whyVi: p.why_useful_vi || '',
        })
      }
      if (droppedForCJK) {
        console.warn(`  ⚠️  Batch ${b + 1}: dropped ${droppedForCJK} item(s) with non-Vietnamese (CJK) text`)
      }
      if (b < batches.length - 1) await new Promise((r) => setTimeout(r, config.ai.delayBetweenRequests))
    }

    if (curated.length === 0 && items.length > 0) {
      console.warn(
        `⚠️  OpenAI returned no items (${allBatchesFailed ? 'all batches failed' : 'no picks'}); falling back to heuristic ranker.`,
      )
      return heuristicCurate(items, config.curator.maxItemsToSend)
    }

    return enforceRepoCap(curated, config.curator.maxReposInDigest).slice(
      0,
      config.curator.maxItemsToSend,
    )
  }
}

// Keep only the first N repos (LLM order is "best first"); preserves all non-repo items.
function enforceRepoCap(items, maxRepos) {
  if (!Number.isFinite(maxRepos)) return items
  let repoCount = 0
  const out = []
  for (const it of items) {
    if (it.category === 'repo') {
      if (repoCount >= maxRepos) continue
      repoCount++
    }
    out.push(it)
  }
  return out
}

const GENERIC_DESC_PATTERNS = [
  /^(a |an |the )?(simple|powerful|easy|lightweight|modern|flexible|elegant)\b/i,
  /^(framework|library|toolkit|platform) (for|to)\b/i,
  /^awesome[- ]/i,
  /\(no description\)/i,
]

// CJK Unified Ideographs (U+4E00–U+9FFF) + Hiragana/Katakana + Hangul.
// Vietnamese uses Latin script with diacritics, so any CJK codepoint means the
// model echoed the source language instead of translating.
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/

function containsCJK(s) {
  return typeof s === 'string' && CJK_RE.test(s)
}

function hasConcreteDescription(it) {
  // it.summary for repos looks like: "<desc> | ⭐N | <lang> | pushed YYYY-MM-DD"
  const desc = String(it.summary || '').split('|')[0].trim()
  if (!desc || desc.length < 20) return false
  if (/^\(no description\)/i.test(desc)) return false
  for (const p of GENERIC_DESC_PATTERNS) if (p.test(desc)) return false
  return true
}

// Source weights for heuristic ranking when the LLM is unavailable.
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
  if (it.source && it.source.startsWith('GitHub')) {
    // Repos start lower than curated blogs and need stars to climb.
    s += 5
  } else {
    s += SOURCE_WEIGHT[it.source] || 6
  }

  const t = (it.title || '').toLowerCase()
  for (const k of GOOD_KEYWORDS) if (t.includes(k)) s += 2
  for (const k of BAD_KEYWORDS) if (t.includes(k)) s -= 5

  if (typeof it.stars === 'number') {
    // log10(500)≈2.7, log10(10k)=4 — capped so a mega-star repo can't outrank a
    // strong tip from Simon Willison purely on popularity.
    s += Math.min(4, Math.log10(it.stars + 1))
  }
  if (typeof it.score === 'number') s += Math.min(3, Math.log10(it.score + 1))

  if (it.publishedAt) {
    const ageH = (Date.now() - new Date(it.publishedAt).getTime()) / 3600000
    if (ageH < 24) s += 2
    else if (ageH < 48) s += 1
  }

  return s
}

function heuristicCurate(items, maxItems) {
  const maxRepos = config.curator.maxReposInDigest ?? maxItems
  const scored = items.map((it) => ({ ...it, _score: scoreItem(it) }))
  scored.sort((a, b) => b._score - a._score)

  const out = []
  let repoCount = 0
  for (const it of scored) {
    if (out.length >= maxItems) break
    if (it.type === 'repo') {
      if (repoCount >= maxRepos) continue
      repoCount++
    }
    out.push(it)
  }
  return out.map((it) => ({
    ...it,
    category: it.type === 'repo' ? 'repo' : 'insight',
    titleVi: it.title,
    whyVi: `(auto-ranked — LLM unavailable, score ${it._score.toFixed(1)})`,
  }))
}

module.exports = Curator
