const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

const bot = new TelegramBot(process.env.BOT_TOKEN)

const userStates = {}

app.post('/webhook', (req, res) => {
  console.log('WEBHOOK HIT')

  try {
    if (!req.body) {
      console.log('no body')
      return res.sendStatus(200)
    }

    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (err) {
    console.error('ERROR:', err)
    res.sendStatus(200)
  }
})

bot.on('message', (msg) => {
  console.log('MSG:', msg.text)

  if (!msg.text) return

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

  bot.sendMessage(chatId, 'Send do it')
})

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log('running')
})