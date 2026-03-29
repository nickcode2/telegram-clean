const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN);

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.on("message", (msg) => {
  if (msg.text === "do it") {
    bot.sendMessage(msg.chat.id, "What theme?");
  } else {
    bot.sendMessage(msg.chat.id, "Ok, working on it...");
  }
});

app.listen(3000, () => {
  console.log("Server running");
});