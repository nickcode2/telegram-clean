import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import { google } from "googleapis"
import OpenAI from "openai"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", (err) => console.error("Polling error:", err.message))

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let userState = {}

fs.mkdirSync("/tmp/images", { recursive: true })
fs.mkdirSync("/tmp/videos", { recursive: true })
fs.mkdirSync("/tmp/voices", { recursive: true })
fs.mkdirSync("/tmp/final", { recursive: true })

console.log("Bot is running.")


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(predictionId, label) {
  const maxWait = 10 * 60 * 1000
  const start = Date.now()

  while (true) {
    if (Date.now() - start > maxWait) throw new Error(`${label} timed out after 10 minutes`)
    await sleep(6000)
    const res = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } }
    )
    const result = await res.json()
    console.log(`${label} status: ${result.status}`)
    if (result.status === "succeeded") return result
    if (result.status === "failed") throw new Error(`${label} failed: ${result.error}`)
  }
}


// ─────────────────────────────────────────
// GOOGLE DRIVE
// All uploads now throw errors so we can catch them properly
// ─────────────────────────────────────────
function getDriveClient() {
  const credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  })
  return google.drive({ version: "v3", auth })
}

async function createSessionFolder(sessionName) {
  const drive = getDriveClient()

  // Create folder inside your VideoBot folder
  const res = await drive.files.create({
    requestBody: {
      name: sessionName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [process.env.DRIVE_FOLDER_ID]
    },
    fields: "id, webViewLink"
  })

  // Make the folder readable by anyone with the link
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: "reader", type: "anyone" }
  })

  console.log(`Drive folder created: ${sessionName} (${res.data.id})`)
  return res.data
}

