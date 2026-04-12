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

const TARGET_VIDEO_MINUTES = 10
const TARGET_SCENE_SECONDS = 5
const SCENES_PER_CHUNK = 12 // 12 scenes × 5s = 60s = 1 minute
const WORDS_PER_SCENE = 12
const STEP_TIMEOUT_MS = 8 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))
const safeJSON = str => {
  const clean = str.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim()
  return JSON.parse(clean)
}

async function sendLongMessage(chatId, text) {
  const MAX = 4000
  if (text.length <= MAX) {
    await bot.sendMessage(chatId, text)
    return
  }
  const parts = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      parts.push(remaining)
      break
    }
    let cut = remaining.lastIndexOf("\n", MAX)
    if (cut < MAX / 2) cut = remaining.lastIndexOf(" ", MAX)
    if (cut < MAX / 2) cut = MAX
    parts.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trim()
  }
  for (const part of parts) {
    await bot.sendMessage(chatId, part)
  }
}

const stoppedChats = new Set()
let userState = {}

for (const d of ["/tmp/images", "/tmp/videos", "/tmp/voices", "/tmp/final", "/tmp/chunks"]) {
  fs.mkdirSync(d, { recursive: true })
}
console.log("Bot running.")


// ─────────────────────────────────────────
// 7 CAMERA TECHNIQUES (for Kling video motion)
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
// 15 IMAGE ANGLES (for Flux image generation)
// ─────────────────────────────────────────
const IMAGE_ANGLES = [
  { name: "Eye Level",          prompt: "shot from eye level, natural human perspective" },
  { name: "Low Angle",          prompt: "shot from a low angle looking up, subject appears powerful and imposing" },
  { name: "High Angle",         prompt: "shot from a high angle looking down at the subject" },
  { name: "Bird's Eye",         prompt: "shot from directly overhead, top-down bird's eye view" },
  { name: "Worm's Eye",         prompt: "extreme low angle from ground level looking straight up" },
  { name: "Dutch Angle",        prompt: "shot at a tilted diagonal angle, creating tension" },
  { name: "Over the Shoulder",  prompt: "shot from over someone's shoulder looking at the scene" },
  { name: "Wide Establishing",  prompt: "wide establishing shot showing the full environment from a distance" },
  { name: "Close-Up",           prompt: "tight close-up shot filling the frame with the main subject" },
  { name: "Extreme Close-Up",   prompt: "extreme close-up on a single detail like eyes, hands, or texture" },
  { name: "Three-Quarter",      prompt: "shot from a 45-degree angle to the side of the subject" },
  { name: "Profile",            prompt: "side profile view, subject facing sideways at 90 degrees" },
  { name: "POV First Person",   prompt: "first-person point of view, as if seen through someone's own eyes" },
  { name: "Rear View",          prompt: "shot from behind the subject, looking at what they see ahead" },
  { name: "Foreground Framing", prompt: "shot through a foreground element like a doorway or window, subject in background" }
]

const OPENING_ANGLE = IMAGE_ANGLES.find(a => a.name === "Wide Establishing")
const getAngle = i => IMAGE_ANGLES[i % IMAGE_ANGLES.length]


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
// WOMAN PRESENTER
// ─────────────────────────────────────────
const PRESENTER_FACE_ID = "1oxbm7wh3MogxXI1j2rHF6fI9GQHht5Kq"
const PRESENTER_VOICE_ID = "X1amM3LR8OIq8LP92VpO" // Lauren voice

async function downloadPresenterFace() {
  const path = `/tmp/images/presenter_face.png`
  if (fs.existsSync(path)) return path
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${PRESENTER_FACE_ID}&confirm=t`)
  if (!res.ok) throw new Error(`Presenter face download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync(path, buf)
  return path
}

// Presenter location/studio pattern tracker
// Pattern: 3 location, 1 studio, 3 location, 1 studio...
let presenterAppearanceCount = 0
function resetPresenterState() {
  presenterAppearanceCount = 0
  presenterOutfit = ""
}
function isStudioScene() {
  const inGroup = presenterAppearanceCount % 4
  presenterAppearanceCount++
  return inGroup === 3 // 4th appearance = studio
}

// First outfit is locked for all location scenes
let presenterOutfit = ""

