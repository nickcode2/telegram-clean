import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
})

bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text !== "do it") return

  try {
    await bot.sendMessage(chatId, "🚀 Starting 10s pipeline...")

    // =========================
    // 1. PROMPTS
    // =========================

    const prompts = [
      "A cinematic futuristic city under construction at sunset, engineers observing holographic blueprints, ultra realistic",
      "A massive futuristic megacity with flying vehicles and glowing architecture at dusk, ultra realistic",
    ]

    let images = []

    // =========================
    // 2. GENERATE IMAGES
    // =========================

    for (let i = 0; i < prompts.length; i++) {
      await bot.sendMessage(chatId, `🖼 Generating image ${i + 1}...`)

      const output = await replicate.run(
        "black-forest-labs/flux-2-max",
        {
          input: {
            prompt: prompts[i],
            aspect_ratio: "16:9",
          },
        }
      )

      const imageUrl = Array.isArray(output) ? output[0] : output

      images.push(imageUrl)

      await bot.sendPhoto(chatId, imageUrl)
    }

    await bot.sendMessage(chatId, "✅ Images done")

    // =========================
    // 3. GENERATE VIDEOS (KLING)
    // =========================

   let videos = []

for (let i = 0; i < images.length; i++) {
  try {
    await bot.sendMessage(chatId, `🎬 Generating video ${i + 1}...`)

    const output = await replicate.run(
      "kwaivgi/kling-v2.6",
      {
        input: {
          prompt: "cinematic camera movement, futuristic city, peaceful atmosphere, no violence, no conflict",
          start_image: images[i],
        },
      }
    )

    const videoUrl = Array.isArray(output) ? output[0] : output

    videos.push(videoUrl)

    await bot.sendVideo(chatId, videoUrl)

  } catch (err) {
    console.log("VIDEO FAILED:", i, err.message)

    await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed, skipping...`)

    // fallback (keeps pipeline stable)
    videos.push(images[i])

    continue
  }
}

await bot.sendMessage(chatId, "🎉 Videos done")

// =========================
// SERVER (Railway needs this)
// =========================

import express from "express"
const app = express()

const PORT = process.env.PORT || 3000

app.get("/", (req, res) => {
  res.send("Bot is running")
})

app.listen(PORT, () => {
  console.log("Server running")
})