async function uploadToDrive(filePath, fileName, mimeType, folderId) {
  console.log(`Uploading ${fileName} to Drive...`)

  const drive = getDriveClient()

  // Check file exists and has size
  const stat = fs.statSync(filePath)
  console.log(`  File size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`)

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath)
    },
    fields: "id, webViewLink, size"
  })

  // Make file readable by anyone with the link
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: "reader", type: "anyone" }
  })

  console.log(`✅ Uploaded ${fileName} → ${res.data.webViewLink}`)
  return res.data
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT
// ─────────────────────────────────────────
async function generateScript(input) {
  console.log("Generating script...")
  let context = input

  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000)
      context = `Article content:\n${text}`
      console.log("Article fetched.")
    } catch (err) {
      console.log("Could not fetch URL:", err.message)
      context = `Topic: ${input}`
    }
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are a YouTube Shorts scriptwriter.
Write a dramatic, engaging voiceover script for a 10-second video.
Rules:
- Maximum 40 words total
- 2 sentences max
- Dramatic and engaging tone
- Must end with exactly: Thanks for watching
- No emojis, no hashtags, no questions
- Write ONLY the script text, nothing else`
      },
      { role: "user", content: `Write a 10-second script about:\n\n${context}` }
    ],
    max_tokens: 120,
    temperature: 0.7
  })

  const script = completion.choices[0].message.content.trim()
  console.log("Script:", script)
  return script
}


// ─────────────────────────────────────────
// STEP 2 — SCENE BREAKDOWN
// ─────────────────────────────────────────
async function splitScenes(script) {
  console.log("Splitting into scenes...")

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `Split a script into 2 scenes for a short video.
Return ONLY valid JSON. No markdown. No backticks. No explanation.
Format exactly:
{
  "scene1": {
    "script": "first part",
    "imagePrompt": "detailed cinematic photorealistic image, 4K, dramatic lighting, no text, no watermark",
    "motionPrompt": "specific camera movement"
  },
  "scene2": {
    "script": "second part",
    "imagePrompt": "detailed cinematic photorealistic image, 4K, dramatic lighting, no text, no watermark",
    "motionPrompt": "specific camera movement"
  }
}`
      },
      { role: "user", content: `Split this into 2 scenes:\n\n${script}` }
    ],
    max_tokens: 600,
    temperature: 0.7
  })

  const data = JSON.parse(completion.choices[0].message.content.trim())
  return [
    { script: data.scene1.script, imagePrompt: data.scene1.imagePrompt, motion: data.scene1.motionPrompt },
    { script: data.scene2.script, imagePrompt: data.scene2.imagePrompt, motion: data.scene2.motionPrompt }
  ]
}


// ─────────────────────────────────────────
// STEP 3 — IMAGE GENERATION
// ─────────────────────────────────────────
async function generateImage(prompt, index) {
  console.log(`Starting image ${index + 1}...`)

  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { prompt, width: 1280, height: 720, output_format: "jpg", output_quality: 95 }
      })
    }
  )

  const prediction = await res.json()
  if (!prediction.id) throw new Error(`Image ${index + 1} could not start. Check REPLICATE_API_TOKEN.`)

  const result = await pollReplicate(prediction.id, `Image ${index + 1}`)
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const imgRes = await fetch(imageUrl)
  const buffer = await imgRes.buffer()
  const filePath = `/tmp/images/img_${index}.jpg`
  fs.writeFileSync(filePath, buffer)
  console.log(`Image ${index + 1} done. Size: ${(buffer.length / 1024).toFixed(0)}KB`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 4 — VIDEO GENERATION
// Kling v2.6 — strips its ambient audio
// ─────────────────────────────────────────
async function generateVideo(imagePath, motionPrompt, index) {
  console.log(`Starting video ${index + 1}...`)

  const imageBuffer = fs.readFileSync(imagePath)
  const base64Image = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`

  const res = await fetch(
    "https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { image: base64Image, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" }
      })
    }
  )

  const prediction = await res.json()
  if (!prediction.id) throw new Error(`Video ${index + 1} could not start. Check REPLICATE_API_TOKEN.`)

  const result = await pollReplicate(prediction.id, `Video ${index + 1}`)
  const videoUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const vidRes = await fetch(videoUrl)
  const buffer = await vidRes.buffer()

  const rawPath = `/tmp/videos/video_raw_${index}.mp4`
  fs.writeFileSync(rawPath, buffer)

  // Strip Kling's built-in audio completely
  const silentPath = `/tmp/videos/video_${index}.mp4`
  execSync(`ffmpeg -y -i "${rawPath}" -an -c:v copy "${silentPath}"`)
  console.log(`Video ${index + 1} done. Size: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)

  return silentPath
}


// ─────────────────────────────────────────
// STEP 5 — VOICE GENERATION
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  console.log(`Generating voice ${index + 1}...`)

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`ElevenLabs failed (${res.status}): ${errText}`)
  }

  const buffer = await res.buffer()
  const filePath = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(filePath, buffer)
  console.log(`Voice ${index + 1} done.`)
  return filePath
}


// ─────────────────────────────────────────
// STEP 6 — BACKGROUND MUSIC
// ─────────────────────────────────────────
async function downloadMusic() {
  console.log("Downloading music...")
  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match =
    driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
    driveUrl.match(/id=([a-zA-Z0-9_-]+)/)

  if (!match) throw new Error("MUSIC_DRIVE_URL is not a valid Google Drive link.")

  const fileId = match[1]
  const url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Music download failed: HTTP ${res.status}`)

  const buffer = await res.buffer()
  const rawPath = `/tmp/music_raw.mp3`
  fs.writeFileSync(rawPath, buffer)
  console.log(`Music downloaded. Size: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`)
  return rawPath
}


// ─────────────────────────────────────────
// FFMPEG — TRIM VIDEO TO AUDIO LENGTH
// ─────────────────────────────────────────
function getDuration(filePath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    ).toString().trim()
  )
}

function trimVideoToMatchAudio(videoPath, audioDuration, index) {
  const out = `/tmp/videos/video_trimmed_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -t ${audioDuration} -c:v libx264 -preset fast -crf 18 "${out}"`
  )
  console.log(`Video ${index + 1} trimmed to ${audioDuration.toFixed(2)}s`)
  return out
}


