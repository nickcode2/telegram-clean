import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import { google } from "googleapis"
import Anthropic from "@anthropic-ai/sdk"
import sharp from "sharp"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", err => console.error("Polling:", err.message))

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

// ── VIDEO CONFIG ──
const TOTAL_SCENES = 3
const TARGET_SCENE_SECONDS = 5
const STEP_TIMEOUT_MS = 8 * 60 * 1000  // 8 minutes max per step

const THUMBNAIL_PNG_ID = "1xhXV1MY484aAdmZiA9a6zeDNkWUT9uQo"

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

// Track which chats have requested a stop
const stoppedChats = new Set()
let userState = {}

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/assets"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 7 CAMERA TECHNIQUES — Claude picks best per scene
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

// Scene 1 always uses the most cinematic opener
const OPENING_CAMERA = CAMERA_TECHNIQUES.find(c => c.name === "Boom Up Push In")

const PEOPLE_CYCLE = [true, true, true, false, true, true, true, false, false]
const hasPeople = i => PEOPLE_CYCLE[i % PEOPLE_CYCLE.length]


// ─────────────────────────────────────────
// STOP COMMAND
// ─────────────────────────────────────────
bot.onText(/^stop$/i, async msg => {
  const chatId = msg.chat.id
  stoppedChats.add(chatId)
  userState[chatId] = {}
  await bot.sendMessage(chatId, "⛔ Stopping after current step finishes.\n\nSend 'do it' to start a new video.")
})

function isStopped(chatId) {
  return stoppedChats.has(chatId)
}


// ─────────────────────────────────────────
// TIMEOUT WRAPPER
// Wraps any async operation with a hard timeout
// ─────────────────────────────────────────
async function withTimeout(promise, label, timeoutMs = STEP_TIMEOUT_MS) {
  const start = Date.now()
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs)
  )
  const result = await Promise.race([promise, timeout])
  console.log(`${label} completed in ${((Date.now() - start) / 1000).toFixed(0)}s`)
  return result
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
// GOOGLE DRIVE — uploads directly to VideoBot folder
// No subfolder creation — straight upload
// ─────────────────────────────────────────
function getDriveClient() {
  const creds = JSON.parse(process.env.GDRIVE_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"]
  })
  return google.drive({ version: "v3", auth })
}

async function uploadToDrive(filePath, fileName, mimeType) {
  const folderId = process.env.DRIVE_FOLDER_ID
  if (!folderId) throw new Error("DRIVE_FOLDER_ID not set in Railway")

  const stat = fs.statSync(filePath)
  console.log(`Uploading to Drive: ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`)

  const drive = getDriveClient()
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath)
    },
    fields: "id, webViewLink"
  })

  // Make it viewable by anyone with link
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: "reader", type: "anyone" }
  })

  console.log(`Drive upload OK: ${res.data.webViewLink}`)
  return res.data
}

