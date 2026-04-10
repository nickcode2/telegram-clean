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
const TOTAL_SCENES = 8          // 8 scenes × ~2s = ~15 seconds
const TARGET_SCENE_SECONDS = 2  // ~2 seconds of speech per scene
const REPORTER_EVERY = 4        // reporter at scenes 4 and 8

// Drive file IDs
const REPORTER_REF_ID = "1Rb47BC7eWiQndjmZKkHKrvIaIjpViBZC"
const REPORTER_PHOTO_IDS = [
  "1-j1_7baQ9ZUReTkt0akX5R1bg8XGlLEg",
  "1W7GjxliUVN9uyjwZVhzC0S9LjI0s-X3L",
  "1t0qbfayOQrbWlVPh70sMLn8lHG0oOtEI"
]
const THUMBNAIL_PNG_ID = "1xhXV1MY484aAdmZiA9a6zeDNkWUT9uQo"

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

let userState = {}
let reporterPositionIndex = 0
let cachedReporterRef = null

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/assets"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 13 KLING-NATIVE CAMERA MOVEMENTS
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  { name: "Pan Right",        motionStyle: "camera pans right" },
  { name: "Pan Tilt Down",    motionStyle: "camera pans right and tilts down" },
  { name: "Zoom In",          motionStyle: "the camera zooms in" },
  { name: "Zoom Out",         motionStyle: "The camera zooms out" },
  { name: "Tilt Up",          motionStyle: "camera tilts up" },
  { name: "Tilt Down",        motionStyle: "camera tilts down" },
  { name: "Orbit",            motionStyle: "camera orbits around" },
  { name: "Orbit Push In",    motionStyle: "camera orbits around and pushes in" },
  { name: "Rotate Around",    motionStyle: "the camera rotates around the subject" },
  { name: "Follow Subject",   motionStyle: "the camera follows the subject moving" },
  { name: "Boom Up Push In",  motionStyle: "camera booms up and pushes in" },
  { name: "Handheld",         motionStyle: "handheld device filming" },
  { name: "Long Shot",        motionStyle: "positioned at a Long Shot" }
]

const getCam = i => CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length]
const PEOPLE_CYCLE = [true, true, true, false, true, true, true, false, false]
const hasPeople = i => PEOPLE_CYCLE[i % PEOPLE_CYCLE.length]
const isReporter = i => (i + 1) % REPORTER_EVERY === 0


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
// GOOGLE DRIVE
// ─────────────────────────────────────────
function getDriveClient() {
  const creds = JSON.parse(process.env.GDRIVE_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] })
  return google.drive({ version: "v3", auth })
}

async function uploadToDrive(filePath, fileName, mimeType) {
  const folderId = process.env.DRIVE_FOLDER_ID
  if (!folderId) { console.log("No DRIVE_FOLDER_ID — skipping"); return null }
  try {
    const drive = getDriveClient()
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: "id, webViewLink"
    })
    await drive.permissions.create({ fileId: res.data.id, requestBody: { role: "reader", type: "anyone" } })
    console.log(`Drive OK: ${fileName}`)
    return res.data
  } catch (err) { console.error(`Drive upload failed (${fileName}):`, err.message); return null }
}

async function downloadFromDrive(fileId, outPath) {
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`)
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} (ID: ${fileId})`)
  const buf = await res.buffer()
  fs.writeFileSync(outPath, buf)
  console.log(`Downloaded: ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`)
  return outPath
}


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(id, label) {
  const start = Date.now()
  while (true) {
    if (Date.now() - start > 12 * 60 * 1000) throw new Error(`${label} timed out`)
    await sleep(6000)
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
    })
    const r = await res.json()
    console.log(`${label}: ${r.status}`)
    if (r.status === "succeeded") return r
    if (r.status === "failed") throw new Error(`${label} failed: ${r.error}`)
  }
}


