import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"
import { execSync } from "child_process"
import OpenAI from "openai"
import sharp from "sharp"

// ─────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────
console.log("Starting bot...")
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })
bot.on("polling_error", err => console.error("Polling:", err.message))

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN
const ELLIS_VOICE_ID = "QxpsWUTZAxznFqyH1goJ"

// Pipeline config
const TOTAL_SCENES = 6        // 30 seconds
const REPORTER_EVERY = 4      // scene 4 is reporter (index 3)
const TITLE_CARD_EVERY = 8    // every 8th scene gets title card (ready for longer videos)

// Your Google Drive PNG file IDs
const REPORTER_SCENE_PNG_ID = "1Rb47BC7eWiQndjmZKkHKrvIaIjpViBZC"  // photo for scene compositing
const THUMBNAIL_PNG_ID = "1xhXV1MY484aAdmZiA9a6zeDNkWUT9uQo"       // cutout for thumbnail

const sleep = ms => new Promise(r => setTimeout(r, ms))
let userState = {}
let reporterSceneCount = 0

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/assets"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot is running.")


// ─────────────────────────────────────────
// 20 CAMERA TECHNIQUES — rotate per scene
// ─────────────────────────────────────────
const CAMERA_TECHNIQUES = [
  { name: "Handheld", imageStyle: "handheld camera shot, slight tilt, raw documentary feel", motionStyle: "handheld shaky cam, slight organic movement, documentary style" },
  { name: "Drone Aerial", imageStyle: "aerial drone shot, bird's eye view from high above, sweeping", motionStyle: "slow drone pullback reveal from above" },
  { name: "Slow Motion", imageStyle: "cinematic slow motion frame, dramatic motion blur at edges", motionStyle: "ultra slow motion push in, 240fps look, every detail revealed" },
  { name: "Dolly Zoom", imageStyle: "vertigo dolly zoom, background stretching effect, unsettling depth", motionStyle: "dolly zoom effect, subject stays same size while background changes" },
  { name: "POV", imageStyle: "first person POV shot, as if viewer walks through scene, immersive", motionStyle: "first person POV camera moving forward into the scene" },
  { name: "Security Cam", imageStyle: "security camera wide angle, static surveillance look, slightly grainy", motionStyle: "static security camera, no movement, slight grain" },
  { name: "News Broadcast", imageStyle: "news broadcast camera, professional journalism angle, slightly zoomed", motionStyle: "news camera slow zoom in, professional broadcast movement" },
  { name: "Time Lapse", imageStyle: "time lapse photography, motion blur on moving elements, static background", motionStyle: "time lapse movement, fast flowing environment, static camera" },
  { name: "Crane Shot", imageStyle: "crane shot perspective, camera rising from ground level upward", motionStyle: "crane slowly rising from low to high revealing full scene" },
  { name: "Tracking Shot", imageStyle: "tracking shot, camera moves alongside subject, motion blur background", motionStyle: "tracking shot camera follows subject from the side" },
  { name: "Extreme Close Up", imageStyle: "extreme macro close up, small details fill entire frame, shallow depth", motionStyle: "extreme close up slow zoom revealing tiny details" },
  { name: "Dutch Angle", imageStyle: "dutch angle tilt shot, camera rotated 20 degrees, dramatic unsettling", motionStyle: "dutch angle tilt camera slowly rotating" },
  { name: "Shoulder Mount", imageStyle: "shoulder mounted camera, slight bounce and sway, journalistic feel", motionStyle: "shoulder mount bounce movement, realistic walking pace" },
  { name: "360 Orbit", imageStyle: "360 orbit perspective, camera circling subject, dynamic angle", motionStyle: "slow 360 degree orbit around main subject" },
  { name: "Rack Focus", imageStyle: "rack focus shot, foreground sharp, background beautifully blurred, bokeh", motionStyle: "pull focus from background to foreground, dramatic blur transition" },
  { name: "Top Down", imageStyle: "overhead top down shot, looking straight down at scene from above", motionStyle: "overhead top down slowly pulling back to reveal more" },
  { name: "Low Angle", imageStyle: "low angle ground level shot, looking dramatically upward, powerful", motionStyle: "low angle tilt up slowly, dramatic upward reveal" },
  { name: "Whip Pan", imageStyle: "whip pan transition style, motion blur across frame, dynamic energy", motionStyle: "fast whip pan sweep across the scene" },
  { name: "Underwater", imageStyle: "underwater camera, light rays through water, dreamy distortion", motionStyle: "underwater camera slowly rising toward surface, light above" },
  { name: "Steadicam", imageStyle: "steadicam glide shot, perfectly smooth cinematic float", motionStyle: "steadicam smooth glide forward, perfectly stable cinematic" }
]