async function generatePresenterImage(script, topic, isStudio, chatId) {
  const facePath = await downloadPresenterFace()
  const faceUrl = await uploadToReplicate(facePath, "image/png")

  // Common description of the presenter — must match reference face
  const presenterDesc = "young beautiful woman with dark hair, green eyes, full lips, glowing skin, attractive and confident. Medium close-up shot from waist up, facing the camera"

  let locationPrompt
  if (isStudio) {
    locationPrompt = `${presenterDesc}. She stands in a modern broadcast studio in front of a large screen showing imagery about: ${topic}. She wears a fitted navy blazer and white blouse. Studio lighting, monitors visible. She gestures toward the screen while presenting.`
  } else {
    if (!presenterOutfit) {
      presenterOutfit = await callClaude(
        `Based on this topic, describe in 10 words what stylish but practical clothing a young attractive female field reporter would wear at this location. Be specific about colors and style. Write ONLY the clothing.`,
        topic,
        50
      )
      presenterOutfit = presenterOutfit.trim()
    }
    locationPrompt = `${presenterDesc}. She is on location wearing ${presenterOutfit}. Behind her: the actual scene of "${script}". She gestures toward the scene while reporting. Real location, dramatic natural lighting.`
  }

  const fullPrompt = locationPrompt + REALISM_STYLE_SUFFIX
  console.log(`Presenter image: ${fullPrompt.slice(0, 120)}...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: fullPrompt,
        image_prompt: faceUrl,
        image_prompt_strength: 0.45,
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        output_format: "jpg",
        output_quality: 95
      }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Presenter image failed: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, "Presenter image", chatId), "Presenter image")
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(imageUrl)).buffer()
  const imgPath = `/tmp/images/presenter_${Date.now()}.jpg`
  fs.writeFileSync(imgPath, buf)
  return imgPath
}

async function generatePresenterVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${PRESENTER_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  })
  if (!res.ok) throw new Error(`ElevenLabs presenter failed: ${res.status}`)
  const buf = await res.buffer()
  const path = `/tmp/voices/presenter_voice_${index}.mp3`
  fs.writeFileSync(path, buf)
  return path
}


// ─────────────────────────────────────────
// KLING LIP SYNC
// ─────────────────────────────────────────
async function uploadToReplicate(filePath, contentType) {
  const fileData = fs.readFileSync(filePath)
  const filename = filePath.split("/").pop()
  const boundary = "----ReplicateUpload" + Date.now()

  let body = `--${boundary}\r\n`
  body += `Content-Disposition: form-data; name="content"; filename="${filename}"\r\n`
  body += `Content-Type: ${contentType}\r\n\r\n`

  const bodyStart = Buffer.from(body, "utf-8")
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8")
  const fullBody = Buffer.concat([bodyStart, fileData, bodyEnd])

  const res = await fetch("https://api.replicate.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_TOKEN}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body: fullBody
  })
  const data = await res.json()
  if (!data.urls?.get) throw new Error(`File upload failed: ${JSON.stringify(data).slice(0, 200)}`)
  console.log(`Uploaded ${filename} → ${data.urls.get}`)
  return data.urls.get
}

async function generateLipSync(faceImagePath, voicePath, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  // Upload both files to Replicate's file hosting
  console.log(`LipSync ${index + 1}: uploading image and audio to Replicate...`)
  const imageUrl = await uploadToReplicate(faceImagePath, "image/png")
  const audioUrl = await uploadToReplicate(voicePath, "audio/mpeg")

  console.log(`LipSync ${index + 1}: sending to OmniHuman`)
  const res = await fetch("https://api.replicate.com/v1/models/bytedance/omni-human-1.5/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        audio: audioUrl,
        prompt: "Person looking directly at camera, maintaining eye contact, natural hand gestures while speaking, confident presenter body language, subtle head movements"
      }
    })
  })
  const pred = await res.json()
  console.log("OmniHuman response:", JSON.stringify(pred).slice(0, 300))
  if (!pred.id) throw new Error(`LipSync failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, `LipSync ${index + 1}`, chatId), `LipSync ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const rawPath = `/tmp/videos/lipsync_${index}_raw.mp4`
  fs.writeFileSync(rawPath, buf)

  // Trim to exact audio length and normalize to 1280x720 — no zoom, no effects
  const audioDuration = getDuration(voicePath)
  console.log(`LipSync ${index + 1}: audio is ${audioDuration.toFixed(1)}s, trimming video to match`)

  const path = `/tmp/videos/lipsync_${index}.mp4`
  execSync(
    `ffmpeg -y -i "${rawPath}" -t ${audioDuration} -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`
  )

  console.log(`LipSync ${index + 1}: done (${audioDuration.toFixed(1)}s)`)
  return path
}





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
// CLAUDE HELPERS
// ─────────────────────────────────────────
async function callClaude(system, user, maxTokens = 1000) {
  const msg = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }]
  })
  return msg.content[0].text
}

async function callClaudeNoRefuse(system, user, maxTokens = 4000) {
  const msg = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system,
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: "Here" }
    ]
  })
  return "Here" + msg.content[0].text
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
// STEP 1 — FULL 10-MINUTE SCRIPT
// Plain paragraphs, no scene labels
// ─────────────────────────────────────────
async function generateFullScript(input) {
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

  const targetWords = 1550
  const minWords = 1500
  const maxWords = 1650

  // PASS 1: Generate detailed outline with story beats
  console.log("Script pass 1: generating outline...")
  const outline = await callClaude(
    `You are a professional YouTube scriptwriter. Create a detailed OUTLINE for a 10-minute narration video.

Structure the outline as:
HOOK (first 20 seconds): [describe the dramatic opening — must grab attention immediately]
CONTEXT (minutes 1-2): [set the scene, introduce the topic]
DEEP DIVE (minutes 3-5): [main story, revelations, key facts — HIGH INTENSITY]
TWIST (minutes 6-8): [unexpected angle, deeper mystery, emotional turn]
CLIMAX (minutes 8-9): [highest stakes, most dramatic revelation]
CLOSE (final minute): [emotional payoff, reflection, end with "Thanks for watching"]

For each section, list 3-5 specific story beats (events, facts, moments to describe).
Write the outline ONLY, no narration yet.`,
    `Topic:\n\n${context}`,
    1500
  )
  console.log("Outline done, starting pass 2...")

  // PASS 2: Write full narration from outline
  let raw = await callClaude(
    `You are a professional scriptwriter. Write the FULL narration based on this outline.

CRITICAL: Write EXACTLY ${targetWords} words (between ${minWords} and ${maxWords}). Count carefully.

WRITING STYLE:
- THE FIRST 3 SENTENCES ARE THE MOST IMPORTANT — extremely dramatic, intriguing, visually striking. HOOK the viewer instantly.
- Fully original wording — never repeat phrases or ideas
- HIGH INTENSITY first half — fast-paced, gripping, constant revelations
- DEEP IMMERSIVE second half — slower, more detailed, emotionally resonant
- ESCALATION throughout — each paragraph raises the stakes
- Strong emotional payoff at the end
- Write in flowing paragraphs — NO scene labels, bullet points, or headers
- Third person — describe events, places, people
- Occasionally use speculative framing like "some believe" but mostly direct storytelling
- End with the exact words: Thanks for watching.
- Write ONLY the narration text — no titles, no notes, no preamble like "Here is the script"`,
    `OUTLINE:\n\n${outline}\n\nTOPIC:\n\n${context}`,
    8000
  )

  raw = raw.trim()

  // If script is too short, ask Claude to expand it
  let words = countWords(raw)
  if (words < minWords) {
    console.log(`Script too short: ${words} words, need ${minWords}. Expanding...`)
    const expansion = await callClaudeNoRefuse(
      `You are continuing a YouTube narration script. The current script is ${words} words but needs to be at least ${minWords} words.
Write additional narration paragraphs that continue the story seamlessly. Add more details, events, and mystery. Write at least ${minWords - words + 100} more words but no more than ${maxWords - words} words.
Do NOT repeat what was already written. Do NOT add scene labels or headers. End with: Thanks for watching.
Write ONLY the additional narration text.`,
      `Current script so far:\n\n${raw.replace(/Thanks for watching\.?\s*$/i, "")}`,
      3000
    )
    raw = raw.replace(/Thanks for watching\.?\s*$/i, "").trim() + "\n\n" + expansion.trim()
    if (!raw.match(/Thanks for watching\.?\s*$/i)) {
      raw += "\n\nThanks for watching."
    }
  }

  // Clean up: remove any preamble Claude adds before the actual narration
  raw = raw.replace(/^Here[\s\S]*?:\s*\n/i, "").trim()
  raw = raw.replace(/^(Here's|Here is|Below is|The following)[\s\S]*?:\s*\n/i, "").trim()

  // If script is too long, trim to maxWords at a sentence boundary
  words = countWords(raw)
  if (words > maxWords) {
    console.log(`Script too long: ${words} words, trimming to ~${maxWords}...`)
    const sentences = raw.match(/[^.!?]*[.!?]+[\s]*/g) || [raw]
    let trimmed = ""
    for (const sentence of sentences) {
      if (countWords(trimmed + sentence) > maxWords && trimmed) break
      trimmed += sentence
    }
    if (!trimmed.match(/Thanks for watching\.?\s*$/i)) {
      trimmed = trimmed.trim() + " Thanks for watching."
    }
    raw = trimmed.trim()
  }

  return raw
}

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length
}


// ─────────────────────────────────────────
// STEP 2 — VISUAL STYLE (once for whole video)
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
    `Topic: ${topic}\nScript: ${script.slice(0, 1000)}`,
    250
  )
  return safeJSON(raw)
}


const THUMBNAIL_STYLE_SUFFIX = `
Photorealistic photograph, super high definition, ultra sharp detail. High contrast with vibrant saturated colors that pop and catch the eye. Bold dramatic lighting. Every detail is crisp and clear even at small sizes. Image demands attention and makes people want to click.
Everything in the image must be physically possible and make sense in the real world. No fantasy elements, no impossible physics, no duplicated objects, no magical effects. The drama comes from the real moment, not from adding impossible elements.`


// ─────────────────────────────────────────
// STEP 3 — THUMBNAIL
// ─────────────────────────────────────────
async function generateThumbnail(topic, script, style, chatId) {
  const thumbPrompt = await callClaude(
    `You must read the ENTIRE script below and pick the SINGLE most dramatic, shocking, or visually striking moment from the whole story. Then write a 30-word image prompt that captures THAT specific moment as a YouTube thumbnail.

YOUTUBE THUMBNAIL PSYCHOLOGY:
- ONE clear subject taking up 40-60% of the frame — not cluttered
- HIGH CONTRAST between subject and background — subject must pop
- If there's a person, show EMOTIONAL EXPRESSION (shock, awe, fear, determination)
- VISUAL MYSTERY — something partially hidden, revealed, or about to happen
- DRAMATIC SCALE — show something massive, imposing, or overwhelming
- Everything must be PHYSICALLY POSSIBLE — no fantasy, no impossible physics, no duplicated objects
- Bold dramatic lighting with strong shadows
- The image must make someone STOP scrolling and CLICK

Write ONLY the 30-word prompt, nothing else.`,
    `Topic: ${topic}\n\nFULL SCRIPT:\n${script}`,
    150
  )

  // Use thumbnail suffix instead of realism suffix
  const fullPrompt = thumbPrompt.trim() + THUMBNAIL_STYLE_SUFFIX
  console.log(`Thumbnail: ${fullPrompt.slice(0, 120)}...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: fullPrompt,
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        output_format: "jpg",
        output_quality: 95
      }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Thumbnail failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, "Thumbnail", chatId), "Thumbnail")
  const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(imageUrl)).buffer()
  const path = `/tmp/images/thumbnail.jpg`
  fs.writeFileSync(path, buf)
  return { path, url: imageUrl }
}


