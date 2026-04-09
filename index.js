import TelegramBot from "node-telegram-bot-api"
import fs from "fs"
import fetch from "node-fetch"

// ----------------------------------------
// START THE BOT
// ----------------------------------------
console.log("Starting bot...")

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message)
})

console.log("Bot is running. Waiting for messages...")

// ----------------------------------------
// HELPER
// ----------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let userState = {}

// ----------------------------------------
// STEP 1 — Generate script from input
// ----------------------------------------
function generateScript(input) {
  return (
    `This video explores ${input}. ` +
    `Scientists believe something unusual was discovered underground. ` +
    `Thanks for watching`
  )
}

// ----------------------------------------
// STEP 2 — Split script into scenes
// Each scene gets its own piece of the script
// ----------------------------------------
function splitScenes(script) {
  const half = Math.floor(script.length / 2)

  return [
    {
      script: script.slice(0, half),
      imagePrompt: "cinematic underground tunnel, dramatic lighting, realistic",
      motion: "slow zoom in"
    },
    {
      script: script.slice(half),
      imagePrompt: "hidden chamber, ancient structure, atmospheric lighting",
      motion: "slow pan right"
    }
  ]
}

// ----------------------------------------
// STEP 3 — Generate image for a scene
// Uses a real image from picsum (fake but real file)
// ----------------------------------------
async function generateImage(scene, index) {
  await sleep(2000)
  const url = `https://picsum.photos/seed/${index + Date.now()}/1280/720`
  const res = await fetch(url)
  const buffer = await res.buffer()
  const file = `/tmp/img_${index}.jpg`
  fs.writeFileSync(file, buffer)
  return file
}

// ----------------------------------------
// STEP 4 — Generate fake video for a scene
// ----------------------------------------
async function generateVideo(index) {
  await sleep(2000)
  const file = `/tmp/video_${index}.mp4`
  fs.writeFileSync(file, Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70
  ]))
  return file
}

// ----------------------------------------
// STEP 5 — Generate fake audio for a scene
// ----------------------------------------
async function generateAudio(index) {
  await sleep(1500)
  const file = `/tmp/audio_${index}.mp3`
  fs.writeFileSync(file, Buffer.from("fake audio"))
  return file
}

// ----------------------------------------
// STEP 6 — Generate fake background music
// ----------------------------------------
async function generateMusic() {
  await sleep(1500)
  const file = `/tmp/music.mp3`
  fs.writeFileSync(file, Buffer.from("fake music"))
  return file
}

// ----------------------------------------
// TRIGGER — User sends "do it"
// ----------------------------------------
bot.onText(/^do it$/i, (msg) => {
  const chatId = msg.chat.id
  userState[chatId] = { step: "waiting_input" }
  bot.sendMessage(chatId, "Send me a theme, link, or topic to create the video about.")
})

// ----------------------------------------
// MAIN FLOW — User sends their topic
// ----------------------------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id

  // Ignore if user is not in the right state
  if (!userState[chatId] || userState[chatId].step !== "waiting_input") return

  // Ignore the trigger message itself
  if (/^do it$/i.test(msg.text)) return

  const input = msg.text
  userState[chatId].step = "processing"

  try {

    // --- SCRIPT ---
    await bot.sendMessage(chatId, "✍️ Creating script...")
    await sleep(1500)
    const script = generateScript(input)
    await bot.sendMessage(chatId, `📄 Script:\n\n${script}`)

    // --- SCENES ---
    await bot.sendMessage(chatId, "🎬 Splitting into scenes...")
    await sleep(1000)
    const scenes = splitScenes(script)

    let sceneText = ""
    scenes.forEach((s, i) => {
      sceneText += `Scene ${i + 1}\n`
      sceneText += `Script: ${s.script}\n`
      sceneText += `Image prompt: ${s.imagePrompt}\n`
      sceneText += `Motion: ${s.motion}\n\n`
    })
    await bot.sendMessage(chatId, sceneText)

    // --- IMAGES ---
    await bot.sendMessage(chatId, "🖼 Creating images...")
    for (let i = 0; i < scenes.length; i++) {
      const img = await generateImage(scenes[i], i)
      await bot.sendPhoto(chatId, img, { caption: `Image ${i + 1} — ${scenes[i].imagePrompt}` })
    }

    // --- VIDEOS ---
    await bot.sendMessage(chatId, "🎥 Creating videos...")
    for (let i = 0; i < scenes.length; i++) {
      const vid = await generateVideo(i)
      await bot.sendDocument(chatId, vid, { caption: `Video ${i + 1}` })
    }

    // --- VOICE ---
    await bot.sendMessage(chatId, "🎙 Creating voice...")
    for (let i = 0; i < scenes.length; i++) {
      const audio = await generateAudio(i)
      await bot.sendAudio(chatId, audio, { caption: `Voice ${i + 1}` })
    }

    // --- MUSIC ---
    await bot.sendMessage(chatId, "🎵 Creating background music...")
    const music = await generateMusic()
    await bot.sendAudio(chatId, music, { caption: "Background music" })

    // --- DONE ---
    await bot.sendMessage(chatId, "✅ Flow complete! All pieces generated in correct order.\n\nReady for real AI in Phase 2.")

    userState[chatId].step = "done"

  } catch (err) {
    console.error("Pipeline error:", err)
    await bot.sendMessage(chatId, "❌ Something went wrong. Try sending 'do it' again.")
    userState[chatId] = {}
  }
})