// ─────────────────────────────────────────
// FFMPEG — BUILD SCENE (video + voice merged)
// Explicitly takes video from Kling, audio from ElevenLabs
// ─────────────────────────────────────────
function buildScene(videoPath, voicePath, index) {
  const out = `/tmp/final/scene_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${voicePath}" ` +
    `-map 0:v -map 1:a ` +
    `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 ` +
    `-shortest "${out}"`
  )
  console.log(`Scene ${index + 1} built.`)
  return out
}


// ─────────────────────────────────────────
// FFMPEG — CONCATENATE SCENES
// Uses filter_complex for reliable audio+video concat
// ─────────────────────────────────────────
function concatScenes(scenePaths) {
  const out = `/tmp/final/concatenated.mp4`
  const n = scenePaths.length
  const inputs = scenePaths.map(p => `-i "${p}"`).join(" ")
  const streams = scenePaths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  const filter = `${streams}concat=n=${n}:v=1:a=1[outv][outa]`

  execSync(
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${filter}" ` +
    `-map "[outv]" -map "[outa]" ` +
    `-c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`
  )
  console.log("Scenes concatenated.")
  return out
}


// ─────────────────────────────────────────
// FFMPEG — FINAL VIDEO WITH MUSIC
// HD quality output ready for YouTube
// Voice at full volume, music underneath at 15%
// ─────────────────────────────────────────
function addMusicAndExportHD(videoPath, musicPath, totalDuration) {
  const out = `/tmp/final/final_video.mp4`

  // Trim music to exact video length
  const musicTrimmed = `/tmp/final/music_trimmed.mp3`
  execSync(`ffmpeg -y -i "${musicPath}" -t ${totalDuration} -af "volume=0.15" "${musicTrimmed}"`)

  // Mix voice + music, export in HD quality for YouTube
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${musicTrimmed}" ` +
    `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.15[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
    `-map 0:v -map "[aout]" ` +
    `-c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M ` +
    `-c:a aac -b:a 192k -ar 44100 -ac 2 ` +
    `-movflags +faststart ` +
    `"${out}"`
  )

  const size = fs.statSync(out).size
  console.log(`Final video ready. Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
  return out
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, (msg) => {
  const chatId = msg.chat.id
  userState[chatId] = { step: "waiting_input" }
  bot.sendMessage(chatId, "Send me a theme, article link, or paste any text about your topic.")
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"

  try {

    // Create Drive session folder
    const sessionName = `Video_${new Date().toISOString().slice(0, 16).replace("T", "_")}`
    let folderId = null

    try {
      const sessionFolder = await createSessionFolder(sessionName)
      folderId = sessionFolder.id
      await bot.sendMessage(chatId, `📁 Drive folder created: ${sessionName}`)
    } catch (driveErr) {
      console.error("Could not create Drive folder:", driveErr.message)
      await bot.sendMessage(chatId, `⚠️ Drive folder failed: ${driveErr.message}\nContinuing without Drive...`)
    }

    // ── SCRIPT ──
    await bot.sendMessage(chatId, "✍️ Reading your input and writing script...")
    const script = await generateScript(input)
    await bot.sendMessage(chatId, `📄 Script:\n\n${script}`)

    // ── SCENES ──
    await bot.sendMessage(chatId, "🎬 Splitting into 2 scenes...")
    const scenes = await splitScenes(script)
    let sceneText = ""
    scenes.forEach((s, i) => {
      sceneText += `Scene ${i + 1}\nScript: ${s.script}\nImage prompt: ${s.imagePrompt}\nMotion: ${s.motion}\n\n`
    })
    await bot.sendMessage(chatId, sceneText)

    // ── IMAGES ──
    await bot.sendMessage(chatId, "🖼 Generating images with Flux 2 Max... (~1-2 min each)")
    const imagePaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `⏳ Image ${i + 1} of ${scenes.length} generating...`)
      const img = await generateImage(scenes[i].imagePrompt, i)
      imagePaths.push(img)
      if (folderId) {
        try {
          await uploadToDrive(img, `image_${i + 1}.jpg`, "image/jpeg", folderId)
        } catch (e) { console.error("Image upload failed:", e.message) }
      }
      await bot.sendMessage(chatId, `✅ Image ${i + 1} done`)
    }

    // ── VIDEOS ──
    await bot.sendMessage(chatId, "🎥 Generating videos with Kling v2.6... (~3-5 min each) ⏳")
    const videoPaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `⏳ Video ${i + 1} of ${scenes.length} generating... please wait`)
      const vid = await generateVideo(imagePaths[i], scenes[i].motion, i)
      videoPaths.push(vid)
      if (folderId) {
        try {
          await uploadToDrive(`/tmp/videos/video_raw_${i}.mp4`, `video_raw_${i + 1}.mp4`, "video/mp4", folderId)
        } catch (e) { console.error("Video upload failed:", e.message) }
      }
      await bot.sendMessage(chatId, `✅ Video ${i + 1} done`)
    }

    // ── VOICE ──
    await bot.sendMessage(chatId, "🎙 Generating voice with Ellis...")
    const voicePaths = []
    for (let i = 0; i < scenes.length; i++) {
      const voice = await generateVoice(scenes[i].script, i)
      voicePaths.push(voice)
      if (folderId) {
        try {
          await uploadToDrive(voice, `voice_${i + 1}.mp3`, "audio/mpeg", folderId)
        } catch (e) { console.error("Voice upload failed:", e.message) }
      }
      await bot.sendMessage(chatId, `✅ Voice ${i + 1} done`)
    }

    // ── TRIM + BUILD SCENES ──
    await bot.sendMessage(chatId, "✂️ Cutting videos to match voice length...")
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < scenes.length; i++) {
      const audioDuration = getDuration(voicePaths[i])
      totalDuration += audioDuration
      const trimmed = trimVideoToMatchAudio(videoPaths[i], audioDuration, i)
      const scene = buildScene(trimmed, voicePaths[i], i)
      scenePaths.push(scene)
      await bot.sendMessage(chatId, `✅ Scene ${i + 1} ready (${audioDuration.toFixed(1)}s)`)
    }

    // ── CONCAT ──
    await bot.sendMessage(chatId, "🔗 Joining scenes...")
    const concatenated = concatScenes(scenePaths)

    // ── MUSIC ──
    await bot.sendMessage(chatId, "🎵 Adding background music...")
    const musicPath = await downloadMusic()

    // ── FINAL RENDER IN HD ──
    await bot.sendMessage(chatId, `🎬 Rendering final HD video (${totalDuration.toFixed(1)}s)...`)
    const finalVideo = addMusicAndExportHD(concatenated, musicPath, totalDuration)

    // ── UPLOAD FINAL VIDEO TO DRIVE ──
    let driveLink = null
    if (folderId) {
      try {
        await bot.sendMessage(chatId, "☁️ Uploading final video to Google Drive...")
        const uploaded = await uploadToDrive(finalVideo, "FINAL_VIDEO.mp4", "video/mp4", folderId)
        driveLink = uploaded?.webViewLink
      } catch (e) {
        console.error("Final video Drive upload failed:", e.message)
        await bot.sendMessage(chatId, `⚠️ Drive upload failed: ${e.message}`)
      }
    }

    // ── SEND TO TELEGRAM ──
    await bot.sendVideo(chatId, finalVideo, { caption: "🎬 Your video is ready!" })

    if (driveLink) {
      await bot.sendMessage(chatId, `✅ Final video saved to Google Drive in HD\n📁 ${sessionName}\n🔗 ${driveLink}`)
    } else {
      await bot.sendMessage(chatId, `✅ Done! Video sent above.\n⚠️ Drive save failed — check GDRIVE_CREDENTIALS and DRIVE_FOLDER_ID in Railway.`)
    }

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