// ─────────────────────────────────────────
// SPLIT TEXT INTO SENTENCES
// ─────────────────────────────────────────
function splitIntoSentences(text) {
  // Split on sentence-ending punctuation followed by space or end
  const raw = text.match(/[^.!?]*[.!?]+[\s]*/g) || [text]
  return raw.map(s => s.trim()).filter(s => s.length > 0)
}


// ─────────────────────────────────────────
// SPLIT SCRIPT INTO CHUNKS
// Each chunk = ~1 minute of narration (~150 words)
// Groups complete sentences, never breaks mid-sentence
// ─────────────────────────────────────────
function splitScriptIntoChunks(script) {
  const sentences = splitIntoSentences(script)
  const wordsPerChunk = SCENES_PER_CHUNK * WORDS_PER_SCENE // ~144 words per chunk
  const chunks = []
  let current = ""

  for (const sentence of sentences) {
    const combined = current ? current + " " + sentence : sentence
    if (countWords(combined) > wordsPerChunk && current) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current = combined
    }
  }
  if (current.trim()) chunks.push(current.trim())

  // If last chunk is too short (< 50 words), merge with previous
  if (chunks.length > 1 && countWords(chunks[chunks.length - 1]) < 50) {
    const last = chunks.pop()
    chunks[chunks.length - 1] += " " + last
  }

  return chunks
}


// ─────────────────────────────────────────
// SPLIT CHUNK INTO SCENES — Claude does the splitting
// Each scene = complete thought, 8-12 words (~5 seconds of speech)
// ─────────────────────────────────────────
async function splitChunkIntoScenes(chunkText) {
  const raw = await callClaude(
    `Split this narration text into individual scenes for a video. Each scene will be spoken aloud (~5 seconds) and followed by a pause.

RULES:
- Each scene MUST be a COMPLETE thought that makes sense on its own
- Each scene should be 8-12 words (about 5 seconds when spoken). This is critical for timing.
- NEVER go over 15 words in a single scene
- NEVER cut a sentence in half — every scene must end at a period, question mark, or exclamation mark
- If a sentence is too long (over 15 words), split it into two scenes by rephrasing slightly
- For each scene, assign a PACING tag based on the emotional intensity:
  "fast" = intense revelation, action (0.5s pause after)
  "normal" = standard narration (1s pause after)
  "slow" = emotional, reflective moment (1.5s pause after)
  "dramatic" = major revelation or cliffhanger (2.5s pause after)

Return ONLY a JSON array of objects: [{"text": "scene text", "pacing": "normal"}, ...]
Return ONLY the JSON array, no other text`,
    chunkText,
    2000
  )
  try {
    const parsed = safeJSON(raw)
    // Handle both formats: array of objects or array of strings
    if (parsed.length > 0 && typeof parsed[0] === "string") {
      return parsed.map(t => ({ text: t, pacing: "normal" }))
    }
    return parsed
  } catch {
    console.log("Claude scene split failed, falling back to sentence split")
    const sentences = splitIntoSentences(chunkText)
    return sentences.length > 0 ? sentences.map(t => ({ text: t, pacing: "normal" })) : [{ text: chunkText, pacing: "normal" }]
  }
}


// ─────────────────────────────────────────
// SCENE BREAKDOWN — build image prompts
// ─────────────────────────────────────────
async function buildScenePrompts(sceneTexts, style, visualSuggestion, globalSceneIndex, topic, scriptSummary) {
  const userVisualNote = visualSuggestion ? ` ${visualSuggestion}.` : ""
  const scenes = []
  const previousPrompts = []

  for (let i = 0; i < sceneTexts.length; i++) {
    const absIndex = globalSceneIndex + i
    const script = sceneTexts[i]
    const camera = absIndex === 0 ? OPENING_CAMERA : getCam(absIndex)
    const angle = absIndex === 0 ? OPENING_ANGLE : getAngle(absIndex)

    const prevContext = previousPrompts.length > 0
      ? `\nPREVIOUS SCENES (DO NOT REPEAT similar compositions):\n${previousPrompts.map((p, j) => `- Scene ${j + 1}: ${p}`).join("\n")}`
      : ""

    const systemPrompt = `You are creating an image prompt for a YouTube video about: "${topic}"

VIDEO CONTEXT (read this to understand what the video is about):
${scriptSummary}

Write a SHORT image prompt (20-30 words max) for this specific scene.
Be LITERAL and SIMPLE — describe only what is physically in the frame. No poetry, no metaphors.
The image MUST make sense in the context of the overall video topic above.
Format: "[angle]. [who/what is in the scene] [what they are doing] [where]. [time of day]."${prevContext}

MUST INCLUDE:
- Ultra realistic
- Massive scale when appropriate
- People actively performing a visible action (not standing still)
- Clear weather conditions
- Dramatic lighting
- Visible tension or danger when the script implies it
- No fantasy elements — everything must be physically possible

RULES:
- Start with the camera angle: "${angle.prompt}"
- Each scene MUST show a DIFFERENT subject, location, or moment than previous scenes
- Keep it under 30 words
- AVOID words that trigger AI safety filters: no gore, blood, death, weapons being fired, corpses, nudity, graphic violence. Describe scenes in a documentary tone.
- Style: ${style.mood}.${userVisualNote}
- Write ONLY the prompt, nothing else`

    const imagePrompt = await callClaude(systemPrompt, `Scene script line: "${script}"`, 100)
    const trimmedPrompt = imagePrompt.trim().replace(/^["']|["']$/g, "")

    previousPrompts.push(trimmedPrompt.slice(0, 60))

    scenes.push({
      script,
      imagePrompt: trimmedPrompt,
      motion: camera.motion,
      cameraName: camera.name,
      angleName: angle.name
    })
  }

  return scenes
}


// ─────────────────────────────────────────
// REALISM STYLE — appended to every image prompt
// ─────────────────────────────────────────
const REALISM_STYLE_SUFFIX = `
Photorealistic photograph with natural imperfections: slight sensor noise, subtle focus variation, real-world micro-details. Materials and surfaces look physically real — touched, used, existing in the real world. Overall image feels like a candid moment captured by someone who was actually there.`


// ─────────────────────────────────────────
// IMAGE GENERATION (Flux 2 Max)
// ─────────────────────────────────────────
async function generateImage(prompt, index, chatId, retryCount = 0) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  const fullPrompt = prompt + REALISM_STYLE_SUFFIX
  console.log(`Image ${index + 1} (attempt ${retryCount + 1}): ${fullPrompt.slice(0, 120)}...`)

  const res = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-2-max/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: {
        prompt: fullPrompt,
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        output_format: "jpg",
        output_quality: 95
      }
    })
  })
  const pred = await res.json()
  console.log(`Flux prediction created:`, JSON.stringify(pred).slice(0, 500))
  if (!pred.id) throw new Error(`Image failed to start: ${pred.detail || pred.error?.message || JSON.stringify(pred).slice(0, 200)}`)

  try {
    const result = await withTimeout(pollReplicate(pred.id, `Image ${index + 1}`, chatId), `Image ${index + 1}`)
    const imageUrl = Array.isArray(result.output) ? result.output[0] : result.output

    const buf = await (await fetch(imageUrl)).buffer()
    const path = `/tmp/images/img_${index}.jpg`
    fs.writeFileSync(path, buf)

    try {
      const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${path}"`).toString().trim()
      console.log(`Image ${index + 1} done — dimensions: ${dims}`)
    } catch {
      console.log(`Image ${index + 1} done`)
    }

    return { path, url: imageUrl }
  } catch (err) {
    // If flagged as sensitive, retry with sanitized prompt
    if (err.message && /sensitive|flagged|E005|safety/i.test(err.message) && retryCount < 2) {
      console.log(`Image ${index + 1} flagged as sensitive, sanitizing and retrying...`)
      // Ask Claude to rewrite the prompt without anything that could trigger safety filters
      const sanitized = await callClaude(
        `This image prompt was flagged by a safety filter. Rewrite it to describe the SAME scene but remove any words that could trigger content filters (violence, weapons, military combat, blood, death, destruction, nudity, etc). Keep the same composition and camera angle. Keep it under 30 words. Write ONLY the new prompt.`,
        `Flagged prompt: ${prompt}`,
        100
      )
      return generateImage(sanitized.trim(), index, chatId, retryCount + 1)
    }
    throw err
  }
}


