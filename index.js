const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing')
  process.exit(1)
}

const app = express()
app.use(express.json())

const bot = new TelegramBot(process.env.BOT_TOKEN)

// simple memory for user state
const userStates = {}

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body)
  res.sendStatus(200)
})

bot.on('message', (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text === 'do it') {
    userStates[chatId] = 'waiting_for_theme'
    bot.sendMessage(chatId, 'What theme?')
    return
  }

  if (userStates[chatId] === 'waiting_for_theme') {
    userStates[chatId] = null
    bot.sendMessage(chatId, 'Ok, working on it...')
    return
  }

  bot.sendMessage(chatId, 'Send "do it" to start')
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log('running on port ' + PORT)
})