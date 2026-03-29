const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing')
  process.exit(1)
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing')
  process.exit(1)
}

const bot = new TelegramBot(process.env.BOT_TOKEN)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const userStates = {}

app.post('/webhook', async (req, res) => {
  try {
    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (err) {
    console.error(err)
    res.sendStatus(200)
  }
})

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) return

  if (text === 'do it') {
    userStates[chatId] = 'waiting_for_theme'
    bot.sendMessage(chatId, 'What theme?')
    return
  }

  if (userStates[chatId] === 'waiting_for_theme') {
    userStates[chatId] = null

    bot.sendMessage(chatId, 'Ok, working on it...')

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content:
              'Create ONE YouTube documentary theme about massive engineering, hidden infrastructure, or megaprojects. Return only one short title.'
          }
        ]
      })

      const result = response.choices[0].message.content

      bot.sendMessage(chatId, result)

    } catch (err) {
      console.error(err)
      bot.sendMessage(chatId, 'Error generating theme')
    }

    return
  }

  bot.sendMessage(chatId, 'Send do it')
})

const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log('running')
})