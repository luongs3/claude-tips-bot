const fs = require('fs')
const path = require('path')
const cron = require('node-cron')
const config = require('./config')
const { fetchAll } = require('./scraper')
const Curator = require('./curator')
const { enforceRepoCap } = require('./curator')
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

  // Permanent denylist: URLs known to have leaked through the rolling dedup
  // (typically because a digest_<date>.json went missing on the VPS).
  const denylist = new Set((config.curator.denylistUrls || []).map(canonicalUrl))
  if (denylist.size > 0) {
    const before = items.length
    items = items.filter((it) => !denylist.has(canonicalUrl(it.url)))
    if (items.length < before) {
      console.log(`🚫 Skipped ${before - items.length} item(s) from the permanent denylist`)
    }
  }

  // Diagnostic: per-type counts after dedup. Helps spot "all-repo" digests
  // before they ship (the cap should catch them, but if articles vanish we
  // want to know why).
  const counts = items.reduce((acc, it) => {
    acc[it.type] = (acc[it.type] || 0) + 1
    return acc
  }, {})
  console.log(`📊 Eligible after dedup+denylist: ${items.length} (${JSON.stringify(counts)})`)

  if (items.length === 0) {
    console.warn('⚠️  Nothing new since the last digest. Sending an empty digest.')
  }

  const curator = new Curator()
  let picked = items.length > 0 ? await curator.curate(items) : []

  // Belt-and-suspenders: if a future change to curator.js or stale code on the
  // VPS skips the cap, enforce it here too. Idempotent if curator already
  // capped.
  const beforeCap = picked.length
  picked = enforceRepoCap(picked, config.curator.maxReposInDigest).slice(
    0,
    config.curator.maxItemsToSend,
  )
  if (picked.length < beforeCap) {
    console.warn(`⚠️  Safety-net cap dropped ${beforeCap - picked.length} item(s) — curator returned too many repos`)
  }
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

  // X auto-poster slots: each fires the standalone x-poster with the slot name.
  const xSlots = config.scheduler.xSlots || []
  for (const slot of xSlots) {
    cron.schedule(
      slot.cron,
      () => {
        const { spawn } = require('child_process')
        console.log(`🐦 Firing x-poster slot=${slot.name}`)
        const child = spawn('node', [path.join(__dirname, 'x-poster.js'), `--slot=${slot.name}`], {
          stdio: 'inherit',
          env: process.env,
        })
        child.on('exit', (code) => console.log(`🐦 x-poster(${slot.name}) exit ${code}`))
      },
      { timezone: config.scheduler.timezone },
    )
    console.log(`  🐦 x-slot ${slot.name}: "${slot.cron}"`)
  }

  console.log('🟢 Scheduler running. Press Ctrl+C to stop.')
}

module.exports = { runPipeline, startCron }