// ─────────────────────────────────────────
// STEP 1 — SCRIPT (Claude)
// 8 scenes × ~2 seconds
// Scene 1 must be the most dramatic — wide, epic, immediate impact
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

  return await callClaude(
    `You write viral YouTube voiceover scripts for 15-second videos with ${TOTAL_SCENES} scenes of ~${TARGET_SCENE_SECONDS} seconds each.
Maximum 8 words per scene.

Scene structure:
- [SCENE 1]: The most explosive, massive opening statement — make them feel the scale immediately. Max 8 words.
- [SCENE 2]: Second shock — deepen the mystery. Max 8 words.
- [SCENE 3]: Context that makes it bigger. Max 8 words.
- [SCENE 4]: The reporter moment — key revelation delivered personally. Max 8 words.
- [SCENE 5]: The evidence or detail. Max 8 words.
- [SCENE 6]: The consequence or impact. Max 8 words.
- [SCENE 7]: Another reporter moment — emotional punch. Max 8 words.
- [SCENE 8]: Final powerful close. Must end with: Thanks for watching. Max 8 words.

Rules:
- Label every scene: [SCENE 1] text etc.
- Declarative statements only — no questions
- Write ONLY the 8 labeled scenes, nothing else`,
    `Write an 8-scene 15-second YouTube script about:\n\n${context}`,
    350
  )
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE (Claude)
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const raw = await callClaude(
    `Define a precise cinematic visual style for a YouTube documentary video.
The style must absorb the emotional DNA of the topic completely.

Return ONLY valid JSON — no markdown, no backticks:
{
  "colorPalette": "specific colors matching topic emotional DNA",
  "lighting": "specific dramatic lighting",
  "atmosphere": "specific atmosphere, particles, haze, weather",
  "mood": "emotional tone in 3-5 words",
  "styleTag": "2-4 word cinematic style name",
  "consistencyTag": "6-10 word phrase that locks the visual tone across all scenes",
  "avoid": "visual elements that break the tone",
  "reporterOutfit": "specific modern 2026 journalist clothing appropriate for this topic environment"
}`,
    `Topic: ${topic}\nScript: ${script}`,
    350
  )
  return safeJSON(raw)
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN (Claude)
// Scene 1 = massive wide epic shot
// Theme-driven prompts written like an obsessed cinematographer
// ─────────────────────────────────────────
async function buildScenes(rawScript, totalScenes, style, topic) {
  const matches = rawScript.match(/\[SCENE \d+\][^\[]+/g) || []
  const texts = matches.map(s => s.replace(/\[SCENE \d+\]/, "").trim())

  const setup = Array.from({ length: totalScenes }, (_, i) => ({
    index: i,
    camera: getCam(i),
    hasPeople: hasPeople(i),
    isReporter: isReporter(i),
    script: texts[i] || `Scene ${i + 1} about ${topic}`
  }))

  const setupList = setup.map((s, i) => {
    const isFirst = i === 0
    return `Scene ${i + 1}${isFirst ? " [OPENING — must be wide, epic, massive scale, instantly impressive]" : ""}: "${s.script}"
Camera: ${s.camera.motionStyle}
People: ${
  s.isReporter ? "REPORTER_SCENE" :
  s.hasPeople ? "YES — 1-3 people in action, NEVER talking to each other" :
  "NO people — pure environment or objects"
}`
  }).join("\n\n")

  const raw = await callClaude(
    `Write cinematic image prompts for YouTube documentary scenes.
You write like a cinematographer who is deeply obsessed with this specific subject.

VISUAL STYLE — apply to every scene:
Color palette: ${style.colorPalette}
Lighting: ${style.lighting}
Atmosphere: ${style.atmosphere}
Mood: ${style.mood}
Style: ${style.styleTag}
Consistency tag: ${style.consistencyTag}
Avoid: ${style.avoid}

IMAGE PROMPT RULES:
1. Minimum 100 words per prompt
2. Scene 1 MUST be an epic wide establishing shot — drone height or extreme wide — show the massive scale of the subject — this is the first impression and must be breathtaking
3. The prompts must FEEL like the topic — write with the vibe embedded in every word
4. Photorealistic photography only — no CGI, no illustration, no 3D
5. Include: exact location, time of day, atmosphere, specific story objects, lighting direction, camera angle
6. People: action only — NEVER talking to each other, NEVER facing each other
7. NEVER: violence, weapons, blood, nudity — keep documentary-safe
8. Reporter scenes: write exactly REPORTER_SCENE

Return ONLY valid JSON:
{"scenes":[{"imagePrompt":"100+ words OR REPORTER_SCENE","motionPrompt":"exact Kling camera motion"}]}`,
    `Build ${totalScenes} scene prompts. Topic: ${topic}\n\n${setupList}`,
    3000
  )

  const data = safeJSON(raw)
  return setup.map((s, i) => ({
    ...s,
    imagePrompt: data.scenes[i]?.imagePrompt || `${s.script}, ${style.styleTag}, photorealistic, ${style.consistencyTag}`,
    motion: data.scenes[i]?.motionPrompt || s.camera.motionStyle
  }))
}


// ─────────────────────────────────────────
// STEP 4 — IMAGE (Flux 2 Max)
// Clean prompt — no competing suffix text
// ─────────────────────────────────────────
function sanitizePrompt(p) {
  return p.replace(/\b(dead|death|dying|corpse|blood|gore|weapon|gun|knife|bomb|explosion|terror|torture|abuse|violent|massacre|murder|kill|naked|nude|sexual|attack)\b/gi, "")
    .replace(/\s+/g, " ").trim()
}

async function generateImage(prompt, index) {
  const attempts = [
    prompt,
    sanitizePrompt(prompt),
    `Dramatic cinematic wide shot, ${sanitizePrompt(prompt).slice(0, 100)}, photorealistic documentary`
  ]

  for (let attempt = 0; attempt < attempts.length; attempt++) {
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
      const result = await pollReplicate(pred.id, `Image ${index + 1}`)
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/images/img_${index}.jpg`
      fs.writeFileSync(path, buf)
      console.log(`Image ${index + 1} done (attempt ${attempt + 1})`)
      return path
    } catch (err) {
      const flagged = err.message.includes("E005") || err.message.includes("sensitive") || err.message.includes("flagged")
      if (flagged && attempt < attempts.length - 1) { console.log(`Image ${index + 1}: flagged, retrying safer...`); continue }
      throw err
    }
  }
}


// ─────────────────────────────────────────
// REPORTER SCENE PIPELINE
// 1. Generate background (no person)
// 2. flux-fill-pro paints reporter INTO background with correct outfit
// 3. Kling lip-sync: reporter talks, background animates
// ─────────────────────────────────────────
async function getReporterRef() {
  if (cachedReporterRef && fs.existsSync(cachedReporterRef)) return cachedReporterRef
  cachedReporterRef = "/tmp/assets/reporter_ref.jpg"
  await downloadFromDrive(REPORTER_REF_ID, cachedReporterRef)
  return cachedReporterRef
}

async function mergeReporterIntoBackground(bgPath, outfit, style, topic, index) {
  const W = 1280, H = 720
  const isLeft = reporterPositionIndex % 2 === 0
  reporterPositionIndex++

  // Create PNG mask — white where reporter goes, black = keep background
  const maskW = Math.round(W * 0.40)
  const maskH = Math.round(H * 0.82)
  const maskX = isLeft ? 20 : W - maskW - 20
  const maskY = H - maskH

  const maskSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${W}" height="${H}" fill="black"/>
    <rect x="${maskX}" y="${maskY}" width="${maskW}" height="${maskH}" fill="white"/>
  </svg>`

  const maskPath = `/tmp/assets/mask_${index}.png`
  await sharp(Buffer.from(maskSvg)).resize(W, H).png().toFile(maskPath)

  const bgBase64 = `data:image/jpeg;base64,${fs.readFileSync(bgPath).toString("base64")}`
  const maskBase64 = `data:image/png;base64,${fs.readFileSync(maskPath).toString("base64")}`

  const sideDesc = isLeft ? "left third of frame" : "right third of frame"
  const inpaintPrompt = `A modern journalist man standing in ${sideDesc} of frame, waist-up close to camera, hands visible and slightly open as if explaining something, wearing ${outfit}, facing camera, background shows ${topic} environment naturally behind him, ${style.consistencyTag}, ${style.lighting}, integrated naturally into scene, photorealistic, no text, no watermarks`

  console.log(`Flux fill-pro: painting reporter into scene ${index + 1} (${isLeft ? "left" : "right"})...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-fill-pro/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { image: bgBase64, mask: maskBase64, prompt: inpaintPrompt, guidance: 30, steps: 28, output_format: "jpg", output_quality: 95 }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Flux fill-pro failed: ${pred.detail || JSON.stringify(pred).slice(0, 100)}`)

  const result = await pollReplicate(pred.id, `Reporter inpaint ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const mergedPath = `/tmp/images/reporter_merged_${index}.jpg`
  fs.writeFileSync(mergedPath, buf)
  return mergedPath
}

async function runLipSync(imagePath, audioPath, index) {
  const imageBase64 = `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`
  const audioBase64 = `data:audio/mpeg;base64,${fs.readFileSync(audioPath).toString("base64")}`

  const paramSets = [
    { face_image: imageBase64, audio: audioBase64, mode: "std", aspect_ratio: "16:9" },
    { image: imageBase64, audio: audioBase64, mode: "std", aspect_ratio: "16:9" },
    { face_image: imageBase64, driven_audio: audioBase64, aspect_ratio: "16:9" },
    { image: imageBase64, audio_input: audioBase64, aspect_ratio: "16:9" }
  ]

  for (let p = 0; p < paramSets.length; p++) {
    const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-lip-sync/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: paramSets[p] })
    })
    const pred = await res.json()
    console.log(`Lip-sync param ${p + 1}:`, JSON.stringify(pred).slice(0, 150))
    if (!pred.id) { if (p < paramSets.length - 1) continue; throw new Error(`Lip-sync failed: ${pred.detail}`) }
    try {
      const result = await pollReplicate(pred.id, `Lip-sync ${index + 1}`)
      const url = Array.isArray(result.output) ? result.output[0] : result.output
      const buf = await (await fetch(url)).buffer()
      const path = `/tmp/videos/lipsync_${index}.mp4`
      fs.writeFileSync(path, buf)
      return path
    } catch (e) { if (p < paramSets.length - 1) continue; throw e }
  }
}

async function generateReporterScene(voicePath, outfit, style, topic, index) {
  const bgPrompt = `${style.consistencyTag}, dramatic wide establishing shot about ${topic}, ${style.atmosphere}, ${style.lighting}, epic cinematic environment showing the world of this story, no people, clear foreground space on one side, photorealistic, no text, no watermarks`
  const bgPath = await generateImage(bgPrompt, index)
  const mergedPath = await mergeReporterIntoBackground(bgPath, outfit, style, topic, index)
  const lipSyncPath = await runLipSync(mergedPath, voicePath, index)
  return { path: lipSyncPath, isLipSync: true }
}


// ─────────────────────────────────────────
// VIDEO (Kling v2.6) — normal scenes
// ─────────────────────────────────────────
async function generateVideo(imgPath, motionPrompt, index) {
  const b64 = `data:image/jpeg;base64,${fs.readFileSync(imgPath).toString("base64")}`
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { image: b64, prompt: motionPrompt, duration: 5, aspect_ratio: "16:9" } })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start`)
  const result = await pollReplicate(pred.id, `Video ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const path = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(path, buf)
  return { path, isLipSync: false }
}


// ─────────────────────────────────────────
// VOICE (ElevenLabs Ellis)
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  })
  if (!res.ok) throw new Error(`ElevenLabs failed: ${res.status}`)
  const buf = await res.buffer()
  const path = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// MUSIC
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
    const out = execSync(`ffmpeg -i "${p}" -vn -af "highpass=f=300,lowpass=f=3000,volumedetect" -f null - 2>&1`, { timeout: 15000 }).toString()
    const m = out.match(/mean_volume:\s*([-\d.]+)\s*dB/)
    if (m) { const db = parseFloat(m[1]); console.log(`SFX vocal scan: ${db}dB`); return db > -38 }
  } catch { }
  return false
}

function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
  return output
}

function buildRegularScene(vidPath, voicePath, dur, i) {
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

function buildReporterScene(lipSyncPath, dur, i) {
  const norm = `/tmp/videos/reporter_norm_${i}.mp4`
  normalizeSize(lipSyncPath, norm)
  const out = `/tmp/final/scene_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`)
  return out
}

function concatScenes(paths) {
  const out = "/tmp/final/concatenated.mp4"
  const n = paths.length
  const inputs = paths.map(p => `-i "${p}"`).join(" ")
  const streams = paths.map((_, i) => `[${i}:v][${i}:a]`).join("")
  execSync(`ffmpeg -y ${inputs} -filter_complex "${streams}concat=n=${n}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${out}"`)
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
// THUMBNAIL
// Uses ffmpeg drawtext for reliable text rendering on Linux
// Person is massive — 95% height, head near top edge, bottom slightly cut
// Purple box with dark stroke, visible bold white text
// ─────────────────────────────────────────
async function generateThumbnail(topic, script) {
  // 1. Generate dramatic background
  const bgRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: `Dramatic cinematic epic wide shot about ${topic}, breathtaking scale, atmospheric, 4K, no people, no text, no watermark, golden dramatic lighting, massive environment`,
        width: 1280, height: 720, output_format: "jpg", output_quality: 95
      }
    })
  })
  const bgPred = await bgRes.json()
  if (!bgPred.id) throw new Error("Thumbnail BG failed")
  const bgResult = await pollReplicate(bgPred.id, "Thumbnail BG")
  const bgUrl = Array.isArray(bgResult.output) ? bgResult.output[0] : bgResult.output
  fs.writeFileSync("/tmp/assets/thumb_bg.jpg", await (await fetch(bgUrl)).buffer())

  // 2. Impact phrase (max 4 words, Claude)
  const phrase = (await callClaude(
    "Write a YouTube thumbnail impact phrase. MAXIMUM 4 WORDS. ALL CAPS. Shocking and curiosity-triggering. Return ONLY the phrase — no quotes, no punctuation.",
    `Topic: ${topic}\nScript: ${script}`, 15
  )).trim().toUpperCase().slice(0, 25)
  console.log(`Thumbnail phrase: "${phrase}"`)

  // 3. Download person PNG cutout
  await downloadFromDrive(THUMBNAIL_PNG_ID, "/tmp/assets/thumb_person.png")

  const W = 1280, H = 720

  // 4. Person: 95% height, centered, TOP of image (head near top edge)
  //    bottom gets cut off naturally (no feet shown) — matches the example
  const personTargetH = Math.round(H * 0.95)
  const personBuf = await sharp("/tmp/assets/thumb_person.png")
    .resize({ height: personTargetH, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const pMeta = await sharp(personBuf).metadata()
  const personW = pMeta.width || 550
  const personX = Math.round((W - personW) / 2)
  // Position person so head is at y=10 (near top edge)
  const personY = 10

  // 5. Composite: background + person using Sharp
  const compositePath = "/tmp/assets/thumb_composite.jpg"
  await sharp("/tmp/assets/thumb_bg.jpg")
    .resize(W, H)
    .composite([{
      input: personBuf,
      left: Math.max(0, personX),
      top: personY,
      blend: "over"
    }])
    .jpeg({ quality: 95 })
    .toFile(compositePath)

  // 6. Add purple box + text using ffmpeg drawtext
  //    This is reliable on Linux — no font availability issues
  //    Box: 78% width, centered, at 70% from top
  //    Dark outer stroke rect + bright purple fill + text
  const boxW = Math.round(W * 0.78)
  const boxH = 100
  const boxX = Math.round((W - boxW) / 2)
  const boxY = Math.round(H * 0.70)

  // Escape phrase for ffmpeg
  const safePhrase = phrase.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/[\\[\\]]/g, "\\$&")

  // Font size based on phrase length
  const fontSize = Math.max(36, Math.min(65, Math.round(65 * (10 / Math.max(phrase.length, 10)))))

  const thumbPath = "/tmp/assets/thumbnail.jpg"

  // Use ffmpeg to draw: outer dark rect → purple rect → darker right cap → accent line → text
  execSync(
    `ffmpeg -y -i "${compositePath}" -vf "` +
    // Dark outer stroke (border effect)
    `drawbox=x=${boxX - 7}:y=${boxY - 7}:w=${boxW + 14}:h=${boxH + 14}:color=0x3A0066:t=fill,` +
    // Main purple box
    `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=0x8800EE:t=fill,` +
    // Darker right cap
    `drawbox=x=${boxX + boxW - 30}:y=${boxY}:w=30:h=${boxH}:color=0x5500AA:t=fill,` +
    // Accent line below left
    `drawbox=x=${boxX}:y=${boxY + boxH + 8}:w=${Math.round(boxW * 0.38)}:h=7:color=0x5500AA:t=fill,` +
    // Text centered in box
    `drawtext=text='${safePhrase}':fontsize=${fontSize}:fontcolor=0x0A0A3A:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=${boxY + Math.round(boxH / 2) - Math.round(fontSize / 2)}:box=0` +
    `" -q:v 2 "${thumbPath}"`
  )

  console.log("Thumbnail done.")
  return thumbPath
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, "Send me a theme, article link, or paste any text.")
})