const getCam = i => CAMERA_TECHNIQUES[i % CAMERA_TECHNIQUES.length]

// People pattern: 3 with people → 1 without → 3 with → 2 without (repeat)
const PEOPLE_CYCLE = [true, true, true, false, true, true, true, false, false]
const hasPeople = i => PEOPLE_CYCLE[i % PEOPLE_CYCLE.length]

// Reporter scenes: every 4th (scene 4, 8, 12... = index 3, 7, 11...)
const isReporter = i => (i + 1) % REPORTER_EVERY === 0

// Title card scenes: every 8th (won't fire at 6 scenes, but ready)
const isTitleCard = i => (i + 1) % TITLE_CARD_EVERY === 0


// ─────────────────────────────────────────
// GOOGLE DRIVE DOWNLOAD
// ─────────────────────────────────────────
async function downloadFromDrive(fileId, outPath) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} (ID: ${fileId})`)
  const buf = await res.buffer()
  fs.writeFileSync(outPath, buf)
  console.log(`Drive download: ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`)
  return outPath
}


// ─────────────────────────────────────────
// REPLICATE POLLING
// ─────────────────────────────────────────
async function pollReplicate(id, label) {
  const start = Date.now()
  while (true) {
    if (Date.now() - start > 10 * 60 * 1000) throw new Error(`${label} timed out`)
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
// STEP 1 — SCRIPT (YouTube hook structure)
// ─────────────────────────────────────────
async function generateScript(input) {
  let context = input
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const res = await fetch(input, { headers: { "User-Agent": "Mozilla/5.0" } })
      const html = await res.text()
      context = "Article: " + html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 4000)
    } catch { context = `Topic: ${input}` }
  }

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You write viral YouTube voiceover scripts for 30-second videos (6 scenes × 5 seconds).

Structure:
- [SCENE 1-2]: DRAMATIC HOOK — most shocking fact or revelation, creates urgency, max 15 words each
- [SCENE 3-4]: REVELATION — the key story or discovery, max 15 words each
- [SCENE 5-6]: IMPACT — why this matters, strong finish, last scene ends with: Thanks for watching

Rules:
- Label each: [SCENE 1] text [SCENE 2] text etc.
- 12-16 words per scene
- Start with the most shocking statement
- Use real names, dates, numbers when available
- Power words: secret, hidden, never seen, shocking, discovered, revealed, untold
- Write ONLY the labeled scenes, nothing else`
      },
      { role: "user", content: `Write 6-scene 30-second script about:\n\n${context}` }
    ],
    max_tokens: 350,
    temperature: 0.8
  })
  return r.choices[0].message.content.trim()
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE DIRECTIVE
// Ensures all scenes share the same palette, mood, and cinematic feel
// ─────────────────────────────────────────
async function generateVisualStyle(topic, script) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `Define a cinematic visual style for a YouTube video. Applied to ALL scenes for consistency.
Return ONLY valid JSON. No markdown. No backticks.
{
  "colorPalette": "specific colors e.g. warm amber, deep shadow, terracotta",
  "lighting": "specific lighting e.g. dramatic low-key side lighting, golden hour",
  "atmosphere": "e.g. dusty and hazy, cold and desolate, dark and humid",
  "mood": "e.g. tense and mysterious, epic and grand, eerie and unsettling",
  "styleTag": "e.g. cinematic historical documentary, dark sci-fi thriller",
  "consistencyTag": "a short phrase appended to every image prompt for visual consistency",
  "avoid": "what to avoid in all images"
}`
      },
      { role: "user", content: `Video about: ${topic}\nScript: ${script}` }
    ],
    max_tokens: 300,
    temperature: 0.7
  })
  return JSON.parse(r.choices[0].message.content.trim())
}


