import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import fs from "fs"
import axios from "axios"
import { execSync } from "child_process"

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

    const prompts = [
      "wide cinematic futuristic city under construction at sunset, engineers standing still observing skyline, realistic lighting, calm atmosphere",
      "aerial view of futuristic city with clean architecture, people walking slowly, neutral expressions, peaceful environment",
    ]

    let images = []

    // IMAGE LOOP
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

    let videos = []

    // VIDEO LOOP
    for (let i = 0; i < images.length; i++) {
      await bot.sendMessage(chatId, `🎬 Generating video ${i + 1}...`)

      const output = await replicate.run(
        "kwaivgi/kling-v2.6",
        {
          input: {
            prompt: "slow cinematic camera movement, people standing or walking slowly, calm environment",
            start_image: images[i],
          },
        }
      )

      const videoUrl = Array.isArray(output) ? output[0] : output
      videos.push(videoUrl)

      await bot.sendVideo(chatId, videoUrl)
    }

    await bot.sendMessage(chatId, "🎬 Merging final video...")

    // DOWNLOAD VIDEOS
    const paths = []
    for (let i = 0; i < videos.length; i++) {
      const path = `video${i}.mp4`
      const response = await axios.get(videos[i], { responseType: "stream" })
      const writer = fs.createWriteStream(path)

      await new Promise((resolve, reject) => {
        response.data.pipe(writer)
        writer.on("finish", resolve)
        writer.on("error", reject)
      })

      paths.push(path)
    }

    // CREATE CONCAT FILE
    const concatText = paths.map(p => `file '${p}'`).join("\n")
    fs.writeFileSync("concat.txt", concatText)

    // MERGE WITH FFMPEG
    execSync("ffmpeg -f concat -safe 0 -i concat.txt -c copy output.mp4")

    // SEND FINAL VIDEO
    await bot.sendVideo(chatId, fs.createReadStream("output.mp4"))

    await bot.sendMessage(chatId, "🎉 Final video ready")

  } catch (err) {
    console.log(err)
    await bot.sendMessage(chatId, "❌ Pipeline failed")
  }
})

// SERVER
const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => {
  res.send("Bot is running")
})

app.listen(PORT, () => {
  console.log("Server running")
})