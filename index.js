import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import Anthropic from "@anthropic-ai/sdk"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", err => console.error("Polling:", err.message))

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

const TOTAL_SCENES = 1
const TARGET_SCENE_SECONDS = 5
const STEP_TIMEOUT_MS = 8 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

const stoppedChats = new Set()
let userState = {}

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 7 CAMERA TECHNIQUES
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  { name: "Pan Tilt Down",   motion: "camera pans right and tilts down" },
  { name: "Orbit",           motion: "camera orbits around" },
  { name: "Orbit Push In",   motion: "camera orbits around and pushes in" },
  { name: "Rotate Around",   motion: "the camera rotates around the subject" },
  { name: "Follow Subject",  motion: "the camera follows the subject moving" },
  { name: "Boom Up Push In", motion: "camera booms up and pushes in" },
  { name: "Handheld",        motion: "handheld device filming" }
]

const OPENING_CAMERA = CAMERA_TECHNIQUES.find(c => c.name === "Boom Up Push In")
const getCam = i => CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length]


// ─────────────────────────────────────────
// STOP COMMAND
// ─────────────────────────────────────────
bot.onText(/^stop$/i, async msg => {
  stoppedChats.add(msg.chat.id)
  userState[msg.chat.id] = {}
  await bot.sendMessage(msg.chat.id, "⛔ Stopping. Send 'do it' to start again.")
})

function isStopped(chatId) { return stoppedChats.has(chatId) }


// ─────────────────────────────────────────
// TIMEOUT WRAPPER
// ─────────────────────────────────────────
async function withTimeout(promise, label, ms = STEP_TIMEOUT_MS) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after 8 minutes`)), ms)
  )
  return Promise.race([promise, timeout])
}


// ─────────────────────────────────────────
// CLAUDE HELPER
// ─────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1000) {
  const msg = await claude.messages.create({
    model: "claude-opus-4-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }]
  })
  return msg.content[0].text
}


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(id, label, chatId) {
  const start = Date.now()
  while (true) {
    if (Date.now() - start > STEP_TIMEOUT_MS) throw new Error(`${label} timed out`)
    if (chatId && isStopped(chatId)) throw new Error("Stopped by user")
    await sleep(6000)
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
    })
    const r = await res.json()
    const elapsed = Math.round((Date.now() - start) / 1000)
    console.log(`${label}: ${r.status} (${elapsed}s)`)
    if (r.status === "succeeded") return r
    if (r.status === "failed") throw new Error(`${label} failed: ${r.error}`)
  }
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT
// Third person, describes events not narrator
// ─────────────────────────────────────────
async function generateScript(input) {
  let context = input
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      context = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 4000)
    } catch { context = `Topic: ${input}` }
  }

  const wordsPerScene = TARGET_SCENE_SECONDS <= 2 ? 8 : 14

  return await callClaude(
    `Write a YouTube voiceover script with ${TOTAL_SCENES} scene(s) of ~${TARGET_SCENE_SECONDS} seconds each.
Max ${wordsPerScene} words per scene.
Write in third person — describe events and facts, not a narrator speaking.
Label as [SCENE 1], [SCENE 2] etc.
Last scene must end with: Thanks for watching.
Write ONLY the labeled scenes.`,
    `Script about:\n\n${context}`,
    300
  )
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE
// Cinematic color and mood — no documentary or journalism words
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const raw = await callClaude(
    `Define a cinematic visual style for a YouTube video about this topic.
Return ONLY valid JSON — no markdown:
{
  "colorPalette": "specific film colors that match the topic mood",
  "lighting": "specific dramatic lighting",
  "atmosphere": "specific atmosphere, haze, particles, weather",
  "mood": "emotional tone in 3-5 words",
  "styleTag": "2-4 word cinematic style — avoid words like documentary or journalism",
  "consistencyTag": "5-8 word visual phrase to apply to all scenes — avoid words like documentary or journalism"
}`,
    `Topic: ${topic}\nScript: ${script}`,
    250
  )
  return safeJSON(raw)
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN
// Image prompt = read the script line, describe what you see
// 100 words of the physical scene
// ─────────────────────────────────────────
async function buildScenes(rawScript, totalScenes, style) {
  const matches = rawScript.match(/\*?\*?\[SCENE \d+\]\*?\*?[^\[]+/g) || []
  const texts = matches.map(s => s.replace(/\*?\*?\[SCENE \d+\]\*?\*?/, "").trim())

  const scenes = []

  for (let i = 0; i < totalScenes; i++) {
    const script = texts[i] || rawScript.replace(/\*?\*?\[SCENE \d+\]\*?\*?/, "").trim()
    const camera = i === 0 ? OPENING_CAMERA : getCam(i)

    // Simple: read the script, describe what it looks like in 100 words
    const imagePrompt = await callClaude(
      `Read this script line and write 100 words describing what this scene LOOKS LIKE visually.
