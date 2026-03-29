const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const OpenAI = require('openai')

const app = express()
app.use(express.json())

app.get('/', (req, res) => {
  res.send('OK')
})

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (!text) return

  if (text === 'do it') {
    bot.sendMessage(chatId, 'Starting 10s pipeline...')
    runTest(chatId)
    return
  }

  bot.sendMessage(chatId, 'Send do it')
})

async function runTest(chatId) {
  try {
    const themeRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Create a short megaproject documentary theme. Return only title.' }
      ]
    })

    const theme = themeRes.choices[0].message.content
    await bot.sendMessage(chatId, `THEME:\n${theme}`)

    // SCENE 1 IMAGE PROMPT ONLY
    const imgPrompt1Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `Create ONE ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.` }
      ]
    })

    const imgPrompt1 = imgPrompt1Res.choices[0].message.content
    await bot.sendMessage(chatId, `Prompt 1:\n${imgPrompt1}`)

    // SCENE 2 IMAGE PROMPT ONLY
    const imgPrompt2Res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `Create another DIFFERENT ultra realistic cinematic image prompt about: ${theme}. Only return the image prompt.` }
      ]
    })

    const imgPrompt2 = imgPrompt2Res.choices[0].message.content
    await bot.sendMessage(chatId, `Prompt 2:\n${imgPrompt2}`)

    await bot.sendMessage(chatId, '🖼 Generating image 1...')
    const img1 = await generateImage(imgPrompt1)
    await bot.sendPhoto(chatId, img1)

    await bot.sendMessage(chatId, '🖼 Generating image 2...')
    const img2 = await generateImage(imgPrompt2)
    await bot.sendPhoto(chatId, img2)

    await bot.sendMessage(chatId, '✅ Images done')

  } catch (err) {
    console.error('MAIN ERROR:', err)
    bot.sendMessage(chatId, 'Error occurred')
  }
}

async function generateImage(promptText) {
  try {
    const start = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: "c221b2b8ef527988ecf4b6a6cde2baf9d1d6dbe2f5d5a63d315ff78eaefdd8af",
        input: {
          prompt: promptText,
          aspect_ratio: "16:9"
        }
      })
    })

    const prediction = await start.json()
    console.log('START:', prediction)

    if (!prediction.id) throw new Error('No prediction id')

    let result

    while (true) {
      await new Promise(r => setTimeout(r, 2000))

      const check = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
        headers: {
          Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
        }
      })

      result = await check.json()
      console.log('STATUS:', result.status)

      if (result.status === 'succeeded') break
      if (result.status === 'failed') throw new Error(JSON.stringify(result))
    }

    console.log('FINAL:', result)

    if (!result.output) throw new Error('No output')

    return Array.isArray(result.output)
      ? result.output[0]
      : result.output

  } catch (err) {
    console.error('IMAGE ERROR:', err)
    throw err
  }
}