// ─────────────────────────────────────────
// VIDEO GENERATION (Kling v2.6)
// ─────────────────────────────────────────
async function generateVideo(imageUrl, imagePath, motionPrompt, imagePrompt, index, chatId) {
  if (chatId && isStopped(chatId)) throw new Error("Stopped by user")

  let klingImage = imageUrl
  try {
    const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${imagePath}"`).toString().trim()
    const [w, h] = dims.split(",").map(Number)
    const ratio = w / h
    if (ratio < 1.6 || ratio > 1.9) {
      const resizedPath = `/tmp/images/img_${index}_16x9.jpg`
      execSync(`ffmpeg -y -i "${imagePath}" -vf "scale=1344:768:force_original_aspect_ratio=decrease,pad=1344:768:(ow-iw)/2:(oh-ih)/2" -q:v 4 "${resizedPath}"`)
      klingImage = `data:image/jpeg;base64,${fs.readFileSync(resizedPath).toString("base64")}`
    }
  } catch {}

  const peopleWords = /\b(people|person|soldier|military|personnel|crowd|man|woman|figure|worker|officer|guard|child|group)\b/i
  // Build a rich, specific motion prompt from the image content
  let fullPrompt = `${motionPrompt}, premium documentary cinematography`
  if (peopleWords.test(imagePrompt)) {
    fullPrompt += ", people visibly performing actions — walking, working, gesturing, interacting naturally, clothes and hair moving with wind"
  }
  // Add environmental motion based on scene content
  if (/desert|sand|dust/i.test(imagePrompt)) fullPrompt += ", dust particles drift through the air, sand shifts"
  if (/water|ocean|river|rain/i.test(imagePrompt)) fullPrompt += ", water flows and ripples naturally"
  if (/sky|cloud/i.test(imagePrompt)) fullPrompt += ", clouds drift slowly across the sky"
  if (/fire|flame|smoke/i.test(imagePrompt)) fullPrompt += ", flames flicker and smoke rises"
  if (/tree|forest|vegetation/i.test(imagePrompt)) fullPrompt += ", leaves and branches sway gently in the breeze"

  console.log(`Video ${index + 1}: sending to Kling`)
  const res = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { start_image: klingImage, prompt: fullPrompt, duration: 5, aspect_ratio: "16:9", generate_audio: true }
    })
  })
  const pred = await res.json()
  if (!pred.id) throw new Error(`Video ${index + 1} failed to start: ${pred.detail || JSON.stringify(pred)}`)

  const result = await withTimeout(pollReplicate(pred.id, `Video ${index + 1}`, chatId), `Video ${index + 1}`)
  const url = Array.isArray(result.output) ? result.output[0] : result.output
  const buf = await (await fetch(url)).buffer()
  const rawPath = `/tmp/videos/video_${index}_raw.mp4`
  const path = `/tmp/videos/video_${index}.mp4`
  fs.writeFileSync(rawPath, buf)

  // ENFORCE 16:9
  try {
    const dims = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${rawPath}"`).toString().trim()
    const [w, h] = dims.split(",").map(Number)
    const ratio = w / h
    if (ratio < 1.6 || ratio > 1.9) {
      const targetRatio = 16 / 9
      let cropW, cropH
      if (ratio < targetRatio) { cropW = w; cropH = Math.round(w / targetRatio) }
      else { cropH = h; cropW = Math.round(h * targetRatio) }
      cropW -= cropW % 2; cropH -= cropH % 2
      execSync(`ffmpeg -y -i "${rawPath}" -vf "crop=${cropW}:${cropH},scale=1280:720,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`)
    } else {
      fs.copyFileSync(rawPath, path)
    }
  } catch {
    try {
      execSync(`ffmpeg -y -i "${rawPath}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${path}"`)
    } catch { fs.copyFileSync(rawPath, path) }
  }

  return path
}


