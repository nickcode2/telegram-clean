const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log("Bot started");

bot.on('message', (msg) => {
  if (msg.text === "do it") {
    bot.sendMessage(msg.chat.id, "What theme?");
  }
});