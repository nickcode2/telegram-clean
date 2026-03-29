const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')

// safety
if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN missing')
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing')
  process.exit(1)
}

const app = express()

app.get('/', (req, res) => {
  res.send('OK')
})

// Telegram
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const userStates = {}

bot.on('message', async (msg) => {
  if (!msg.text) return

  const chatId = msg.chat.id
  const text = msg.text.toLowerCase()

  console.log('MSG:', text)

  // step 1
  if (text === 'do it') {
    userStates[chatId] = 'waiting_for_theme'
    bot.sendMessage(chatId, 'What theme?')
    return
  }

  // step 2
  if (userStates[chatId] === 'waiting_for_theme') {
    userStates[chatId] = null

    const theme = text

    bot.sendMessage(chatId, 'Ok, generating script...')

    try {
      // 🔥 ChatGPT call
      const response = await openai.chat.completions.create({
        model: 'gpt-5.3',
        messages: [
          {
            role: 'user',
            content: `Create a high-retention YouTube script about: ${theme}. Make it engaging and structured in scenes.`
          }
        ]
      })

      const script = response.choices[0].message.content

      // send result (split if too long)
      const chunks = script.match(/[\s\S]{1,3500}/g)

      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk)
      }

      bot.sendMessage(chatId, 'Done ✅')

    } catch (err) {
      console.error(err)
      bot.sendMessage(chatId, 'Error generating script')
    }

    return
  }

  bot.sendMessage(chatId, 'Send do it')
})

// server
const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.log('running on port', PORT)
})