async function downloadFromDrive(fileId, outPath) {
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`)
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync(outPath, buf)
  console.log(`Downloaded ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`)
  return outPath
}


// ─────────────────────────────────────────
// REPLICATE POLLING — with hard timeout
// ─────────────────────────────────────────
async function pollReplicate(id, label, chatId) {
  const start = Date.now()
  while (true) {
    if (Date.now() - start > STEP_TIMEOUT_MS) {
      throw new Error(`${label} timed out after 8 minutes`)
    }
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
// STEP 1 — SCRIPT (Claude)
// ─────────────────────────────────────────
async function generateScript(input) {
  let context = input
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      context = "Article:\n" + html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 4000)
    } catch { context = `Topic: ${input}` }
  }

  const wordsPerScene = TARGET_SCENE_SECONDS <= 2 ? 8 : 14

  return await callClaude(
    `Write a YouTube voiceover script for ${TOTAL_SCENES} scenes of ~${TARGET_SCENE_SECONDS} seconds each.
Max ${wordsPerScene} words per scene.

Structure:
[SCENE 1]: Most explosive opening — massive scale, immediate impact. Max ${wordsPerScene} words.
[SCENE 2]: The key revelation or turning point. Max ${wordsPerScene} words.
[SCENE 3]: Final powerful close. Must end with: Thanks for watching. Max ${wordsPerScene} words.

Rules:
- Label every scene: [SCENE 1] text etc.
- Declarative statements only — no questions
- Write ONLY the 8 labeled scenes`,
    `Write ${TOTAL_SCENES}-scene script about:\n\n${context}`,
    350
  )
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE (Claude)
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const raw = await callClaude(
    `Define a cinematic visual style for a YouTube documentary.
The style MUST absorb the emotional DNA of the topic — color, texture, feeling must be inseparable from the subject.

Return ONLY valid JSON — no markdown, no backticks:
{
  "colorPalette": "specific colors matching topic emotional DNA",
  "lighting": "specific dramatic lighting description",
  "atmosphere": "specific atmosphere — particles, haze, weather, air quality",
  "mood": "emotional tone in 3-5 words",
  "styleTag": "2-4 word cinematic style name",
  "consistencyTag": "6-10 word phrase appended to every image prompt for visual consistency",
  "avoid": "visual elements that break the tone"
}`,
    `Topic: ${topic}\nScript: ${script}`,
    300
  )
  return safeJSON(raw)
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN (Claude picks camera + writes prompts)
// Claude selects the best camera technique for each scene
// Scene 1 always gets Boom Up Push In
// ─────────────────────────────────────────
async function buildScenes(rawScript, totalScenes, style, topic) {
  const matches = rawScript.match(/\[SCENE \d+\][^\[]+/g) || []
  const texts = matches.map(s => s.replace(/\[SCENE \d+\]/, "").trim())

  const cameraList = CAMERA_TECHNIQUES.map(c => `- ${c.name}: "${c.motion}"`).join("\n")

  const setup = Array.from({ length: totalScenes }, (_, i) => ({
    index: i,
    hasPeople: hasPeople(i),
    isFirst: i === 0,
    script: texts[i] || `Scene ${i + 1} about ${topic}`
  }))

  const setupList = setup.map((s, i) =>
    `Scene ${i + 1}${s.isFirst ? " [OPENING — epic wide, massive scale, breathtaking]" : ""}: "${s.script}"
People: ${s.hasPeople ? "YES — 1-3 people in physical action, NEVER talking to each other, NEVER facing each other" : "NO people — pure environment or objects"}
${s.isFirst ? "Camera: MUST be Boom Up Push In" : `Camera: choose the best from the list for this scene`}`
  ).join("\n\n")

  const raw = await callClaude(
    `Write cinematic image prompts and choose camera movements for YouTube documentary scenes.
You write like a cinematographer obsessed with this exact subject.

AVAILABLE CAMERA TECHNIQUES (choose best per scene, Scene 1 must be Boom Up Push In):
${cameraList}

VISUAL STYLE — apply consistently to every scene:
Color palette: ${style.colorPalette}
Lighting: ${style.lighting}
Atmosphere: ${style.atmosphere}
Mood: ${style.mood}
Style: ${style.styleTag}
Consistency tag: ${style.consistencyTag}
Avoid in all scenes: ${style.avoid}

IMAGE PROMPT RULES:
1. Minimum 100 words per prompt — specific, immersive, cinematic
2. Scene 1 MUST be wide/aerial/epic establishing shot — show massive scale
3. The prompt must FEEL like the topic — write with the emotional vibe embedded
4. Photorealistic photography ONLY — no CGI, no illustration, no 3D render
5. Include: exact location type, time of day, atmosphere, specific objects, lighting direction, depth of field
6. People: action only — excavating, running, operating equipment, observing — NEVER conversation poses
7. NEVER: violence, blood, weapons, nudity — documentary-safe always
8. Choose the camera technique that best serves what's happening in this specific scene

Return ONLY valid JSON — no markdown:
{"scenes":[{"imagePrompt":"100+ words","motionPrompt":"exact chosen camera motion string","cameraName":"chosen camera name"}]}`,
    `Build ${totalScenes} scenes. Topic: ${topic}\n\n${setupList}`,
    3000
  )

  const data = safeJSON(raw)
  return setup.map((s, i) => {
    const sceneData = data.scenes[i] || {}
    // Force scene 1 to always use Boom Up Push In
    const motion = s.isFirst ? OPENING_CAMERA.motion : (sceneData.motionPrompt || CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length].motion)
    const cameraName = s.isFirst ? OPENING_CAMERA.name : (sceneData.cameraName || "Pan Tilt Down")
    return {
      ...s,
      imagePrompt: sceneData.imagePrompt || `${s.script}, ${style.styleTag}, photorealistic, ${style.consistencyTag}`,
      motion,
      cameraName
    }
  })
}


// ─────────────────────────────────────────
// STEP 4 — IMAGE (Flux 2 Max)
// Clean prompt — no competing suffix text
// Auto-retries on content flag (E005)
// ─────────────────────────────────────────
function sanitizePrompt(p) {
  return p.replace(/\b(dead|death|dying|corpse|blood|gore|weapon|gun|knife|bomb|explosion|terror|torture|abuse|violent|massacre|murder|kill|naked|nude|sexual|attack)\b/gi, "")
    .replace(/\s+/g, " ").trim()
}

async function generateImage(prompt, index, chatId) {
  const attempts = [
    prompt,
    sanitizePrompt(prompt),
    `Dramatic cinematic wide shot, ${sanitizePrompt(prompt).slice(0, 100)}, photorealistic documentary`
  ]

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

    try {
      console.log(`Image ${index + 1} attempt ${attempt + 1}...`)
      const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
        method: "POST",
        headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { prompt: attempts[attempt], width: 1280, height: 720, output_format: "jpg", output_quality: 95 }
        })
      })
      const pred = await res.json()
      if (!pred.id) throw new Error("No prediction ID — check REPLICATE_API_TOKEN")

      const result = await withTimeout(
        pollReplicate(pred.id, `Image ${index + 1}`, chatId),
        `Image ${index + 1}`,
        STEP_TIMEOUT_MS
      )
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/images/img_${index}.jpg`
      fs.writeFileSync(path, buf)
      console.log(`Image ${index + 1} done (attempt ${attempt + 1})`)
      return path

    } catch (err) {
      if (err.message === "Stopped by user") throw err
      const flagged = err.message.includes("E005") || err.message.includes("sensitive") || err.message.includes("flagged")
      if (flagged && attempt < attempts.length - 1) {
        console.log(`Image ${index + 1}: content flagged, retrying safer...`)
        continue
      }
      throw err
    }
  }
}


