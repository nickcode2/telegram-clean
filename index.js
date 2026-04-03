import TelegramBot from "node-telegram-bot-api"
import Replicate from "replicate"
import express from "express"
import axios from "axios"
import fs from "fs"
import { execSync } from "child_process"
import path from "path"
import { google } from "googleapis"

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { interval: 3000, autoStart: true },
})

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
})

let drive = null

// SAFE PARSE (fix crash)
try {
  const credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS || "{}")

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  })

  drive = google.drive({ version: "v3", auth })
} catch (e) {
  console.log("⚠️ GDRIVE DISABLED (invalid JSON)")
}

async function createFolder(name, parentId = null) {
  if (!drive) return null

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
  })
  return res.data.id
}

async function uploadFile(filePath, folderId) {
  if (!drive || !folderId) return

  await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [folderId],
    },
    media: {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(filePath),
    },
  })
}

const userState = {}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  const text = msg.text

  if (text === "do it") {
    userState[chatId] = { step: "waiting_theme" }
    await bot.sendMessage(chatId, "🧠 Send theme / link / text")
    return
  }

  if (userState[chatId]?.step === "waiting_theme") {
    userState[chatId] = { step: "processing" }

    try {
      await bot.sendMessage(chatId, "🚀 Starting...")

      const theme = text.split(" ").slice(0, 4).join("_")

      const mainFolder = await createFolder(theme)
      const imagesFolder = await createFolder("images", mainFolder)
      const videosFolder = await createFolder("videos", mainFolder)

      const prompts = [
        `${text}, realistic cinematic scene, people present`,
        `${text}, natural lighting, workers, documentary style`,
      ]

      let images = []
      let clips = []

      // IMAGES
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

        const imgPath = `image${i}.jpg`
        const res = await axios.get(imageUrl, { responseType: "stream" })

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(imgPath)
          res.data.pipe(writer)
          writer.on("finish", resolve)
          writer.on("error", reject)
        })

        images.push(imgPath)

        await bot.sendPhoto(chatId, imgPath)
        await uploadFile(imgPath, imagesFolder)
      }

      await bot.sendMessage(chatId, "✅ Images done")

      // VIDEOS
      for (let i = 0; i < images.length; i++) {
        await bot.sendMessage(chatId, `🎬 Video ${i + 1}`)

        const output = await replicate.run(
          "kwaivgi/kling-v2.6",
          {
            input: {
              prompt: `realistic motion, ${text}`,
              start_image: images[i],
            },
          }
        )

        const videoUrl = Array.isArray(output) ? output[0] : output

        const videoPath = `video${i}.mp4`
        const res = await axios.get(videoUrl, { responseType: "stream" })

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(videoPath)
          res.data.pipe(writer)
          writer.on("finish", resolve)
          writer.on("error", reject)
        })

        clips.push(videoPath)

        await bot.sendVideo(chatId, videoPath)
        await uploadFile(videoPath, videosFolder)
      }

      await bot.sendMessage(chatId, "🎬 Merging...")

      const list = clips.map(c => `file '${c}'`).join("\n")
      fs.writeFileSync("list.txt", list)

      execSync(`ffmpeg -y -f concat -safe 0 -i list.txt -c copy final.mp4`)

      await bot.sendVideo(chatId, "final.mp4")
      await uploadFile("final.mp4", videosFolder)

      await bot.sendMessage(chatId, "🎉 DONE")

    } catch (err) {
      console.log(err)
      await bot.sendMessage(chatId, "❌ Failed")
    }
  }
})

const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => res.send("OK"))
app.listen(PORT)