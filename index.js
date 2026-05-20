#!/usr/bin/env node
require('dotenv').config()
const { runPipeline, startCron } = require('./scheduler')

const arg = (process.argv[2] || 'run').toLowerCase()

if (arg === 'start') {
  startCron()
} else if (arg === 'run') {
  runPipeline().catch((e) => {
    console.error(e)
    process.exit(1)
  })
} else if (arg === 'x-post') {
  // Forward remaining argv (e.g. --slot=morning) to x-poster
  require('./x-poster')
} else if (arg === 'test-telegram') {
  const { send } = require('./telegram')
  send('🤖 claude-tips-bot test message — Telegram delivery is working.')
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e.response?.data || e.message)
      process.exit(1)
    })
} else {
  console.log('Usage: node index.js [run|start|x-post|test-telegram]')
  process.exit(1)
}