// ─────────────────────────────────────────
// STEP 5 — VIDEO (Kling v2.6)
// ─────────────────────────────────────────
async function generateVideo(imgPath, motionPrompt, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  const b64 = `data:image/jpeg;base64,${fs.readFileSync(imgPath).toString("base64")}`
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { image: b64, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" } })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start`)

  const result = await withTimeout(
    pollReplicate(pred.id, `Video ${index + 1}`, chatId),
    `Video ${index + 1}`,
    STEP_TIMEOUT_MS
  )
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
// FFMPEG HELPERS
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
    const out = execSync(
      `ffmpeg -i "${p}" -vn -af "highpass=f=300,lowpass=f=3000,volumedetect" -f null - 2>&1`,
      { timeout: 15000 }
    ).toString()
    const m = out.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    if (m) { const db = parseFloat(m[1]); console.log(`SFX vocal: ${db}dB`); return db > -38 }
  } catch { }
  return false
}

function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
  return output
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
      `ffmpeg -y -i "${trimmed}" -i "${voicePath}" ` +
      `-filter_complex "[0:a]volume=${sfxVol}[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" ` +
      `-map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  } else {
    execSync(`ffmpeg -y -i "${trimmed}" -i "${voicePath}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
  }
  return out
}

function concatScenes(paths) {
  const out = "/tmp/final/concatenated.mp4"
  const n = paths.length
  const inputs = paths.map(p => `-i "${p}"`).join(" ")
  const streams = paths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  execSync(
    `ffmpeg -y ${inputs} -filter_complex "${streams}concat=n=${n}:v=1:a=1[outv][outa]" ` +
    `-map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`
  )
  return out
}

