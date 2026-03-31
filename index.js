const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')
const Replicate = require('replicate')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
})

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) return

  if (text.trim().toLowerCase() === 'do it') {
    await bot.sendMessage(chatId, 'Starting 10s pipeline...')
    runTest(chatId)
    return
  }

  await bot.sendMessage(chatId, 'Send do it')
})

async function runTest(chatId) {
  try {
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Create a short megaproject documentary theme. Return only title.' }
      ]
    })

    const theme = themeRes.choices[0].message.content.trim()
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    const imgPrompt1 = await generatePrompt(theme)
    const imgPrompt2 = await generatePrompt(theme)

    await bot.sendMessage(chatId, `Prompt 1:\n${imgPrompt1}`)
    await bot.sendMessage(chatId, `Prompt 2:\n${imgPrompt2}`)

    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(imgPrompt1)

    if (!img1) throw new Error('Image 1 invalid')

    await bot.sendMessage(chatId, img1) // DEBUG FIRST
    await bot.sendPhoto(chatId, { url: img1 })

    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(imgPrompt2)

    if (!img2) throw new Error('Image 2 invalid')

    await bot.sendMessage(chatId, img2) // DEBUG FIRST
    await bot.sendPhoto(chatId, { url: img2 })

    await bot.sendMessage(chatId, '✅ Images done')

  } catch (err) {
    console.error('MAIN ERROR:', err)
    await bot.sendMessage(chatId, `❌ ERROR:\n${err.message || err}`)
  }
}

async function generatePrompt(theme) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: `Create ONE ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.` }
    ]
  })

  return res.choices[0].message.content.trim()
}

async function generateImage(promptText) {
  try {
    const output = await replicate.run(
      "black-forest-labs/flux-2-pro",
      {
        input: {
          prompt: promptText,
          aspect_ratio: "16:9"
        }
      }
    )

    console.log("RAW OUTPUT:", output)

    // 🔥 normalize EVERYTHING into string URL

    let url = null

    if (typeof output === 'string') {
      url = output
    }

    else if (Array.isArray(output)) {
      url = output[0]
    }

    else if (output && typeof output === 'object') {

      if (output.url && typeof output.url === 'function') {
        url = output.url()
      }

      else if (output.url && typeof output.url === 'string') {
        url = output.url
      }

      else if (output[0]) {
        url = output[0]
      }
    }

    if (!url || typeof url !== 'string') {
      throw new Error('No valid image URL extracted')
    }

    return url

  } catch (err) {
    console.error('IMAGE ERROR:', err)
    throw err
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Server running')
})