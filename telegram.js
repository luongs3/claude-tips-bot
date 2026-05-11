const axios = require('axios')
const config = require('./config')

const CATEGORY_EMOJI = {
  tip: '💡',
  tool: '🛠️',
  repo: '📦',
  insight: '🧠',
  news: '📰',
}

function htmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDigest(items, date) {
  const header = `<b>🤖 Claude/AI Daily Digest — ${htmlEscape(date)}</b>\n<i>Tips, tools &amp; repos to use AI better</i>`
  if (items.length === 0) return `${header}\n\n<i>No high-signal items today.</i>`

  const blocks = items.map((it, idx) => {
    const emoji = CATEGORY_EMOJI[it.category] || '🔹'
    const title = htmlEscape(it.titleVi || it.title)
    const src = htmlEscape(it.source)
    const why = it.whyVi ? htmlEscape(it.whyVi) : ''
    const url = htmlEscape(it.url)
    return [
      `${emoji} <b>${idx + 1}. ${title}</b>`,
      `<i>${src}</i>`,
      why,
      `<a href="${url}">🔗 Read</a>`,
    ]
      .filter(Boolean)
      .join('\n')
  })

  return [header, ...blocks].join('\n\n')
}

function chunkMessage(text, maxLen = 3800) {
  if (text.length <= maxLen) return [text]
  const parts = text.split('\n\n')
  const chunks = []
  let cur = ''
  for (const part of parts) {
    if (cur && (cur + '\n\n' + part).length > maxLen) {
      chunks.push(cur)
      cur = part
    } else {
      cur = cur ? `${cur}\n\n${part}` : part
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

async function send(text) {
  const { token, chatId, parseMode } = config.telegram
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured in .env')
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const chunks = chunkMessage(text)
  for (let i = 0; i < chunks.length; i++) {
    await axios.post(
      url,
      {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: parseMode,
        disable_web_page_preview: true,
      },
      { timeout: 20000 },
    )
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`📨 Telegram sent (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`)
}

module.exports = { send, formatDigest, chunkMessage }
