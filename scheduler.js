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

async function runPipeline() {
  const start = Date.now()
  const date = todayInTz()
  console.log(`\n${'='.repeat(60)}\n🚀 claude-tips-bot daily run — ${date}\n${'='.repeat(60)}\n`)

  const items = await fetchAll()
  if (items.length === 0) {
    console.warn('⚠️  No items fetched from any source. Aborting.')
    return
  }

  const curator = new Curator()
  const picked = await curator.curate(items)
  console.log(`✅ ${picked.length} items selected for digest`)

  const message = formatDigest(picked, date)

  if (config.output.saveLocally) {
    if (!fs.existsSync(config.output.outputDir)) {
      fs.mkdirSync(config.output.outputDir, { recursive: true })
    }
    const file = path.join(config.output.outputDir, `digest_${date}.json`)
    fs.writeFileSync(
      file,
      JSON.stringify({ date, generatedAt: new Date().toISOString(), items: picked }, null, 2),
    )
    console.log(`💾 Saved → ${file}`)
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