// ─────────────────────────────────────────
// STEP 3 — SCENE BREAKDOWN
// Parses script into scenes, assigns camera, people, reporter, title card
// ─────────────────────────────────────────
async function buildScenes(rawScript, totalScenes, style, topic) {
  // Parse labeled scenes
  const matches = rawScript.match(/\[SCENE \d+\][^\[]+/g) || []
  const texts = matches.map(s => s.replace(/\[SCENE \d+\]/, "").trim())

  const setup = Array.from({ length: totalScenes }, (_, i) => ({
    index: i,
    camera: getCam(i),
    hasPeople: hasPeople(i),
    isReporter: isReporter(i),
    isTitleCard: isTitleCard(i),
    script: texts[i] || `Scene ${i + 1} about ${topic}`
  }))

  const setupList = setup.map((s, i) =>
    `Scene ${i + 1}: "${s.script}" | Cam: ${s.camera.name} | People: ${s.hasPeople ? "YES 1-3 people" : "NO people"} | Reporter: ${s.isReporter ? "YES man talking to camera in foreground" : "no"}`
  ).join("\n")

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `Generate image and motion prompts for each scene of a YouTube video.

Apply this EXACT visual style to ALL scenes (critical for consistency):
Color palette: ${style.colorPalette}
Lighting: ${style.lighting}  
Atmosphere: ${style.atmosphere}
Mood: ${style.mood}
Style: ${style.styleTag}
Consistency tag (add to every prompt): ${style.consistencyTag}
Avoid in all images: ${style.avoid}

Image prompt rules:
- PHOTOREALISTIC photography ONLY — real photo, shot on camera, no CGI, no illustration, no 3D
- Apply camera technique to the composition style
- Apply visual style consistently
- Include people only if specified
- Reporter scenes: leave clear foreground space where a man talking to camera will be composited
- No text, no watermarks, no logos in image
- 4K cinematic quality

Return ONLY valid JSON:
{
  "scenes": [
    {
      "imagePrompt": "...",
      "motionPrompt": "...",
      "titleCardText": "key word or phrase if title card scene, otherwise null"
    }
  ]
}`
      },
      { role: "user", content: `Prompts for ${totalScenes} scenes:\n${setupList}` }
    ],
    max_tokens: 1500,
    temperature: 0.7
  })

  const data = JSON.parse(r.choices[0].message.content.trim())
  return setup.map((s, i) => ({
    ...s,
    imagePrompt: data.scenes[i]?.imagePrompt || `${s.script}, ${style.styleTag}, photorealistic`,
    motion: data.scenes[i]?.motionPrompt || s.camera.motionStyle,
    titleCardText: data.scenes[i]?.titleCardText || null
  }))
}


// ─────────────────────────────────────────
// STEP 4 — IMAGE GENERATION (Flux 2 Max)
// ─────────────────────────────────────────
async function generateImage(prompt, avoid, index) {
  const full = `${prompt}, photorealistic photography, real photo, ultra detailed, shot on camera, no CGI, no illustration, no 3D, no text, no watermark. Avoid: ${avoid}`

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { prompt: full, width: 1280, height: 720, output_format: "jpg", output_quality: 95 } })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Image ${index + 1} could not start. Check REPLICATE_API_TOKEN.`)

  const result = await pollReplicate(pred.id, `Image ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const path = `/tmp/images/img_${index}.jpg`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// STEP 4B — REPORTER COMPOSITE
// Downloads your PNG and composites it on the background scene
// Alternates position: right → left → right...
// ─────────────────────────────────────────
let cachedReporterPng = null