Describe: the location, environment, objects, sky, light, time of day, colors, atmosphere.
Be specific and cinematic.
Visual style to apply: ${style.colorPalette}, ${style.lighting}, ${style.atmosphere}.`,
      `Script: "${script}"`,
      200
    )

    scenes.push({
      script,
      imagePrompt: imagePrompt.trim(),
      motion: camera.motion,
      cameraName: camera.name
    })
  }

  return scenes
}


// ─────────────────────────────────────────
// STEP 4 — IMAGE (Flux 2 Max)
// ─────────────────────────────────────────
async function generateImage(prompt, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")
  console.log(`Image ${index + 1}: ${prompt.slice(0, 80)}...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { prompt, width: 1280, height: 720, output_format: "jpg", output_quality: 95 }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error("Image failed to start — check REPLICATE_API_TOKEN")

  const result = await withTimeout(pollReplicate(pred.id, `Image ${index + 1}`, chatId), `Image ${index + 1}`)
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output

  // Save locally for Telegram preview
  const buf = await (await fetch(imageUrl)).buffer()
  const path = `/tmp/images/img_${index}.jpg`
  fs.writeFileSync(path, buf)
  console.log(`Image ${index + 1} done`)

  // Return both path and URL — Kling gets the URL directly (avoids base64 corruption)
  return { path, url: imageUrl }
}


// ─────────────────────────────────────────
// STEP 5 — VIDEO (Kling v2.6)
// Pass image as URL directly — avoids base64 size issues
// ─────────────────────────────────────────
async function generateVideo(imageUrl, motionPrompt, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  console.log(`Video ${index + 1}: image URL → Kling`)
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { image: imageUrl, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" } })
  })
  const pred = await res.json()
  console.log("Kling response:", JSON.stringify(pred).slice(0, 200))
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, `Video ${index + 1}`, chatId), `Video ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const path = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(path, buf)
  console.log(`Video ${index + 1}: ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
  return path
}


// ─────────────────────────────────────────
// STEP 6 — VOICE (ElevenLabs Ellis)
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  })
  if (!res.ok) throw new Error(`ElevenLabs failed: ${res.status}`)
  const buf = await res.buffer()
  const path = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// STEP 7 — MUSIC
// ─────────────────────────────────────────
async function downloadMusic() {
  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveUrl.match(/id=([a-zA-Z0-9_-]+)/)
  if (!match) throw new Error("MUSIC_DRIVE_URL invalid")
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync("/tmp/music_raw.mp3", buf)
  return "/tmp/music_raw.mp3"
}


// ─────────────────────────────────────────
// FFMPEG
// ─────────────────────────────────────────
function getDuration(p) {
  return parseFloat(execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  ).toString().trim())
}

function hasAudio(p) {
  try {
    return execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${p}"`
    ).toString().trim() === "audio"
  } catch { return false }
}

function detectVocalContent(p) {
  if (!hasAudio(p)) return false
  try {
    const out = execSync(`ffmpeg -i "${p}" -vn -af "highpass=f=300,lowpass=f=3000,volumedetect" -f null - 2>&1`, { timeout: 15000 }).toString()
    const m = out.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    if (m) return parseFloat(m[1]) > -38
  } catch { }
  return false
}

function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
}

function buildScene(vidPath, voicePath, dur, i) {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v copy -c:a copy "${trimmed}"`)
  const out = `/tmp/final/scene_${i}.mp4`
  if (hasAudio(trimmed)) {
    const sfxVol = detectVocalContent(trimmed) ? 0.10 : 0.15
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${voicePath}" -filter_complex "[0:a]volume=${sfxVol}[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  } else {
    execSync(`ffmpeg -y -i "${trimmed}" -i "${voicePath}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
  }
  return out
}

function concatScenes(paths) {
  if (paths.length === 1) return paths[0]
  const out = "/tmp/final/concatenated.mp4"
  const inputs = paths.map(p => `-i "${p}"`).join(" ")
  const streams = paths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  execSync(`ffmpeg -y ${inputs} -filter_complex "${streams}concat=n=${paths.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`)
  return out
}