// ─────────────────────────────────────────
// VOICE GENERATION (ElevenLabs)
// ─────────────────────────────────────────
async function generateVoice(text, index) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELLIS_VOICE_ID}`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
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
// MUSIC — 3 options from Google Drive
// ─────────────────────────────────────────
const MUSIC_OPTIONS = [
  { name: "Hopeful", id: "1Cw_QOTNCuImtn3miP4IQWUkhRsFhyCEU" },
  { name: "Suspense", id: "1wU0OEEXca-ctc0EYWNeS6IL3pLO7p_jC" },
  { name: "Space", id: "1CY8Fi1Mdz1RXO4QvwHrQDXa4UxS0dg4r" }
]

async function downloadMusicByChoice(choice) {
  const music = MUSIC_OPTIONS[choice - 1]
  if (!music) throw new Error(`Invalid music choice: ${choice}`)
  const path = `/tmp/music_${music.name.toLowerCase()}.mp3`
  if (fs.existsSync(path)) return path
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${music.id}&confirm=t`)
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`)
  const buf = await res.buffer()
  fs.writeFileSync(path, buf)
  return path
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
    if (m) return parseFloat(m[1]) > -38
  } catch {}
  return false
}

function normalizeSize(input, output) {
  execSync(
    `ffmpeg -y -i "${input}" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 "${output}"`
  )
}

function getVoiceDelay(sceneIndex, pacing = "normal") {
  if (sceneIndex === 0) return 0.5
  switch (pacing) {
    case "fast": return 0.5
    case "normal": return 1.0
    case "slow": return 1.5
    case "dramatic": return 2.5
    default: return 1.0
  }
}

// Lip sync scenes: every 5 scenes starting at scene 3 (index 2, 7, 12, 17...)
function isLipSyncScene(globalSceneIndex) {
  if (globalSceneIndex < 2) return false
  return (globalSceneIndex - 2) % 5 === 0
}

// Build a lip sync scene — with SFX from original video, slow zoom, no voice delay
function buildLipSyncScene(vidPath, voicePath, dur, i, sfxVideoPath = null) {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)

  // Trim video to exact audio duration
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${norm}" -t ${dur} -c:v copy -an "${trimmed}"`)

  // Add slow zoom in effect during build stage
  const zoomed = `/tmp/videos/zoomed_${i}.mp4`
  const totalFrames = Math.round(dur * 30)
  execSync(`ffmpeg -y -i "${trimmed}" -vf "zoompan=z='min(zoom+0.0006,1.03)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=30" -an -c:v libx264 -preset fast -crf 18 "${zoomed}"`)

  const out = `/tmp/final/scene_${i}.mp4`

  // Try to mix with SFX from Kling video
  if (sfxVideoPath && fs.existsSync(sfxVideoPath)) {
    const sfxAudio = `/tmp/videos/lipsync_sfx_${i}.aac`
    try {
      execSync(`ffmpeg -y -i "${sfxVideoPath}" -vn -c:a aac -ar 44100 "${sfxAudio}"`)
      if (fs.existsSync(sfxAudio)) {
        const sfxVol = 0.12
        execSync(
          `ffmpeg -y -i "${zoomed}" -i "${voicePath}" -i "${sfxAudio}" -filter_complex "[2:a]volume=${sfxVol},afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, dur - 1)}:d=1[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
        )
        return out
      }
    } catch (e) {
      console.log(`SFX mix failed (non-critical): ${e.message}`)
    }
  }

  // Check if original lip sync video has audio
  if (hasAudio(norm)) {
    const sfxAudio = `/tmp/videos/lipsync_orig_sfx_${i}.aac`
    try { execSync(`ffmpeg -y -i "${norm}" -vn -c:a aac -ar 44100 "${sfxAudio}"`) } catch {}
    if (fs.existsSync(sfxAudio)) {
      execSync(
        `ffmpeg -y -i "${zoomed}" -i "${voicePath}" -i "${sfxAudio}" -filter_complex "[2:a]volume=0.12,afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, dur - 1)}:d=1[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
      )
      return out
    }
  }

  // Fallback: voice only
  execSync(`ffmpeg -y -i "${zoomed}" -i "${voicePath}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
  return out
}

function buildScene(vidPath, voicePath, dur, i, pacing = "normal") {
  const norm = `/tmp/videos/norm_${i}.mp4`
  normalizeSize(vidPath, norm)

  const delay = getVoiceDelay(i, pacing)
  const totalAudioNeeded = dur + delay
  const videoDuration = getDuration(norm)

  let prepared = norm
  if (totalAudioNeeded > videoDuration) {
    const slowFactor = totalAudioNeeded / videoDuration
    console.log(`Scene ${i + 1}: slowing by ${slowFactor.toFixed(2)}x with minterpolate`)
    const slowed = `/tmp/videos/slowed_${i}.mp4`
    execSync(
      `ffmpeg -y -i "${norm}" -vf "setpts=${slowFactor}*PTS,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1" -an -c:v libx264 -preset fast -crf 18 "${slowed}"`,
      { timeout: 120000 }
    )
    prepared = slowed
  }

  const sceneDuration = Math.max(TARGET_SCENE_SECONDS, totalAudioNeeded)
  const trimmed = `/tmp/videos/trimmed_${i}.mp4`
  execSync(`ffmpeg -y -i "${prepared}" -t ${sceneDuration} -c:v copy -an "${trimmed}"`)

  const delayedVoice = `/tmp/voices/delayed_${i}.mp3`
  if (i === 0) {
    execSync(`ffmpeg -y -f lavfi -t ${delay} -i anullsrc=r=44100:cl=mono -i "${voicePath}" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a libmp3lame -ar 44100 "${delayedVoice}"`)
  } else {
    execSync(`ffmpeg -y -i "${voicePath}" -f lavfi -t ${delay} -i anullsrc=r=44100:cl=mono -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[aout]" -map "[aout]" -c:a libmp3lame -ar 44100 "${delayedVoice}"`)
  }

  const out = `/tmp/final/scene_${i}.mp4`
  if (hasAudio(norm)) {
    const klingAudio = `/tmp/videos/kling_audio_${i}.aac`
    try { execSync(`ffmpeg -y -i "${norm}" -vn -c:a aac -ar 44100 "${klingAudio}"`) } catch {}
    const sfxVol = detectVocalContent(norm) ? 0.10 : 0.15
    execSync(
      `ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -i "${klingAudio}" -filter_complex "[2:a]volume=${sfxVol},afade=t=in:st=0:d=1,afade=t=out:st=3:d=2[sfx];[1:a]volume=1.0[voice];[sfx][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`
    )
  } else {
    execSync(`ffmpeg -y -i "${trimmed}" -i "${delayedVoice}" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 18 -c:a aac -ar 44100 -ac 2 -shortest "${out}"`)
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

function concatChunks(paths) {
  if (paths.length === 1) return paths[0]
  const out = "/tmp/final/full_video_no_music.mp4"
  const listFile = "/tmp/final/chunk_list.txt"
  fs.writeFileSync(listFile, paths.map(p => `file '${p}'`).join("\n"))
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${out}"`)
  return out
}

function addMusicHD(vidPath, musicPath, dur) {
  const musicTrim = "/tmp/final/music_trim.mp3"
  // Trim music to video duration with fade out in last 5 seconds
  const fadeStart = Math.max(0, dur - 5)
  execSync(`ffmpeg -y -i "${musicPath}" -t ${dur} -af "volume=0.35,afade=t=out:st=${fadeStart}:d=5" "${musicTrim}"`)
  const out = "/tmp/final/final_video.mp4"
  // Simple ducking: music at 35% volume, voice at 100%, amix blends them
  // The music fade-out handles the ending, voice naturally dominates during speech
  execSync(
    `ffmpeg -y -i "${vidPath}" -i "${musicTrim}" -filter_complex "[0:a]volume=1.0[voice];[1:a]volume=1.0[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2:weights=1 0.4[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset slow -crf 18 -b:v 8M -maxrate 10M -bufsize 20M -c:a aac -b:a 192k -ar 44100 -movflags +faststart "${out}"`
  )
  return out
}


// ─────────────────────────────────────────
// PROCESS ONE CHUNK (images → approval → videos → approval → build)
// Returns a promise that resolves when chunk is fully approved
// ─────────────────────────────────────────
async function processChunk(chatId, chunkIndex, totalChunks, sceneObjs, style, visualSuggestion, globalSceneIndex, topic, rawScript) {
  if (isStopped(chatId)) throw new Error("Stopped by user")

  // sceneObjs = [{text, pacing}, ...]
  const sceneTexts = sceneObjs.map(s => typeof s === "string" ? s : s.text)
  const pacingTags = sceneObjs.map(s => typeof s === "string" ? "normal" : (s.pacing || "normal"))

  await bot.sendMessage(chatId, `📦 Chunk ${chunkIndex + 1}/${totalChunks} — ${sceneTexts.length} scenes`)

  // Build scene prompts with full context
  await bot.sendMessage(chatId, "🎬 Building scene prompts...")
  const scriptSummary = rawScript.slice(0, 800)
  const scenes = await buildScenePrompts(sceneTexts, style, visualSuggestion, globalSceneIndex, topic, scriptSummary)

  // Attach pacing to each scene
  scenes.forEach((s, i) => { s.pacing = pacingTags[i] })

  // Generate images + lip sync videos
  await bot.sendMessage(chatId, `🖼 Generating images...`)
  const images = []
  const voices = []
  const lipSyncFlags = []
  const lipSyncVideos = {} // pre-generated lip sync videos

  for (let i = 0; i < scenes.length; i++) {
    if (isStopped(chatId)) throw new Error("Stopped by user")
    const s = scenes[i]
    const absIdx = globalSceneIndex + i
    const isLipSync = isLipSyncScene(absIdx)
    lipSyncFlags.push(isLipSync)

    try {
      // Show the script text for this scene
      await bot.sendMessage(chatId, `📝 Scene ${i + 1} script:\n"${s.script}"`)

      if (isLipSync) {
        // PRESENTER SCENE — generate with Lauren voice, Flux face image, OmniHuman lip sync + Kling SFX
        const isStudio = isStudioScene()
        const sceneType = isStudio ? "studio" : "location"
        await bot.sendMessage(chatId, `🎤 Scene ${i + 1} — presenter (${sceneType}), generating...`)

        // Generate presenter voice (Lauren)
        const voicePath = await generatePresenterVoice(s.script, absIdx)
        const audioDuration = getDuration(voicePath)
        voices.push({ voicePath, audioDuration })

        // Generate presenter image (Flux with face reference)
        const presenterImgPath = await generatePresenterImage(s.script, topic, isStudio, chatId)
        await bot.sendDocument(chatId, presenterImgPath, { caption: `📸 Presenter image (${sceneType})` })

        // Generate Kling video for SFX audio (environment sounds)
        let sfxVideoPath = null
        try {
          await bot.sendMessage(chatId, `🔊 Generating environment SFX...`)
          const presenterImgUrl = await uploadToReplicate(presenterImgPath, "image/jpeg")
          const sfxRes = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v2.6/predictions", {
            method: "POST",
            headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              input: { start_image: presenterImgUrl, prompt: "subtle environment ambience, natural background sounds", duration: 5, aspect_ratio: "16:9", generate_audio: true }
            })
          })
          const sfxPred = await sfxRes.json()
          if (sfxPred.id) {
            const sfxResult = await withTimeout(pollReplicate(sfxPred.id, `SFX ${absIdx}`, chatId), `SFX ${absIdx}`)
            const sfxUrl = Array.isArray(sfxResult.output) ? sfxResult.output[0] : sfxResult.output
            sfxVideoPath = `/tmp/videos/presenter_sfx_${absIdx}.mp4`
            fs.writeFileSync(sfxVideoPath, await (await fetch(sfxUrl)).buffer())
          }
        } catch (e) {
          console.log(`Presenter SFX failed (non-critical): ${e.message}`)
        }

        // Generate lip sync (OmniHuman)
        const vidPath = await generateLipSync(presenterImgPath, voicePath, absIdx, chatId)
        lipSyncVideos[i] = { vidPath, sfxVideoPath }
        images.push(null)
        await bot.sendVideo(chatId, vidPath, { caption: `🎤 Presenter scene ${i + 1}` })
      } else {
        // NORMAL SCENE — Ellis voice, Flux image
        const voicePath = await generateVoice(s.script, absIdx)
        const audioDuration = getDuration(voicePath)
        voices.push({ voicePath, audioDuration })

        const img = await generateImage(s.imagePrompt, absIdx, chatId)
        images.push(img)
        await bot.sendMessage(chatId, `🖼 Full image prompt:\n\n${s.imagePrompt}${REALISM_STYLE_SUFFIX}`)
        await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${i + 1} of ${scenes.length}` })
      }
    } catch (err) {
      if (err.message === "Stopped by user") throw err
      console.error(`Scene ${i + 1} failed:`, err.message)
      await bot.sendMessage(chatId, `⚠️ Scene ${i + 1} failed: ${err.message}`)
      images.push(null)
      voices.push(null)
    }
  }

  // Wait for image approval
  userState[chatId] = { step: "waiting_chunk_image_approval", scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion }
  await bot.sendMessage(chatId, `🖼 All images for chunk ${chunkIndex + 1} generated.\n\n✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`)
}


// ─────────────────────────────────────────
// TRIGGER
// ─────────────────────────────────────────
bot.onText(/^do it$/i, msg => {
  stoppedChats.delete(msg.chat.id)
  resetPresenterState()
  userState[msg.chat.id] = { step: "waiting_input" }
  bot.sendMessage(msg.chat.id, `Send a theme, article link, or paste any text.\n\n💡 Send "stop" anytime to halt.`)
})


// ─────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────
bot.on("message", async msg => {
  const chatId = msg.chat.id
  const text = (msg.text || "").trim()
  if (/^do it$/i.test(text) || /^stop$/i.test(text)) return

  const state = userState[chatId]
  if (!state) return

  // ── User sends topic ──
  if (state.step === "waiting_input") {
    userState[chatId] = { step: "generating_script" }
    try {
      await bot.sendMessage(chatId, `✍️ Writing ${TARGET_VIDEO_MINUTES}-minute script...`)
      const rawScript = await generateFullScript(text)
      const wordCount = countWords(rawScript)
      const topic = text.startsWith("http") ? text.split("/").pop().replace(/_/g, " ") : text.slice(0, 60)

      userState[chatId] = { step: "waiting_script_approval", input: text, topic, rawScript }
      await sendLongMessage(chatId, `📄 Script (${wordCount} words, ~${Math.round(wordCount / 2.5 / 60)} min):\n\n${rawScript}`)
      await bot.sendMessage(chatId, `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send feedback like "make the opening more dramatic"`)
    } catch (err) {
      console.error("Script failed:", err)
      await bot.sendMessage(chatId, `❌ Script failed: ${err.message}\n\nSend 'do it' to try again.`)
      userState[chatId] = {}
    }
    return
  }

  // ── Script approval ──
  if (state.step === "waiting_script_approval") {
    if (/^ok$/i.test(text)) {
      userState[chatId] = { ...state, step: "waiting_visual_suggestion" }
      await bot.sendMessage(chatId, `🎨 Any suggestions for the image prompts?\n\nDescribe visual details like clothing style, environment, era, colors, etc.\n\nOr send "none" to skip.`)
      return
    }

    if (/^redo$/i.test(text)) {
      // Plain redo — regenerate from scratch
      try {
        await bot.sendMessage(chatId, `✍️ Rewriting script...`)
        const rawScript = await generateFullScript(state.input)
        const wordCount = countWords(rawScript)
        userState[chatId] = { ...state, rawScript }
        await sendLongMessage(chatId, `📄 Script (${wordCount} words, ~${Math.round(wordCount / 2.5 / 60)} min):\n\n${rawScript}`)
        await bot.sendMessage(chatId, `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send feedback like "make the opening more dramatic"`)
      } catch (err) {
        await bot.sendMessage(chatId, `❌ Script failed: ${err.message}`)
      }
      return
    }

    // Any other text = feedback to modify the script
    try {
      await bot.sendMessage(chatId, `✍️ Rewriting script with your feedback...`)
      const rawScript = await callClaude(
        `You are rewriting a YouTube narration script based on user feedback.
Rewrite the ENTIRE script (1500-1650 words) incorporating the user's feedback. Keep the same topic and overall story but apply the requested changes.
Write ONLY the narration text. End with: Thanks for watching.`,
        `Original script:\n\n${state.rawScript}\n\nUser feedback: ${text}`,
        8000
      )
      let cleaned = rawScript.trim()
      cleaned = cleaned.replace(/^(Here's|Here is|Below is|The following)[\s\S]*?:\s*\n/i, "").trim()
      const wordCount = countWords(cleaned)
      userState[chatId] = { ...state, rawScript: cleaned }
      await sendLongMessage(chatId, `📄 Script (${wordCount} words, ~${Math.round(wordCount / 2.5 / 60)} min):\n\n${cleaned}`)
      await bot.sendMessage(chatId, `✅ Send "ok" to continue\n🔄 "redo" for a new script\n💬 Or send more feedback`)
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Rewrite failed: ${err.message}`)
    }
    return
  }

  // ── Visual suggestions ──
  if (state.step === "waiting_visual_suggestion") {
    const visualSuggestion = /^none$/i.test(text) ? "" : text
    const { topic, rawScript } = state

    try {
      // Visual style (once for whole video)
      await bot.sendMessage(chatId, "🎨 Defining visual style...")
      const style = await generateVisualStyle(topic, rawScript)
      await bot.sendMessage(chatId, `🎨 ${style.styleTag} | ${style.mood}`)

      // Generate thumbnail
      await bot.sendMessage(chatId, "🖼 Generating thumbnail...")
      const thumb = await generateThumbnail(topic, rawScript, style, chatId)

      userState[chatId] = { step: "waiting_thumbnail_approval", topic, rawScript, style, visualSuggestion, thumb }
      await bot.sendDocument(chatId, thumb.path, { caption: "🎨 Thumbnail preview" })
      await bot.sendMessage(chatId, `✅ Send "yes" to approve thumbnail\n🔄 Describe changes you want (e.g. "make it darker" or "add more fire")`)
    } catch (err) {
      console.error("Style/thumbnail failed:", err)
      await bot.sendMessage(chatId, `❌ Failed: ${err.message}\n\nSend 'do it' to try again.`)
      userState[chatId] = {}
    }
    return
  }

  // ── Thumbnail approval ──
  if (state.step === "waiting_thumbnail_approval") {
    if (/^yes$/i.test(text)) {
      // Split script into chunks and start processing
      const { topic, rawScript, style, visualSuggestion } = state
      const chunks = splitScriptIntoChunks(rawScript)

      await bot.sendMessage(chatId, `📦 Script split into ${chunks.length} chunks (~1 min each)\n\nStarting chunk 1...`)

      userState[chatId] = { step: "processing_chunks", topic, rawScript, style, visualSuggestion, chunks, chunkPaths: [], currentChunk: 0, globalSceneIndex: 0, totalDuration: 0 }

      try {
        await processChunk(chatId, 0, chunks.length, await splitChunkIntoScenes(chunks[0]), style, visualSuggestion, 0, topic, rawScript)
      } catch (err) {
        if (err.message === "Stopped by user") return
        console.error("Chunk processing failed:", err)
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}\n\nSend 'do it' to try again.`)
        userState[chatId] = {}
      }
      return
    }

    // User wants changes to thumbnail
    try {
      await bot.sendMessage(chatId, "🖼 Regenerating thumbnail with your feedback...")
      const thumbPrompt = await callClaude(
        `Modify this thumbnail concept based on user feedback. Write a new 100-word image prompt.
User feedback: ${text}
Keep it dramatic and eye-catching for YouTube.`,
        `Original topic: ${state.topic}`,
        400
      )
      const thumb = await generateImage(thumbPrompt.trim(), 999, chatId)
      userState[chatId] = { ...state, thumb }
      await bot.sendDocument(chatId, thumb.path, { caption: "🎨 Updated thumbnail" })
      await bot.sendMessage(chatId, `✅ Send "yes" to approve or describe more changes`)
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Thumbnail redo failed: ${err.message}\nTry again or send "yes" to continue`)
    }
    return
  }

  // ── Chunk image approval ──
  if (state.step === "waiting_chunk_image_approval") {
    const { scenes, images, voices, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion } = state

    if (/^yes$/i.test(text)) {
      // Generate videos for this chunk (lip sync already done)
      try {
        await bot.sendMessage(chatId, `🎥 Generating videos for chunk ${chunkIndex + 1}...`)
        const videos = []

        for (let i = 0; i < scenes.length; i++) {
          if (isStopped(chatId)) { userState[chatId] = {}; return }
          const absIdx = globalSceneIndex + i

          if (lipSyncFlags[i]) {
            // LIP SYNC — already generated, just use it
            if (lipSyncVideos && lipSyncVideos[i]) {
              const lsData = lipSyncVideos[i]
              videos.push(typeof lsData === "string" ? lsData : lsData.vidPath)
              await bot.sendMessage(chatId, `🎤 Video ${i + 1}/${scenes.length} — presenter (already generated)`)
            } else {
              videos.push(null)
            }
          } else {
            // NORMAL SCENE — use Kling
            if (!images[i]) { videos.push(null); continue }
            try {
              await bot.sendMessage(chatId, `🎥 Video ${i + 1}/${scenes.length} — ${scenes[i].cameraName}...`)
              const vidPath = await generateVideo(images[i].url, images[i].path, scenes[i].motion, scenes[i].imagePrompt, absIdx, chatId)
              videos.push(vidPath)
              await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} of ${scenes.length}` })
            } catch (err) {
              if (err.message === "Stopped by user") { userState[chatId] = {}; return }
              await bot.sendMessage(chatId, `⚠️ Video ${i + 1} failed: ${err.message}`)
              videos.push(null)
            }
          }
        }

        userState[chatId] = { ...userState[chatId], step: "waiting_chunk_video_approval", videos }
        await bot.sendMessage(chatId, `🎬 All videos for chunk ${chunkIndex + 1} generated.\n\n✅ Send "yes" to approve\n🔄 Send "redo 2" or "redo 1,3" to regenerate`)
      } catch (err) {
        if (err.message === "Stopped by user") return
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    // Redo images — with optional feedback like "redo 2, make it more dramatic"
    const redoMatch = text.match(/^redo\s+([\d,\s]+)(.*)/i)
    if (redoMatch) {
      const indices = redoMatch[1].split(/[,\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < scenes.length)
      const feedback = redoMatch[2] ? redoMatch[2].replace(/^[,\s]+/, "").trim() : ""
      try {
        for (const i of indices) {
          const absIdx = globalSceneIndex + i
          let newPrompt = scenes[i].imagePrompt
          if (feedback) {
            // Ask Claude to modify the prompt based on feedback
            newPrompt = await callClaude(
              `Modify this image prompt based on user feedback. Keep it SHORT (20-30 words max). Write ONLY the new prompt.
User feedback: ${feedback}`,
              `Original prompt: ${scenes[i].imagePrompt}`,
              100
            )
            newPrompt = newPrompt.trim().replace(/^["']|["']$/g, "")
            scenes[i].imagePrompt = newPrompt
            await bot.sendMessage(chatId, `🖼 Updated prompt: ${newPrompt}`)
          }
          await bot.sendMessage(chatId, `🔄 Regenerating image ${i + 1}...`)
          const img = await generateImage(newPrompt, absIdx, chatId)
          images[i] = img
          await bot.sendDocument(chatId, img.path, { caption: `📸 Image ${i + 1} (redone)` })
        }
        userState[chatId] = { ...state, images, scenes }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve or "redo 2" to redo again`)
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}`)
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve or "redo 2" / "redo 1,3" to regenerate.`)
    return
  }

  // ── Chunk video approval ──
  if (state.step === "waiting_chunk_video_approval") {
    const { scenes, images, voices, videos, lipSyncFlags, lipSyncVideos, globalSceneIndex, chunkIndex, totalChunks, style, visualSuggestion } = state

    if (/^yes$/i.test(text)) {
      try {
        // Build this chunk
        await bot.sendMessage(chatId, `✂️ Building chunk ${chunkIndex + 1}...`)
        const scenePaths = []
        let chunkDuration = 0

        const validIndices = videos.map((v, i) => v && voices[i] ? i : -1).filter(i => i >= 0)
        for (const i of validIndices) {
          const absIdx = globalSceneIndex + i
          const { voicePath, audioDuration } = voices[i]

          if (lipSyncFlags && lipSyncFlags[i]) {
            // Lip sync scene — with SFX from Kling
            chunkDuration += audioDuration
            const sfxPath = lipSyncVideos && lipSyncVideos[i] && typeof lipSyncVideos[i] === "object" ? lipSyncVideos[i].sfxVideoPath : null
            scenePaths.push(buildLipSyncScene(videos[i], voicePath, audioDuration, absIdx, sfxPath))
          } else {
            // Normal scene — with pacing-based delay and SFX
            const pacing = scenes[i]?.pacing || "normal"
            const sceneDur = Math.max(TARGET_SCENE_SECONDS, audioDuration + getVoiceDelay(absIdx, pacing))
            chunkDuration += sceneDur
            scenePaths.push(buildScene(videos[i], voicePath, audioDuration, absIdx, pacing))
          }
        }

        const chunkVideo = concatScenes(scenePaths)
        const chunkPath = `/tmp/chunks/chunk_${chunkIndex}.mp4`
        fs.copyFileSync(chunkVideo, chunkPath)

        // Show chunk for approval
        await bot.sendVideo(chatId, chunkPath, { caption: `📦 Chunk ${chunkIndex + 1}/${totalChunks} (${chunkDuration.toFixed(1)}s)` })

        // Get parent state
        const parent = userState[chatId]
        const parentChunkPaths = parent.chunkPaths || []
        parentChunkPaths.push(chunkPath)
        const parentTotalDuration = (parent.totalDuration || 0) + chunkDuration

        userState[chatId] = {
          step: "waiting_chunk_approval",
          ...parent,
          chunkPaths: parentChunkPaths,
          totalDuration: parentTotalDuration,
          currentChunkDuration: chunkDuration
        }
        await bot.sendMessage(chatId, `📦 Chunk ${chunkIndex + 1} built (${chunkDuration.toFixed(1)}s)\nTotal so far: ${parentTotalDuration.toFixed(1)}s\n\n✅ Send "yes" to approve and continue to next chunk`)
      } catch (err) {
        console.error("Build chunk failed:", err)
        await bot.sendMessage(chatId, `❌ Build failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    // Redo videos — with optional feedback like "redo 2, the camera should orbit around the tree"
    const redoMatch = text.match(/^redo\s+([\d,\s]+)(.*)/i)
    if (redoMatch) {
      const indices = redoMatch[1].split(/[,\s]+/).map(n => parseInt(n) - 1).filter(n => n >= 0 && n < scenes.length)
      const feedback = redoMatch[2] ? redoMatch[2].replace(/^[,\s]+/, "").trim() : ""
      try {
        for (const i of indices) {
          const absIdx = globalSceneIndex + i
          if (lipSyncFlags && lipSyncFlags[i]) {
            await bot.sendMessage(chatId, `🔄 Regenerating presenter scene ${i + 1}...`)
            const isStudio = (presenterAppearanceCount - 1) % 4 === 3 // check if last was studio
            const presenterImgPath = await generatePresenterImage(scenes[i].script, state.topic || "", isStudio, chatId)
            const vidPath = await generateLipSync(presenterImgPath, voices[i].voicePath, absIdx, chatId)
            videos[i] = vidPath
            await bot.sendVideo(chatId, vidPath, { caption: `🎤 Presenter ${i + 1} (redone)` })
          } else {
            if (!images[i]) continue
            let motionPrompt = scenes[i].motion
            if (feedback) {
              motionPrompt = feedback
              await bot.sendMessage(chatId, `🎥 Using custom motion: ${feedback}`)
            }
            await bot.sendMessage(chatId, `🔄 Regenerating video ${i + 1}...`)
            const vidPath = await generateVideo(images[i].url, images[i].path, motionPrompt, scenes[i].imagePrompt, absIdx, chatId)
            videos[i] = vidPath
            await bot.sendVideo(chatId, vidPath, { caption: `🎬 Video ${i + 1} (redone)` })
          }
        }
        userState[chatId] = { ...state, videos }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve or "redo 2" to redo again`)
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Redo failed: ${err.message}`)
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve or "redo 2" / "redo 1,3" to regenerate.`)
    return
  }

  // ── Chunk built — approval to continue ──
  if (state.step === "waiting_chunk_approval") {
    if (/^yes$/i.test(text)) {
      const { chunks, chunkPaths, currentChunk, globalSceneIndex, style, visualSuggestion, totalDuration, topic, rawScript } = state
      const nextChunk = (currentChunk || 0) + 1
      const scenesInLastChunk = (await splitChunkIntoScenes(chunks[currentChunk || 0])).length
      const nextGlobalIndex = globalSceneIndex + scenesInLastChunk

      if (nextChunk >= chunks.length) {
        // ALL CHUNKS DONE — ask for music choice
        const fullVideo = concatChunks(chunkPaths)

        userState[chatId] = { step: "waiting_music_choice", topic, rawScript, fullVideo, totalDuration, chunkPaths }
        await bot.sendMessage(chatId, `🎬 All ${chunks.length} chunks complete! Total: ${totalDuration.toFixed(1)}s\n\n🎵 Which music?\n\n1. Hopeful\n2. Suspense\n3. Space\n\nSend 1, 2, or 3`)
        return
      }

      // Process next chunk
      try {
        await bot.sendMessage(chatId, `\n📦 Starting chunk ${nextChunk + 1}/${chunks.length}...`)
        userState[chatId] = { ...state, currentChunk: nextChunk, globalSceneIndex: nextGlobalIndex }

        await processChunk(chatId, nextChunk, chunks.length, await splitChunkIntoScenes(chunks[nextChunk]), style, visualSuggestion, nextGlobalIndex, topic, rawScript)
      } catch (err) {
        if (err.message === "Stopped by user") return
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}`)
        userState[chatId] = {}
      }
      return
    }

    await bot.sendMessage(chatId, `Send "yes" to approve chunk and continue.`)
    return
  }

  // ── Music choice ──
  if (state.step === "waiting_music_choice") {
    const choice = parseInt(text)
    if (choice >= 1 && choice <= 3) {
      const { topic, rawScript, fullVideo, totalDuration } = state
      try {
        const musicName = MUSIC_OPTIONS[choice - 1].name
        await bot.sendMessage(chatId, `🎵 Adding ${musicName} music with ducking...`)
        const musicPath = await downloadMusicByChoice(choice)
        const finalVideo = addMusicHD(fullVideo, musicPath, totalDuration)

        await bot.sendVideo(chatId, finalVideo, {
          width: 1280, height: 720,
          caption: `🎬 Final video (${totalDuration.toFixed(1)}s) | 🎵 ${musicName}\n🎤 Voice 100% | 🔊 SFX 15% | 🎵 Music (ducked)`
        })
        await bot.sendDocument(chatId, finalVideo, { caption: `📁 HD file (YouTube-ready)` })

        userState[chatId] = { step: "waiting_youtube_meta", topic, rawScript }
        await bot.sendMessage(chatId, `✅ Video complete!\n\n📝 Want me to generate YouTube title, description, and tags?\n\nSend "yes" or "no"`)
      } catch (err) {
        console.error("Music/assembly failed:", err)
        await bot.sendMessage(chatId, `❌ Failed: ${err.message}\n\nTry again: send 1, 2, or 3`)
      }
      return
    }
    await bot.sendMessage(chatId, `🎵 Which music?\n\n1. Hopeful\n2. Suspense\n3. Space\n\nSend 1, 2, or 3`)
    return
  }

  // ── YouTube metadata ──
  if (state.step === "waiting_youtube_meta") {
    if (/^yes$/i.test(text)) {
      try {
        await bot.sendMessage(chatId, "📝 Generating YouTube metadata...")
        const meta = await callClaude(
          `Generate YouTube metadata for this video. Return ONLY valid JSON:
{
  "title": "catchy YouTube title under 70 characters — mysterious, intriguing, makes people click",
  "description": "YouTube description 150-300 words: hook in first 2 lines, summary of what the video covers, call to action to subscribe and like, relevant hashtags at the end",
  "tags": "comma-separated list of 15-20 relevant YouTube tags for SEO"
}`,
          `Topic: ${state.topic}\nScript: ${state.rawScript.slice(0, 1500)}`,
          1000
        )
        const parsed = safeJSON(meta)
        await bot.sendMessage(chatId, `📝 **Title:**\n${parsed.title}\n\n📝 **Description:**\n${parsed.description}\n\n🏷 **Tags:**\n${parsed.tags}`)

        userState[chatId] = { step: "waiting_meta_approval", ...state, meta: parsed }
        await bot.sendMessage(chatId, `✅ Send "yes" to approve or describe changes`)
      } catch (err) {
        await bot.sendMessage(chatId, `⚠️ Metadata generation failed: ${err.message}\nSend "yes" to retry or "no" to skip`)
      }
      return
    }

    if (/^no$/i.test(text)) {
      await bot.sendMessage(chatId, "✅ All done! Send 'do it' for another video.")
      userState[chatId] = {}
      return
    }
    return
  }

  // ── Meta approval ──
  if (state.step === "waiting_meta_approval") {
    if (/^yes$/i.test(text)) {
      await bot.sendMessage(chatId, "✅ All done! Metadata approved. Send 'do it' for another video.")
      userState[chatId] = {}
      return
    }

    // User wants changes
    try {
      const meta = await callClaude(
        `Modify this YouTube metadata based on user feedback. Return ONLY valid JSON with title, description, tags.
User feedback: ${text}`,
        `Original topic: ${state.topic}\nCurrent metadata: ${JSON.stringify(state.meta)}`,
        1000
      )
      const parsed = safeJSON(meta)
      await bot.sendMessage(chatId, `📝 **Title:**\n${parsed.title}\n\n📝 **Description:**\n${parsed.description}\n\n🏷 **Tags:**\n${parsed.tags}`)
      userState[chatId] = { ...state, meta: parsed }
      await bot.sendMessage(chatId, `✅ Send "yes" to approve or describe more changes`)
    } catch (err) {
      await bot.sendMessage(chatId, `⚠️ Failed: ${err.message}`)
    }
    return
  }
})