async function compositeReporter(bgPath, sceneIndex) {
  // Download and cache reporter PNG
  if (!cachedReporterPng) {
    cachedReporterPng = "/tmp/assets/reporter_scene.png"
    await downloadFromDrive(REPORTER_SCENE_PNG_ID, cachedReporterPng)
  }

  const out = `/tmp/images/img_${sceneIndex}_reporter.jpg`
  const W = 1280, H = 720

  // Scale reporter to 68% of frame height
  const personH = Math.round(H * 0.68)
  const personBuf = await sharp(cachedReporterPng)
    .resize({ height: personH, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()

  const meta = await sharp(personBuf).metadata()
  const personW = meta.width || 440

  // Alternate: even reporter = right side, odd = left side
  const isRight = reporterSceneCount % 2 === 0
  const xPos = isRight
    ? Math.round(W * 0.58 - personW / 2)
    : Math.round(W * 0.32 - personW / 2)
  const yPos = H - personH

  await sharp(bgPath)
    .resize(W, H)
    .composite([{
      input: personBuf,
      left: Math.max(0, Math.min(xPos, W - personW)),
      top: Math.max(0, yPos),
      blend: "over"
    }])
    .jpeg({ quality: 95 })
    .toFile(out)

  reporterSceneCount++
  console.log(`Reporter composited on scene ${sceneIndex + 1} (${isRight ? "right" : "left"})`)
  return out
}


// ─────────────────────────────────────────
// STEP 5 — VIDEO (Kling v2.6)
// Reporter scenes use gentle handheld motion
// Keeps Kling ambient audio for SFX mixing
// ─────────────────────────────────────────
async function generateVideo(imgPath, motionPrompt, reporter, index) {
  const motion = reporter
    ? "gentle handheld camera slight natural movement, person talking to camera close up, slight realistic hand shake, not too shaky"
    : motionPrompt

  const imgBuf = fs.readFileSync(imgPath)
  const b64 = `data:image/jpeg;base64,${imgBuf.toString("base64")}`

  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { image: b64, prompt: motion, duration: 5, aspect_ratio: "16:9" } })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} could not start.`)

  const result = await pollReplicate(pred.id, `Video ${index + 1}`)
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
    body: JSON.stringify({ text, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  })
  if (!res.ok) throw new Error(`ElevenLabs failed: ${res.status}`)
  const buf = await res.buffer()
  const path = `/tmp/voices/voice_${index}.mp3`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// STEP 7 — WHISPER CAPTIONS
// Transcribes each voice file and builds SRT with correct time offsets
// ─────────────────────────────────────────
async function transcribeVoice(audioPath) {
  const r = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"]
  })
  return r.segments || []
}

function buildSRT(segments) {
  const t = s => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`
  }
  return segments.map((seg, i) =>
    `${i + 1}\n${t(seg.start)} --> ${t(seg.end)}\n${seg.text.trim()}\n`
  ).join("\n")
}


// ─────────────────────────────────────────
// STEP 8 — MUSIC
// ─────────────────────────────────────────
async function downloadMusic() {
  const driveUrl = process.env.MUSIC_DRIVE_URL
  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveUrl.match(/id=([a-zA-Z0-9_-]+)/)
  if (!match) throw new Error("MUSIC_DRIVE_URL invalid.")
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${match[1]}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  const path = "/tmp/music_raw.mp3"
  fs.writeFileSync(path, buf)
  console.log(`Music: ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
  return path
}


// ─────────────────────────────────────────
// FFMPEG PIPELINE
// ─────────────────────────────────────────
function getDuration(p) {
  return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`).toString().trim())
}

function hasAudio(p) {
  try {
    return execSync(`ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${p}"`).toString().trim() === "audio"
  } catch { return false }
}

function trimVideo(vidPath, dur, i) {
  const out = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${vidPath}" -t ${dur} -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 "${out}"`)
  return out
}

