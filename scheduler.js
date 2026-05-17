const fs = require('fs')
const path = require('path')
const cron = require('node-cron')
const config = require('./config')
const { fetchAll } = require('./scraper')
const Curator = require('./curator')
const { send, formatDigest } = require('./telegram')

function todayInTz() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.scheduler.timezone })
}

function canonicalUrl(u) {
  return String(u || '').replace(/[#?].*$/, '').toLowerCase()
}

function loadRecentlySentUrls(dir, daysBack) {
  if (!fs.existsSync(dir)) return new Set()
  const cutoff = Date.now() - daysBack * 86400000
  const urls = new Set()
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^digest_(\d{4}-\d{2}-\d{2})\.json$/)
    if (!m) continue
    const t = new Date(m[1]).getTime()
    if (isNaN(t) || t < cutoff) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
      for (const it of data.items || []) if (it.url) urls.add(canonicalUrl(it.url))
    } catch {}
  }
  return urls
}

async function runPipeline() {
  const start = Date.now()
  const date = todayInTz()
  console.log(`\n${'='.repeat(60)}\n🚀 claude-tips-bot daily run — ${date}\n${'='.repeat(60)}\n`)

  const allItems = await fetchAll()
  if (allItems.length === 0) {
    console.warn('⚠️  No items fetched from any source. Aborting.')
    return
  }

  const daysBack = config.curator.dedupeAgainstRecentDays || 0
  let items = allItems
  if (daysBack > 0) {
    const seen = loadRecentlySentUrls(config.output.outputDir, daysBack)
    if (seen.size > 0) {
      const before = items.length
      items = items.filter((it) => !seen.has(canonicalUrl(it.url)))
      console.log(`🧹 Skipping ${before - items.length} items already sent in the last ${daysBack} days`)
    }
  }

  if (items.length === 0) {
    console.warn('⚠️  Nothing new since the last digest. Sending an empty digest.')
  }

  const curator = new Curator()
  const picked = items.length > 0 ? await curator.curate(items) : []
  console.log(`✅ ${picked.length} items selected for digest`)

  const message = formatDigest(picked, date)

  if (config.output.saveLocally) {
    if (!fs.existsSync(config.output.outputDir)) {
      fs.mkdirSync(config.output.outputDir, { recursive: true })
    }
    const file = path.join(config.output.outputDir, `digest_${date}.json`)
    // Merge with any existing same-day digest so URLs from earlier runs today
    // stay in the dedupe history; otherwise re-runs lose what was already sent.
    let existingItems = []
    if (fs.existsSync(file)) {
      try {
        const prev = JSON.parse(fs.readFileSync(file, 'utf-8'))
        if (Array.isArray(prev.items)) existingItems = prev.items
      } catch {}
    }
    const seenUrls = new Set(picked.map((it) => canonicalUrl(it.url)))
    const merged = [...picked, ...existingItems.filter((it) => !seenUrls.has(canonicalUrl(it.url)))]
    fs.writeFileSync(
      file,
      JSON.stringify({ date, generatedAt: new Date().toISOString(), items: merged }, null, 2),
    )
    console.log(`💾 Saved → ${file} (${picked.length} new + ${merged.length - picked.length} from earlier runs today)`)
  }

  await send(message)

  console.log(`⏱️  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
}

function startCron() {
  console.log(`⏰ Scheduler armed: "${config.scheduler.cron}" (${config.scheduler.timezone})`)
  cron.schedule(
    config.scheduler.cron,
    () => {
      runPipeline().catch((e) => console.error('❌ Pipeline failed:', e))
    },
    { timezone: config.scheduler.timezone },
  )
  console.log('🟢 Scheduler running. Press Ctrl+C to stop.')
}

module.exports = { runPipeline, startCron }
