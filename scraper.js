const Parser = require('rss-parser')
const axios = require('axios')
const config = require('./config')

const parser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudeTipsBot/1.0)' },
  timeout: 30000,
})

const maxAgeMs = config.scraper.maxAgeHours * 3600 * 1000

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function withinFreshness(dateStr) {
  if (!dateStr) return true
  const t = new Date(dateStr).getTime()
  if (isNaN(t)) return true
  return Date.now() - t <= maxAgeMs
}

async function fetchRss(src) {
  try {
    const feed = await parser.parseURL(src.url)
    const items = (feed.items || [])
      .slice(0, config.scraper.perFeedLimit)
      .filter((i) => withinFreshness(i.isoDate || i.pubDate))
      .map((i) => ({
        source: src.name,
        type: 'article',
        title: (i.title || '').trim(),
        url: i.link,
        summary: stripHtml(i.contentSnippet || i.content || '').slice(0, 600),
        publishedAt: i.isoDate || i.pubDate || null,
      }))
      .filter((i) => i.title && i.url)
    console.log(`  ✓ RSS  ${src.name.padEnd(24)} → ${items.length}`)
    return items
  } catch (e) {
    if (!src.allowFail) console.warn(`  ✗ RSS  ${src.name.padEnd(24)} ${e.message}`)
    return []
  }
}

async function fetchGithub(src) {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(src.query)}&sort=stars&order=desc&per_page=${src.perPage}`
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ClaudeTipsBot/1.0',
    }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const { data } = await axios.get(url, { headers, timeout: 15000 })
    const items = (data.items || []).map((r) => ({
      source: `GitHub - ${src.name}`,
      type: 'repo',
      title: `${r.full_name} - ${r.description || ''}`.slice(0, 220),
      url: r.html_url,
      summary: `${r.description || '(no description)'} | ⭐${r.stargazers_count} | ${r.language || 'n/a'} | pushed ${(r.pushed_at || '').slice(0, 10)}`,
      stars: r.stargazers_count,
      publishedAt: r.pushed_at,
    }))
    console.log(`  ✓ GH   ${src.name.padEnd(24)} → ${items.length}`)
    return items
  } catch (e) {
    console.warn(`  ✗ GH   ${src.name.padEnd(24)} ${e.response?.status || ''} ${e.message}`)
    return []
  }
}

function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    const key = (it.url || '').replace(/[#?].*$/, '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

async function fetchAll() {
  console.log(
    `📡 Fetching ${config.rssSources.length} RSS, ${config.githubSources.length} GitHub sources...`,
  )
  const [rss, gh] = await Promise.all([
    Promise.all(config.rssSources.map(fetchRss)),
    Promise.all(config.githubSources.map(fetchGithub)),
  ])
  const all = dedupe([...rss.flat(), ...gh.flat()])
  console.log(`📊 ${all.length} unique items after dedup`)
  return all
}

module.exports = { fetchAll, fetchRss, fetchGithub, dedupe }