// Mix: Voice 100% + Kling SFX 20%
function buildScene(vidPath, voicePath, i) {
  const out = `/tmp/final/scene_${i}.mp4`
  if (hasAudio(vidPath)) {
    execSync(
      `ffmpeg -y -i "${vidPath}" -i "${voicePath}" ` +
      `-filter_complex "[0:a]volume=0.20[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" ` +
      `-map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  } else {
    execSync(`ffmpeg -y -i "${vidPath}" -i "${voicePath}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
  }
  return out
}

// Title card: big white text at center for first 2.5 seconds of scene
function addTitleCard(vidPath, text, i) {
  const out = `/tmp/final/scene_title_${i}.mp4`
  const safe = text.replace(/'/g, "\\'").replace(/:/g, "\\:").toUpperCase()
  const dur = Math.min(2.5, getDuration(vidPath) * 0.55)
  execSync(
    `ffmpeg -y -i "${vidPath}" ` +
    `-vf "drawtext=text='${safe}':fontcolor=white:fontsize=110:x=(w-tw)/2:y=(h-th)/2:` +
    `borderw=5:bordercolor=black:enable='between(t,0,${dur})'" ` +
    `-c:v libx264 -preset fast -crf 18 -c:a copy "${out}"`
  )
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

// Add music at 40% under voice+SFX, export HD for YouTube
function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.40" "${musicTrim}"`)
  const out = "/tmp/final/with_music.mp4"
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" ` +
    `-filter_complex "[0:a]volume=1.0[ex];[1:a]volume=0.40[mu];[ex][mu]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
    `-map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M ` +
    `-c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}

// Burn captions — white text with semi-transparent dark background
function burnCaptions(vidPath, srtContent) {
  const srtPath = "/tmp/final/captions.srt"
  // Escape path for FFmpeg filter
  const escapedSrt = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")
  fs.writeFileSync(srtPath, srtContent)
  const out = "/tmp/final/final_video.mp4"
  execSync(
    `ffmpeg -y -i "${vidPath}" ` +
    `-vf "subtitles='${escapedSrt}':force_style='Fontname=Sans,Fontsize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=35'" ` +
    `-c:v libx264 -preset slow -crf 18 -b:v 8M -c:a copy -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// THUMBNAIL GENERATOR
// Flux background + your PNG cutout + purple box + impact text
// Matches your example design exactly
// ─────────────────────────────────────────
async function generateThumbnail(topic, script) {
  // 1. Generate wide dramatic background
  const bgRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: `Dramatic cinematic wide scene about ${topic}, atmospheric, photorealistic, 4K, epic scale, no people, no text, no watermark`,
        width: 1280, height: 720, output_format: "jpg", output_quality: 95
      }
    })
  })
  const bgPred = await bgRes.json()
  if (!bgPred.id) throw new Error("Thumbnail background failed to start")
  const bgResult = await pollReplicate(bgPred.id, "Thumbnail BG")
  const bgUrl = Array.isArray(bgResult.output) ? bgResult.output[0] : bgResult.output
  const bgBuf = await (await fetch(bgUrl)).buffer()
  const bgPath = "/tmp/assets/thumb_bg.jpg"
  fs.writeFileSync(bgPath, bgBuf)

  // 2. Generate 4-word impact phrase
  const phraseRes = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "Write a YouTube thumbnail impact phrase. MAXIMUM 4 WORDS. All caps. Shocking and curiosity-triggering. Return ONLY the phrase, nothing else. No quotes." },
      { role: "user", content: `Topic: ${topic}\nScript: ${script}` }
    ],
    max_tokens: 15
  })
  const phrase = phraseRes.choices[0].message.content.trim().toUpperCase().slice(0, 30)
  console.log(`Thumbnail phrase: ${phrase}`)

  // 3. Download thumbnail PNG (your cutout with white outline)
  const personPath = "/tmp/assets/thumb_person.png"
  await downloadFromDrive(THUMBNAIL_PNG_ID, personPath)

  // 4. Composite: background + person + purple box + text using Sharp SVG
  const W = 1280, H = 720

  // Scale person to 80% of frame height
  const personH = Math.round(H * 0.80)
  const personBuf = await sharp(personPath)
    .resize({ height: personH, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()
  const pMeta = await sharp(personBuf).metadata()
  const personW = pMeta.width || 520

  // Center person horizontally
  const personX = Math.round((W - personW) / 2)
  const personY = H - personH

  // Purple box — 76% of width, centered, in lower third
  const boxW = Math.round(W * 0.76)
  const boxH = 100
  const boxX = Math.round((W - boxW) / 2)
  const boxY = Math.round(H * 0.72)

  // Dynamic font size based on phrase length
  const baseFontSize = 58
  const fontSize = Math.max(32, Math.min(baseFontSize, Math.round(baseFontSize * (12 / Math.max(phrase.length, 12)))))

  // SVG overlay: purple box + decorative right edge + text
  const svgOverlay = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="6" ry="6" fill="#9B19F5"/>
    <rect x="${boxX + boxW - 20}" y="${boxY}" width="20" height="${boxH}" rx="6" ry="6" fill="#6600AA"/>
    <text 
      x="${boxX + (boxW - 20) / 2 + boxX * 0}" 
      y="${boxY + boxH / 2 + fontSize * 0.36}" 
      font-family="Arial Black, Arial, sans-serif" 
      font-size="${fontSize}" 
      font-weight="900"
      fill="#0D0D3D" 
      text-anchor="middle"
      dominant-baseline="auto">${phrase}</text>
  </svg>`

  const thumbPath = "/tmp/assets/thumbnail.jpg"
  await sharp(bgPath)
    .resize(W, H)
    .composite([
      { input: personBuf, left: Math.max(0, personX), top: Math.max(0, personY), blend: "over" },
      { input: Buffer.from(svgOverlay), left: 0, top: 0, blend: "over" }
    ])
    .jpeg({ quality: 95 })
    .toFile(thumbPath)

  console.log("Thumbnail done.")
  return thumbPath
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, "Send me a theme, article link, or paste any text about your topic.")
})


// ─────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"
  reporterSceneCount = 0
  cachedReporterPng = null

  try {

    // ── SCRIPT ──
    await bot.sendMessage(chatId, "✍️ Writing 30-second YouTube hook script...")
    const rawScript = await generateScript(input)
    const topic = input.length > 100 ? input.slice(0, 80) + "..." : input
    await bot.sendMessage(chatId, `📄 Script:\n\n${rawScript}`)

    // ── VISUAL STYLE ──
    await bot.sendMessage(chatId, "🎨 Defining visual style for all scenes...")
    const style = await generateVisualStyle(topic, rawScript)
    await bot.sendMessage(chatId, `🎨 Style: ${style.styleTag}\n🖌 Palette: ${style.colorPalette}\n🎭 Mood: ${style.mood}`)

    // ── SCENE PLAN ──
    await bot.sendMessage(chatId, "🎬 Building 6-scene plan...")
    const scenes = await buildScenes(rawScript, TOTAL_SCENES, style, topic)
    let plan = ""
    scenes.forEach((s, i) => {
      plan += `Scene ${i + 1}: ${s.camera.name}${s.isReporter ? " 🎙REPORTER" : ""}${s.isTitleCard ? " 📺TITLE" : ""} | ${s.hasPeople ? "👥" : "🏔"}\n`
    })
    await bot.sendMessage(chatId, plan)

    // ── GENERATE ALL SCENES ──
    const imagePaths = [], videoPaths = [], voicePaths = []

    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]
      await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Image generating...${s.isReporter ? " (reporter)" : ""}`)

      // Generate background image
      let imgPath = await generateImage(s.imagePrompt, style.avoid, i)

      // Composite reporter PNG for every 4th scene
      if (s.isReporter) {
        try {
          imgPath = await compositeReporter(imgPath, i)
          await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Reporter composited`)
        } catch (e) {
          console.error("Reporter composite failed:", e.message)
          await bot.sendMessage(chatId, `⚠️ Scene ${i + 1}: Reporter composite failed, using background only`)
        }
      }
      imagePaths.push(imgPath)

      // Generate video
      await bot.sendMessage(chatId, `⏳ Scene ${i + 1}/${scenes.length}: Video generating (~3-5 min)...`)
      const vid = await generateVideo(imgPath, s.motion, s.isReporter, i)
      videoPaths.push(vid)

      // Generate voice
      const voice = await generateVoice(s.script, i)
      voicePaths.push(voice)
      await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Done — image + video + voice`)
    }

    // ── WHISPER CAPTIONS ──
    await bot.sendMessage(chatId, "📝 Transcribing for captions...")
    const allSegs = []
    let timeOffset = 0
    for (let i = 0; i < voicePaths.length; i++) {
      try {
        const segs = await transcribeVoice(voicePaths[i])
        segs.forEach(s => allSegs.push({ text: s.text, start: timeOffset + s.start, end: timeOffset + s.end }))
      } catch (e) { console.error(`Whisper ${i + 1} failed:`, e.message) }
      timeOffset += getDuration(voicePaths[i])
    }
    const srtContent = buildSRT(allSegs)
    await bot.sendMessage(chatId, `✅ Captions ready (${allSegs.length} segments)`)

    // ── TRIM + BUILD SCENES ──
    await bot.sendMessage(chatId, "✂️ Cutting videos and mixing audio layers...")
    const scenePaths = []
    let totalDuration = 0

    for (let i = 0; i < scenes.length; i++) {
      const audioDur = getDuration(voicePaths[i])
      totalDuration += audioDur
      const trimmed = trimVideo(videoPaths[i], audioDur, i)
      let sceneOut = buildScene(trimmed, voicePaths[i], i)

      // Title card overlay (every 8th scene — fires at scenes 8, 16, 24...)
      if (scenes[i].isTitleCard && scenes[i].titleCardText) {
        sceneOut = addTitleCard(sceneOut, scenes[i].titleCardText, i)
        await bot.sendMessage(chatId, `📺 Title card: "${scenes[i].titleCardText}"`)
      }

      scenePaths.push(sceneOut)
      await bot.sendMessage(chatId, `✅ Scene ${i + 1}: Cut to ${audioDur.toFixed(1)}s — Voice + SFX mixed`)
    }

    // ── CONCAT ──
    await bot.sendMessage(chatId, "🔗 Joining all 6 scenes...")
    const concatenated = concatScenes(scenePaths)

    // ── MUSIC ──
    await bot.sendMessage(chatId, "🎵 Adding background music at 40%...")
    const musicPath = await downloadMusic()
    const withMusic = addMusicHD(concatenated, musicPath, totalDuration)

    // ── BURN CAPTIONS ──
    let finalVideo = withMusic
    if (allSegs.length > 0) {
      await bot.sendMessage(chatId, "📝 Burning captions into video...")
      try {
        finalVideo = burnCaptions(withMusic, srtContent)
      } catch (e) {
        console.error("Caption burn failed:", e.message)
        await bot.sendMessage(chatId, `⚠️ Captions failed: ${e.message} — video without captions`)
      }
    }

    // ── THUMBNAIL ──
    await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
    let thumbPath = null
    try {
      thumbPath = await generateThumbnail(topic, rawScript)
    } catch (e) {
      console.error("Thumbnail failed:", e.message)
      await bot.sendMessage(chatId, `⚠️ Thumbnail error: ${e.message}`)
    }

    // ── DELIVER ──
    await bot.sendVideo(chatId, finalVideo, {
      caption: `🎬 30-second video ready!\n🎤 Voice 100% | 🔊 SFX 20% | 🎵 Music 40%\n📝 Captions: ${allSegs.length > 0 ? "✅" : "❌"}`
    })

    if (thumbPath && fs.existsSync(thumbPath)) {
      await bot.sendPhoto(chatId, thumbPath, { caption: `🖼 Thumbnail ready!\n💬 "${rawScript.match(/\[SCENE 1\][^\[]+/)?.[0]?.replace("[SCENE 1]", "").trim().slice(0, 50)}..."` })
    }

    await bot.sendMessage(chatId, "✅ All done! Send 'do it' to create another video.")
    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nSend 'do it' to try again.`)
    userState[chatId] = {}
  }
})