function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.40" "${musicTrim}"`)
  const out = "/tmp/final/final_video.mp4"
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" ` +
    `-filter_complex "[0:a]volume=1.0[ex];[1:a]volume=0.40[mu];[ex][mu]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
    `-map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// THUMBNAIL — ffmpeg drawtext for reliable Linux text rendering
// ─────────────────────────────────────────
async function generateThumbnail(topic, script, chatId) {
  // Background
  const bgRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: `Dramatic cinematic epic wide shot about ${topic}, breathtaking scale, atmospheric, 4K, no people, no text, no watermark, golden dramatic lighting`,
        width: 1280, height: 720, output_format: "jpg", output_quality: 95
      }
    })
  })
  const bgPred = await bgRes.json()
  if (!bgPred.id) throw new Error("Thumbnail BG failed")
  const bgResult = await withTimeout(pollReplicate(bgPred.id, "Thumbnail BG", chatId), "Thumbnail BG", STEP_TIMEOUT_MS)
  const bgUrl = Array.isArray(bgResult.output) ? bgResult.output[0] : bgResult.output
  fs.writeFileSync("/tmp/assets/thumb_bg.jpg", await (await fetch(bgUrl)).buffer())

  // Impact phrase — max 4 words
  const phrase = (await callClaude(
    "Write a YouTube thumbnail impact phrase. MAXIMUM 4 WORDS. ALL CAPS. Shocking. Return ONLY the phrase — no quotes, no punctuation at end.",
    `Topic: ${topic}\nScript: ${script}`, 15
  )).trim().toUpperCase().slice(0, 25)
  console.log(`Thumbnail phrase: "${phrase}"`)

  // Download person PNG cutout
  await downloadFromDrive(THUMBNAIL_PNG_ID, "/tmp/assets/thumb_person.png")

  const W = 1280, H = 720

  // Person: 95% height, head near top, centered, bottom slightly cut
  const personH = Math.round(H * 0.95)
  const personBuf = await sharp("/tmp/assets/thumb_person.png")
    .resize({ height: personH, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const pMeta = await sharp(personBuf).metadata()
  const personW = pMeta.width || 550
  const personX = Math.round((W - personW) / 2)
  const personY = 8  // head near very top

  // Composite background + person
  const compositePath = "/tmp/assets/thumb_composite.jpg"
  await sharp("/tmp/assets/thumb_bg.jpg")
    .resize(W, H)
    .composite([{ input: personBuf, left: Math.max(0, personX), top: personY, blend: "over" }])
    .jpeg({ quality: 95 })
    .toFile(compositePath)

  // Add purple box + text via ffmpeg drawtext (works reliably on Linux)
  const boxW = Math.round(W * 0.78)
  const boxH = 100
  const boxX = Math.round((W - boxW) / 2)
  const boxY = Math.round(H * 0.70)
  const fontSize = Math.max(36, Math.min(65, Math.round(65 * (10 / Math.max(phrase.length, 10)))))
  const safePhrase = phrase.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/[<>]/g, "")
  const textY = boxY + Math.round(boxH / 2) - Math.round(fontSize / 2)

  const thumbPath = "/tmp/assets/thumbnail.jpg"

  // Try with DejaVu font, fallback to no fontfile
  try {
    execSync(
      `ffmpeg -y -i "${compositePath}" -vf "` +
      `drawbox=x=${boxX - 7}:y=${boxY - 7}:w=${boxW + 14}:h=${boxH + 14}:color=0x3A0066@1.0:t=fill,` +
      `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=0x8800EE@1.0:t=fill,` +
      `drawbox=x=${boxX + boxW - 30}:y=${boxY}:w=30:h=${boxH}:color=0x5500AA@1.0:t=fill,` +
      `drawbox=x=${boxX}:y=${boxY + boxH + 8}:w=${Math.round(boxW * 0.38)}:h=7:color=0x5500AA@1.0:t=fill,` +
      `drawtext=text='${safePhrase}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${textY}:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` +
      `" -q:v 2 "${thumbPath}"`
    )
  } catch {
    // Fallback without fontfile specification
    execSync(
      `ffmpeg -y -i "${compositePath}" -vf "` +
      `drawbox=x=${boxX - 7}:y=${boxY - 7}:w=${boxW + 14}:h=${boxH + 14}:color=0x3A0066@1.0:t=fill,` +
      `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=0x8800EE@1.0:t=fill,` +
      `drawbox=x=${boxX + boxW - 30}:y=${boxY}:w=30:h=${boxH}:color=0x5500AA@1.0:t=fill,` +
      `drawbox=x=${boxX}:y=${boxY + boxH + 8}:w=${Math.round(boxW * 0.38)}:h=7:color=0x5500AA@1.0:t=fill,` +
      `drawtext=text='${safePhrase}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${textY}` +
      `" -q:v 2 "${thumbPath}"`
    )
  }

  console.log("Thumbnail done.")
  return thumbPath
}