// ─────────────────────────────────────────
// MAIN PIPELINE — NEVER STOPS ON ERROR
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"
  reporterPositionIndex = 0
  cachedReporterRef = null

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, `✍️ Writing ${TOTAL_SCENES}-scene script (~${TARGET_SCENE_SECONDS}s each)...`)
    const rawScript = await generateScript(input)
    const topic = input.length > 100 ? input.slice(0, 80) + "..." : input
    await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}`)

    // ── VISUAL STYLE ──
    await bot.sendMessage(chatId, "🎨 Defining visual style...")
    const style = await generateVisualStyle(topic, rawScript)
    const outfit = style.reporterOutfit || "modern casual shirt, dark pants, 2026 journalist look"
    await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}\n🖌 ${style.colorPalette}\n👔 Reporter: ${outfit}`)

    // ── SCENE PLAN ──
    await bot.sendMessage(chatId, "🎬 Building scene plan...")
    const scenes = await buildScenes(rawScript, TOTAL_SCENES, style, topic)
    let plan = ""
    scenes.forEach((s, i) => {
      plan += `Scene ${i + 1}: ${s.camera.name}${s.isReporter ? " 🎙REPORTER" : ""} ${s.hasPeople ? "👥" : "🏔"}${i === 0 ? " 🔥OPENING" : ""}\n`
    })
    await bot.sendMessage(chatId, plan)

    // ── GENERATE ALL SCENES — NEVER STOP ──
    const sceneResults = []

    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]
      let sceneData = null
      try {
        const voicePath = await generateVoice(s.script, i)
        const audioDuration = getDuration(voicePath)

        if (s.isReporter) {
          await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Reporter (inpaint + lip-sync)...`)
          const result = await generateReporterScene(voicePath, outfit, style, topic, i)
          sceneData = { videoPath: result.path, voicePath, isLipSync: true, audioDuration }
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Reporter done`)
        } else {
          await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}${i === 0 ? " [OPENING]" : ""}...`)
          const img = await generateImage(s.imagePrompt, i)
          const result = await generateVideo(img, s.motion, i)
          sceneData = { videoPath: result.path, voicePath, isLipSync: false, audioDuration }
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Done`)
        }
      } catch (err) {
        console.error(`Scene ${i + 1} failed:`, err.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} failed: ${err.message}\n→ Continuing...`)
      }
      sceneResults.push(sceneData)
    }

    const validScenes = sceneResults.filter(s => s !== null)
    if (validScenes.length === 0) throw new Error("All scenes failed")

    await bot.sendMessage(chatId, `✂️ Building ${validScenes.length} scenes...`)
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < validScenes.length; i++) {
      try {
        const { videoPath, voicePath, isLipSync, audioDuration } = validScenes[i]
        totalDuration += audioDuration
        const scenePath = isLipSync
          ? buildReporterScene(videoPath, audioDuration, i)
          : buildRegularScene(videoPath, voicePath, audioDuration, i)
        scenePaths.push(scenePath)
        await bot.sendMessage(chatId, `✅ Scene ${i + 1}: ${audioDuration.toFixed(1)}s mixed`)
      } catch (e) {
        console.error(`Scene ${i + 1} build failed:`, e.message)
        await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} build failed — skipping`)
      }
    }

    if (scenePaths.length === 0) throw new Error("No scenes built")

    await bot.sendMessage(chatId, `🔗 Joining ${scenePaths.length} scenes...`)
    const concatenated = concatScenes(scenePaths)

    let finalVideo = concatenated
    try {
      await bot.sendMessage(chatId, "🎵 Adding music...")
      const musicPath = await downloadMusic()
      finalVideo = addMusicHD(concatenated, musicPath, totalDuration)
    } catch (e) {
      console.error("Music failed:", e.message)
      await bot.sendMessage(chatId, "⚠️ Music failed — delivering without it")
    }

    let thumbPath = null
    try {
      await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
      thumbPath = await generateThumbnail(topic, rawScript)
    } catch (e) {
      console.error("Thumbnail failed:", e.message)
      await bot.sendMessage(chatId, `⚠️ Thumbnail failed: ${e.message}`)
    }

    const dateStr = new Date().toISOString().slice(0, 16).replace("T", "_")
    let driveMsg = ""
    try {
      await bot.sendMessage(chatId, "☁️ Saving to Drive...")
      const vUp = await uploadToDrive(finalVideo, `VIDEO_${dateStr}.mp4`, "video/mp4")
      if (vUp?.webViewLink) driveMsg += `📹 Video: ${vUp.webViewLink}\n`
      if (thumbPath && fs.existsSync(thumbPath)) {
        const tUp = await uploadToDrive(thumbPath, `THUMB_${dateStr}.jpg`, "image/jpeg")
        if (tUp?.webViewLink) driveMsg += `🖼 Thumb: ${tUp.webViewLink}`
      }
    } catch (e) { console.error("Drive failed:", e.message) }

    await bot.sendVideo(chatId, finalVideo, {
      width: 1280, height: 720,
      caption: `🎬 ${scenePaths.length}-scene video (${totalDuration.toFixed(1)}s)\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music 40%`
    })

    if (thumbPath && fs.existsSync(thumbPath)) {
      await bot.sendPhoto(chatId, thumbPath, { caption: "🖼 Thumbnail ready for YouTube" })
    }

    if (driveMsg) {
      await bot.sendMessage(chatId, `✅ Saved to Drive:\n${driveMsg}`)
    } else {
      await bot.sendMessage(chatId, "⚠️ Drive save failed — check DRIVE_FOLDER_ID in Railway")
    }

    await bot.sendMessage(chatId, "✅ Done! Send 'do it' for another.")
    userState[chatId].step = "done"

  } catch (err) {
    console.error("Fatal:", err)
    await bot.sendMessage(chatId, `❌ Fatal: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
