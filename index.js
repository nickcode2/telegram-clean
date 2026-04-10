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
    if (Date.now() - start > maxWait) {
      throw new Error(`${label} timed out after 10 minutes`)
    }
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
  const res = await drive.files.create({
    requestBody: {
      name: sessionName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [process.env.DRIVE_FOLDER_ID]
    },
    fields: "id, webViewLink"
  })
  console.log(`Drive folder created: ${sessionName}`)
  return res.data
}

async function uploadToDrive(filePath, fileName, mimeType, folderId) {
  try {
    const drive = getDriveClient()
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: "id, webViewLink"
    })
    console.log(`Saved to Drive: ${fileName}`)
    return res.data
  } catch (err) {
    console.error(`Drive upload failed for ${fileName}:`, err.message)
    return null
  }
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
      {
        role: "user",
        content: `Write a 10-second script about:\n\n${context}`
      }
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
      headers: {
        Authorization: `Bearer ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: { prompt, width: 1280, height: 720, output_format: "jpg", output_quality: 90 }
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
  return filePath
}


// ─────────────────────────────────────────
// STEP 4 — VIDEO GENERATION
// Kling v2.6 — strips its own audio, we add ours later
// ─────────────────────────────────────────
async function generateVideo(imagePath, motionPrompt, index) {
  console.log(`Starting video ${index + 1}...`)

  const imageBuffer = fs.readFileSync(imagePath)
  const base64Image = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`

  const res = await fetch(
    "https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json"
      },
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

  // Save raw Kling video first
  const rawPath = `/tmp/videos/video_raw_${index}.mp4`
  fs.writeFileSync(rawPath, buffer)

  // Strip Kling's built-in audio — we will add voice + music ourselves
  const silentPath = `/tmp/videos/video_${index}.mp4`
  execSync(`ffmpeg -y -i "${rawPath}" -an -c:v copy "${silentPath}"`)
  console.log(`Video ${index + 1} done (Kling audio stripped).`)

  return silentPath
}


// ─────────────────────────────────────────
// STEP 5 — VOICE GENERATION
// ElevenLabs — Ellis voice ID hardcoded
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
  console.log("Music downloaded.")
  return rawPath
}


// ─────────────────────────────────────────
// FFMPEG HELPERS
// ─────────────────────────────────────────

function getDuration(filePath) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    ).toString().trim()
  )
}

// Trim video to exact audio duration
function trimVideoToMatchAudio(videoPath, audioDuration, index) {
  const out = `/tmp/videos/video_trimmed_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -t ${audioDuration} -c:v libx264 -preset fast -crf 23 "${out}"`
  )
  console.log(`Video ${index + 1} trimmed to ${audioDuration.toFixed(2)}s`)
  return out
}

// Merge one video + one voice into one scene file
// Uses -map to explicitly take video from input 0, audio from input 1
// This completely replaces Kling's audio with the ElevenLabs voice
function buildScene(videoPath, voicePath, index) {
  const out = `/tmp/final/scene_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${voicePath}" ` +
    `-map 0:v -map 1:a ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 ` +
    `-shortest "${out}"`
  )
  console.log(`Scene ${index + 1} built.`)
  return out
}

// Concatenate all scenes using filter_complex
// This is more reliable than -f concat for audio
function concatScenes(scenePaths) {
  const out = `/tmp/final/concatenated.mp4`
  const n = scenePaths.length

  // Build input args: -i scene0.mp4 -i scene1.mp4 ...
  const inputs = scenePaths.map(p => `-i "${p}"`).join(" ")

  // Build filter: [0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]
  const streams = scenePaths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  const filter = `${streams}concat=n=${n}:v=1:a=1[outv][outa]`

  execSync(
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${filter}" ` +
    `-map "[outv]" -map "[outa]" ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 "${out}"`
  )
  console.log("Scenes concatenated.")
  return out
}