// ─────────────────────────────────────────
// TRIGGER — "do it"
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  const chatId = msg.chat.id
  stoppedChats.delete(chatId)  // clear any previous stop
  userState[chatId] = { step: "waiting_input" }
  bot.sendMessage(chatId, `Send me a theme, article link, or paste any text.\n\n💡 Send "stop" anytime to halt the pipeline.`)
})


// ─────────────────────────────────────────
// MAIN PIPELINE — NEVER STOPS ON SCENE ERROR
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return
  if (/^stop$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"

  try {
    // ── SCRIPT ──
    if (isStopped(chatId)) return
    await bot.sendMessage(chatId, `✍️ Writing ${TOTAL_SCENES}-scene script...`)
    const rawScript = await callClaude(
      `Write a YouTube voiceover script for ${TOTAL_SCENES} scenes of ~${TARGET_SCENE_SECONDS} seconds each. Max ${TARGET_SCENE_SECONDS <= 2 ? 8 : 14} words per scene.
[SCENE 1] through [SCENE ${TOTAL_SCENES}]. Last scene ends with: Thanks for watching. Declarative only.`,
      `Script about:\n\n${input}`, 350
    )
    const topic = input.length > 100 ? input.slice(0, 80) + "..." : input
    await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}`)

    // ── VISUAL STYLE ──
    if (isStopped(chatId)) return
    await bot.sendMessage(chatId, "🎨 Defining visual style...")
    const style = await generateVisualStyle(topic, rawScript)
    await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}\n🖌 ${style.colorPalette}`)

    // ── SCENE PLAN ──
    if (isStopped(chatId)) return
    await bot.sendMessage(chatId, "🎬 Building scene plan...")
    const scenes = await buildScenes(rawScript, TOTAL_SCENES, style, topic)
    let plan = ""
    scenes.forEach((s, i) => {
      plan += `Scene ${i + 1}: ${s.cameraName}${i === 0 ? " 🔥" : ""} ${s.hasPeople ? "👥" : "🏔"}\n`
    })
    await bot.sendMessage(chatId, plan)

    // ── GENERATE ALL SCENES ──
    const sceneResults = []

    for (let i = 0; i < scenes.length; i++) {
      if (isStopped(chatId)) {
        await bot.sendMessage(chatId, "⛔ Pipeline stopped by you.")
        userState[chatId] = {}
        return
      }

      const s = scenes[i]
      const startTime = Date.now()
      let sceneData = null

      try {
        await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}${i === 0 ? " [OPENING]" : ""} — ${s.cameraName}...`)

        const voicePath = await generateVoice(s.script, i)
        const audioDuration = getDuration(voicePath)
        const img = await generateImage(s.imagePrompt, i, chatId)
        const vidPath = await generateVideo(img, s.motion, i, chatId)

        sceneData = { videoPath: vidPath, voicePath, audioDuration }
        const elapsed = Math.round((Date.now() - startTime) / 1000)
        await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Done in ${elapsed}s`)

      } catch (err) {
        if (err.message === "Stopped by user") {
          await bot.sendMessage(chatId, "⛔ Pipeline stopped.")
          userState[chatId] = {}
          return
        }
        console.error(`Scene ${i + 1} failed:`, err.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} failed: ${err.message}\n→ Continuing with next scene...`)
      }

      sceneResults.push(sceneData)
    }

    // ── BUILD VALID SCENES ──
    const validScenes = sceneResults.filter(s => s !== null)
    if (validScenes.length === 0) throw new Error("All scenes failed — cannot build video")

    await bot.sendMessage(chatId, `✂️ Building ${validScenes.length} scenes...`)
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < validScenes.length; i++) {
      try {
        const { videoPath, voicePath, audioDuration } = validScenes[i]
        totalDuration += audioDuration
        scenePaths.push(buildScene(videoPath, voicePath, audioDuration, i))
        await bot.sendMessage(chatId, `✅ Scene ${i + 1}: ${audioDuration.toFixed(1)}s — audio mixed`)
      } catch (e) {
        console.error(`Build scene ${i + 1}:`, e.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} build error — skipping`)
      }
    }

    if (scenePaths.length === 0) throw new Error("No scenes built")

    if (isStopped(chatId)) return

    await bot.sendMessage(chatId, `🔗 Joining ${scenePaths.length} scenes...`)
    const concatenated = concatScenes(scenePaths)

    let finalVideo = concatenated
    try {
      await bot.sendMessage(chatId, "🎵 Adding background music...")
      const musicPath = await downloadMusic()
      finalVideo = addMusicHD(concatenated, musicPath, totalDuration)
    } catch (e) {
      console.error("Music failed:", e.message)
      await bot.sendMessage(chatId, "⚠️ Music failed — delivering without it")
    }

    // ── THUMBNAIL ──
    let thumbPath = null
    try {
      await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
      thumbPath = await generateThumbnail(topic, rawScript, chatId)
    } catch (e) {
      console.error("Thumbnail failed:", e.message)
      await bot.sendMessage(chatId, `⚠️ Thumbnail failed: ${e.message}`)
    }

    // ── DRIVE SAVE — uploads directly to VideoBot folder ──
    const dateStr = new Date().toISOString().slice(0, 16).replace("T", "_")
    let videoLink = "", thumbLink = ""
    try {
      await bot.sendMessage(chatId, "☁️ Saving to Google Drive...")
      const vUp = await withTimeout(
        uploadToDrive(finalVideo, `VIDEO_${dateStr}.mp4`, "video/mp4"),
        "Drive video upload",
        3 * 60 * 1000
      )
      if (vUp?.webViewLink) videoLink = vUp.webViewLink

      if (thumbPath && fs.existsSync(thumbPath)) {
        const tUp = await withTimeout(
          uploadToDrive(thumbPath, `THUMB_${dateStr}.jpg`, "image/jpeg"),
          "Drive thumb upload",
          2 * 60 * 1000
        )
        if (tUp?.webViewLink) thumbLink = tUp.webViewLink
      }
    } catch (e) {
      console.error("Drive failed:", e.message)
      await bot.sendMessage(chatId, `⚠️ Drive save failed: ${e.message}`)
    }

    // ── DELIVER ──
    await bot.sendVideo(chatId, finalVideo, {
      width: 1280,
      height: 720,
      caption: `🎬 ${scenePaths.length}-scene video (${totalDuration.toFixed(1)}s)\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music 40%`
    })

    if (thumbPath && fs.existsSync(thumbPath)) {
      await bot.sendPhoto(chatId, thumbPath, { caption: "🖼 Thumbnail ready for YouTube" })
    }

    let summary = "✅ Done!\n\n"
    if (videoLink) summary += `📹 Video: ${videoLink}\n`
    if (thumbLink) summary += `🖼 Thumbnail: ${thumbLink}\n`
    if (!videoLink && !thumbLink) summary += "⚠️ Drive save failed — check DRIVE_FOLDER_ID in Railway\n"
    summary += "\nSend 'do it' to create another."
    await bot.sendMessage(chatId, summary)

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Fatal:", err)
    await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
