import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import path from "path"
import axios from "axios"
import { execSync } from "child_process"

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

let userState = {}

// ====== HELPERS ======

const TMP = "/tmp"

function ensureDirs() {
  const dirs = ["images", "videos", "audio", "music"]
  dirs.forEach(d => {
    const full = path.join(TMP, d)
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true })
  })
}

function cleanTmp() {
  fs.rmSync(TMP, { recursive: true, force: true })
}

async function downloadFile(url, filepath) {
  const res = await axios({ url, responseType: "stream" })
  const writer = fs.createWriteStream(filepath)
  res.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve)
    writer.on("error", reject)
  })
}

// ====== FAKE GENERATORS (WE WILL UPGRADE LATER) ======

async function generateScript(input) {
  return Array.from({ length: 10 }, (_, i) => ({
    text: `Scene ${i + 1} about ${input}`
  }))
}

async function generateImage(i) {
  const file = `${TMP}/images/img_${i}.jpg`
  await downloadFile("https://picsum.photos/1024", file)
  return file
}

async function generateVideo(i, imgPath) {
  const output = `${TMP}/videos/video_${i}.mp4`

  execSync(`
    ffmpeg -y -loop 1 -i ${imgPath} -t 5 -vf "scale=1280:720" -pix_fmt yuv420p ${output}
  `)

  return output
}

async function generateVoice(script) {
  const output = `${TMP}/audio/voice.mp3`

  execSync(`
    ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=10" ${output}
  `)

  return output
}

async function generateMusic() {
  const output = `${TMP}/music/music.mp3`

  execSync(`
    ffmpeg -y -f lavfi -i "sine=frequency=200:duration=10" ${output}
  `)

  return output
}

// ====== MERGE ======

async function mergeVideos(videoFiles) {
  const listFile = `${TMP}/videos/list.txt`

  fs.writeFileSync(
    listFile,
    videoFiles.map(v => `file '${v}'`).join("\n")
  )

  const output = `${TMP}/merged.mp4`

  execSync(`
    ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy ${output}
  `)

  return output
}

async function finalMerge(video, voice, music) {
  const output = `${TMP}/final.mp4`

  execSync(`
    ffmpeg -y -i ${video} -i ${voice} -i ${music} \
    -filter_complex "[2:a]volume=0.2[a2];[1:a][a2]amix=inputs=2:duration=longest" \
    -c:v copy -c:a aac ${output}
  `)

  return output
}

// ====== TELEGRAM FLOW ======

bot.onText(/do it/, async (msg) => {
  const chatId = msg.chat.id
  userState[chatId] = "waiting_input"

  await bot.sendMessage(chatId, "Send theme / link / text")
})

bot.on("message", async (msg) => {
  const chatId = msg.chat.id

  if (userState[chatId] !== "waiting_input") return
  userState[chatId] = null

  const input = msg.text

  try {
    ensureDirs()

    await bot.sendMessage(chatId, "Got it. Creating script...")

    const script = await generateScript(input)

    await bot.sendMessage(chatId, "Generating images...")

    let images = []
    for (let i = 0; i < script.length; i++) {
      const img = await generateImage(i)
      images.push(img)
    }

    await bot.sendMessage(chatId, "Creating videos...")

    let videos = []
    for (let i = 0; i < images.length; i++) {
      const vid = await generateVideo(i, images[i])
      videos.push(vid)
    }

    await bot.sendMessage(chatId, "Merging video...")

    const merged = await mergeVideos(videos)

    await bot.sendMessage(chatId, "Generating audio...")

    const voice = await generateVoice(script)
    const music = await generateMusic()

    await bot.sendMessage(chatId, "Rendering final video...")

    const finalVideo = await finalMerge(merged, voice, music)

    await bot.sendMessage(chatId, "Sending video...")

    await bot.sendVideo(chatId, finalVideo)

    await bot.sendMessage(chatId, "DONE 🚀")

    cleanTmp()

  } catch (e) {
    console.log(e)
    await bot.sendMessage(chatId, "FAILED ❌")
  }
})