// Add background music underneath the voice
// Voice stays at full volume, music at 15%
function addMusic(videoPath, musicPath, totalDuration) {
  const out = `/tmp/final/final_video.mp4`

  // Trim music to exact video duration
  const musicTrimmed = `/tmp/final/music_trimmed.mp3`
  execSync(`ffmpeg -y -i "${musicPath}" -t ${totalDuration} -af "volume=0.15" "${musicTrimmed}"`)

  // Mix voice audio from video with background music
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${musicTrimmed}" ` +
    `-filter_complex "[0:a]volume=1.0[voice];[1:a]volume=0.15[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
    `-map 0:v -map "[aout]" ` +
    `-c:v copy -c:a aac -ar 44100 "${out}"`
  )
  console.log("Music added. Final video ready.")
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
    const sessionFolder = await createSessionFolder(sessionName)
    const folderId = sessionFolder.id

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
      await uploadToDrive(img, `image_${i + 1}.jpg`, "image/jpeg", folderId)
      await bot.sendMessage(chatId, `✅ Image ${i + 1} done → saved to Drive`)
    }

    // ── VIDEOS ──
    await bot.sendMessage(chatId, "🎥 Generating videos with Kling v2.6... (~3-5 min each) ⏳")
    const videoPaths = []
    for (let i = 0; i < scenes.length; i++) {
      await bot.sendMessage(chatId, `⏳ Video ${i + 1} of ${scenes.length} generating... please wait`)
      const vid = await generateVideo(imagePaths[i], scenes[i].motion, i)
      videoPaths.push(vid)
      await uploadToDrive(`/tmp/videos/video_raw_${i}.mp4`, `video_raw_${i + 1}.mp4`, "video/mp4", folderId)
      await bot.sendMessage(chatId, `✅ Video ${i + 1} done → saved to Drive`)
    }

    // ── VOICE ──
    await bot.sendMessage(chatId, "🎙 Generating voice narration with Ellis...")
    const voicePaths = []
    for (let i = 0; i < scenes.length; i++) {
      const voice = await generateVoice(scenes[i].script, i)
      voicePaths.push(voice)
      await uploadToDrive(voice, `voice_${i + 1}.mp3`, "audio/mpeg", folderId)
      await bot.sendMessage(chatId, `✅ Voice ${i + 1} done → saved to Drive`)
    }

    // ── TRIM VIDEOS + BUILD SCENES ──
    await bot.sendMessage(chatId, "✂️ Cutting videos to match voice and combining...")
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < scenes.length; i++) {
      const audioDuration = getDuration(voicePaths[i])
      totalDuration += audioDuration
      console.log(`Scene ${i + 1}: audio is ${audioDuration.toFixed(2)}s`)

      const trimmedVideo = trimVideoToMatchAudio(videoPaths[i], audioDuration, i)
      const sceneFinal = buildScene(trimmedVideo, voicePaths[i], i)
      scenePaths.push(sceneFinal)

      await bot.sendMessage(chatId, `✅ Scene ${i + 1} ready (${audioDuration.toFixed(1)}s)`)
    }

    // ── CONCATENATE ALL SCENES ──
    await bot.sendMessage(chatId, "🔗 Joining scenes together...")
    const concatenated = concatScenes(scenePaths)

    // ── MUSIC ──
    await bot.sendMessage(chatId, "🎵 Adding background music...")
    const musicPath = await downloadMusic()

    // ── FINAL ASSEMBLY ──
    await bot.sendMessage(chatId, `🎬 Rendering final video (${totalDuration.toFixed(1)}s total)...`)
    const finalVideo = addMusic(concatenated, musicPath, totalDuration)

    // Upload final to Drive
    const uploaded = await uploadToDrive(finalVideo, "FINAL_VIDEO.mp4", "video/mp4", folderId)

    // Send to Telegram
    await bot.sendVideo(chatId, finalVideo, { caption: "🎬 Your video is ready!" })
    await bot.sendMessage(
      chatId,
      `✅ Saved to Google Drive\n📁 ${sessionName}\n🔗 ${uploaded?.webViewLink || "Check your VideoBot folder"}`
    )

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
