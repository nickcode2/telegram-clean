import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import axios from "axios"
import fs from "fs"
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
    await bot.sendMessage(chatId, "🚀 Starting pipeline...")

    const script = [
      "Massive futuristic cities are being built faster than ever.",
      "Thousands of workers coordinate every detail behind the scenes.",
    ]

    let durations = []

    for (let i = 0; i < script.length; i++) {
      durations.push(5) // temp fallback (we already tested audio)
    }

    // =========================
    // IMAGES
    // =========================

    const prompts = [
      "wide futuristic city under construction, workers visible, realistic lighting",
      "engineers coordinating large scale project, people present, cinematic realism",
    ]

    let images = []

    for (let i = 0; i < prompts.length; i++) {
      await bot.sendMessage(chatId, `🖼 Image ${i + 1}`)

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
    }

    await bot.sendMessage(chatId, "✅ Images done")

    // =========================
    // VIDEOS → TRIM
    // =========================

    let clips = []

    for (let i = 0; i < images.length; i++) {
      await bot.sendMessage(chatId, `🎬 Video ${i + 1}`)

      const output = await replicate.run(
        "kwaivgi/kling-v2.6",
        {
          input: {
            prompt: "slow cinematic movement, people working, realistic",
            start_image: images[i],
          },
        }
      )

      const videoUrl = Array.isArray(output) ? output[0] : output

      const videoPath = `video${i}.mp4`
      const response = await axios.get(videoUrl, { responseType: "stream" })

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(videoPath)
        response.data.pipe(writer)
        writer.on("finish", resolve)
        writer.on("error", reject)
      })

      const trimmed = `clip${i}.mp4`

      execSync(
        `ffmpeg -y -i ${videoPath} -t ${durations[i]} -c copy ${trimmed}`
      )

      clips.push(trimmed)
    }

    await bot.sendMessage(chatId, "✅ Clips ready")

    // =========================
    // MERGE CLIPS
    // =========================

    const listFile = "list.txt"
    const content = clips.map(c => `file '${c}'`).join("\n")
    fs.writeFileSync(listFile, content)

    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy merged.mp4`
    )

    await bot.sendMessage(chatId, "🎞 Video merged")

    // =========================
    // ADD BACKGROUND MUSIC
    // =========================

    // put your music file in repo root: music.mp3

    execSync(
      `ffmpeg -y -i merged.mp4 -i music.mp3 -map 0:v -map 1:a -shortest -c:v copy -c:a aac final.mp4`
    )

    await bot.sendVideo(chatId, "final.mp4")

    await bot.sendMessage(chatId, "🎉 FINAL VIDEO READY")

  } catch (err) {
    console.log(err)
    await bot.sendMessage(chatId, "❌ Failed")
  }
})

// SERVER
const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => res.send("OK"))
app.listen(PORT)