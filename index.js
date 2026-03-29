const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()

// VERY IMPORTANT
app.use(express.json())

// health check (so Railway doesn’t show error page)
app.get('/', (req, res) => {
  res.send('OK')
})

const bot = new TelegramBot(process.env.BOT_TOKEN)

const userStates = {}

app.post('/webhook', (req, res) => {
  try {
    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (err) {
    console.error(err)
    res.sendStatus(200)
  }
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

  bot.sendMessage(chatId, 'Send do it')
})

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log('running on port ' + PORT)
})