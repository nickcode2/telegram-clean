const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

// safety check
if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing')
  process.exit(1)
}

const app = express()

// Railway needs a server running
app.get('/', (req, res) => {
  res.send('OK')
})

// 🔥 POLLING MODE (no webhook headaches)
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

// simple memory
const userStates = {}

bot.on('message', (msg) => {
  console.log('MSG:', msg.text)

  if (!msg.text) return

  const chatId = msg.chat.id
  const text = msg.text.toLowerCase()

  // step 1
  if (text === 'do it') {
    userStates[chatId] = 'waiting_for_theme'
    bot.sendMessage(chatId, 'What theme?')
    return
  }

  // step 2
  if (userStates[chatId] === 'waiting_for_theme') {
    userStates[chatId] = null
    bot.sendMessage(chatId, 'Ok, working on it...')
    return
  }

  // default
  bot.sendMessage(chatId, 'Send "do it"')
})

// start server
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log('running on port', PORT)
})