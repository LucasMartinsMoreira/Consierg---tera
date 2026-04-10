/**
 * Mostra URL do webhook e ultimo erro do Telegram (ex.: 530 = tunel Cloudflare parado).
 * Uso: npm run webhook:info
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") })

const token = process.env.TELEGRAM_TOKEN
if (!token) {
 console.error("Defina TELEGRAM_TOKEN no .env")
 process.exit(1)
}

fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
 .then((r) => r.json())
 .then((j) => {
  console.log(JSON.stringify(j, null, 2))
  const r = j.result || {}
  if (r.last_error_message)
   console.error("\n>>> Se aparecer 530: suba o tunel (cloudflared) e rode set-telegram-webhook com a URL nova.")
 })
 .catch((e) => {
  console.error(e)
  process.exit(1)
 })