function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.40" "${musicTrim}"`)
  const out = "/tmp/final/final_video.mp4"
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" -filter_complex "[0:a]volume=1.0[ex];[1:a]volume=0.40[mu];[ex][mu]amix=inputs=2:duration=first:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^schema$/i, async msg => {
  try {
    const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6", {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` }
    })
    const data = await res.json()
    const schema = JSON.stringify(data?.latest_version?.openapi_schema?.components?.schemas?.Input?.properties || data, null, 2).slice(0, 3000)
    await bot.sendMessage(msg.chat.id, `Kling v2.6 input schema:\n\n${schema}`)
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e.message}`)
  }
})

bot.onText(/^do it$/i, msg => {
  stoppedChats.delete(msg.chat.id)
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, `Send a theme, article link, or paste any text.\n\n💡 Send "stop" anytime to halt.`)
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text) || /^stop$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, `✍️ Writing script...`)
    const rawScript = await generateScript(input)
    const topic = input.startsWith("http") ? input.split("/").pop().replace(/_/g, " ") : input.slice(0, 60)
    await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}`)

    // ── VISUAL STYLE ──
    await bot.sendMessage(chatId, "🎨 Defining visual style...")
    const style = await generateVisualStyle(topic, rawScript)
    await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}`)

    // ── SCENES ──
    await bot.sendMessage(chatId, "🎬 Building scenes...")
    const scenes = await buildScenes(rawScript, TOTAL_SCENES, style)
    scenes.forEach((s, i) => {
      console.log(`Scene ${i + 1} prompt: ${s.imagePrompt.slice(0, 100)}...`)
    })
    let plan = ""
    scenes.forEach((s, i) => {
      plan += `Scene ${i + 1}: ${s.cameraName}${i === 0 ? " 🔥" : ""}\n`
    })
    await bot.sendMessage(chatId, plan)

    // ── GENERATE SCENES ──
    const sceneResults = []

    for (let i = 0; i < scenes.length; i++) {
      if (isStopped(chatId)) { await bot.sendMessage(chatId, "⛔ Stopped."); userState[chatId] = {}; return }

      const s = scenes[i]
      const startTime = Date.now()

      try {
        await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}${i === 0 ? " [OPENING]" : ""} — ${s.cameraName}...`)
        const voicePath = await generateVoice(s.script, i)
        const audioDuration = getDuration(voicePath)
        const img = await generateImage(s.imagePrompt, i, chatId)
        await bot.sendMessage(chatId, `🖼 Image prompt used:\n\n${s.imagePrompt}`)
        await bot.sendPhoto(chatId, img.path, { caption: "📸 Flux generated this (before Kling)" })
        const vidPath = await generateVideo(img.url, s.motion, i, chatId)
        const elapsed = Math.round((Date.now() - startTime) / 1000)
        sceneResults.push({ videoPath: vidPath, voicePath, audioDuration })
        await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Done in ${elapsed}s`)
      } catch (err) {
        if (err.message === "Stopped by user") { userState[chatId] = {}; return }
        console.error(`Scene ${i + 1} failed:`, err.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} failed: ${err.message}\n→ Continuing...`)
        sceneResults.push(null)
      }
    }

    const validScenes = sceneResults.filter(s => s !== null)
    if (validScenes.length === 0) throw new Error("All scenes failed")

    // ── BUILD ──
    await bot.sendMessage(chatId, `✂️ Building ${validScenes.length} scene(s)...`)
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < validScenes.length; i++) {
      try {
        const { videoPath, voicePath, audioDuration } = validScenes[i]
        totalDuration += audioDuration
        scenePaths.push(buildScene(videoPath, voicePath, audioDuration, i))
      } catch (e) {
        console.error(`Build scene ${i + 1}:`, e.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} build failed — skipping`)
      }
    }

    if (scenePaths.length === 0) throw new Error("No scenes built")

    // ── JOIN ──
    const joined = concatScenes(scenePaths)

    // ── MUSIC ──
    let finalVideo = joined
    try {
      await bot.sendMessage(chatId, "🎵 Adding music...")
      const musicPath = await downloadMusic()
      finalVideo = addMusicHD(joined, musicPath, totalDuration)
    } catch (e) {
      console.error("Music failed:", e.message)
      await bot.sendMessage(chatId, "⚠️ Music failed — delivering without it")
    }

    // ── DELIVER ──
    await bot.sendVideo(chatId, finalVideo, {
      width: 1280,
      height: 720,
      caption: `🎬 ${scenePaths.length}-scene video (${totalDuration.toFixed(1)}s)\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music 40%`
    })

    await bot.sendMessage(chatId, "✅ Done! Send 'do it' for another.")
    userState[chatId].step = "done"

  } catch (err) {
    console.error("Fatal:", err)
    await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
