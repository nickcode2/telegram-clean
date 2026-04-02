import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import axios from "axios"
import fs from "fs"
import { execSync } from "child_process"

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 3000, autoStart: true },
})

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
})

bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text !== "do it") return

  try {
    await bot.sendMessage(chatId, "🚀 Starting pipeline...")

    // =========================
    // SAFE PROMPTS
    // =========================

    const prompts = [
      "futuristic city under construction, workers present, realistic architecture, no violence, no weapons",
      "engineers planning a large scale city project, people present, cinematic lighting, no conflict",
    ]

    let images = []

    // =========================
    // IMAGES (FAIL SAFE)
    // =========================

    for (let i = 0; i < prompts.length; i++) {
      try {
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

      } catch (err) {
        console.log("IMAGE FAIL:", err.message)
        await bot.sendMessage(chatId, `⚠️ Image ${i + 1} failed`)

        // fallback image (empty but keeps pipeline running)
        images.push(null)
      }
    }

    await bot.sendMessage(chatId, "✅ Images done")

    // =========================
    // VIDEOS (FAIL SAFE)
    // =========================

    let clips = []

    for (let i = 0; i < images.length; i++) {
      try {
        if (!images[i]) throw new Error("No image")

        await bot.sendMessage(chatId, `🎬 Video ${i + 1}`)

        const output = await replicate.run(
          "kwaivgi/kling-v2.6",
          {
            input: {
              prompt: "slow cinematic camera movement, people working, realistic scene, no violence",
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

        clips.push(videoPath)

      } catch (err) {
        console.log("VIDEO FAIL:", err.message)
        await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed, skipping`)
      }
    }

    if (clips.length === 0) {
      await bot.sendMessage(chatId, "❌ All videos failed")
      return
    }

    await bot.sendMessage(chatId, "✅ Clips ready")

    // =========================
    // MERGE
    // =========================

    const listFile = "list.txt"
    const content = clips.map(c => `file '${c}'`).join("\n")
    fs.writeFileSync(listFile, content)

    execSync(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy merged.mp4`)

    // =========================
    // MUSIC (optional safe)
    // =========================

    if (fs.existsSync("music.mp3")) {
      execSync(
        `ffmpeg -y -i merged.mp4 -i music.mp3 -map 0:v -map 1:a -shortest -c:v copy -c:a aac final.mp4`
      )

      await bot.sendVideo(chatId, "final.mp4")
    } else {
      await bot.sendVideo(chatId, "merged.mp4")
    }

    await bot.sendMessage(chatId, "🎉 DONE")

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