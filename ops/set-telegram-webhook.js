/**
 * Uso: node ops/set-telegram-webhook.js https://SEU_TUNEL.trycloudflare.com
 * Precisa de TELEGRAM_TOKEN no .env (e TELEGRAM_WEBHOOK_SECRET se usar secret no servidor).
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") })

const base = (process.argv[2] || "").replace(/\/$/, "")
if (!base || !base.startsWith("https://")) {
 console.error('Passe a URL publica do tunel (sem barra final), ex: node ops/set-telegram-webhook.js https://xxx.trycloudflare.com')
 process.exit(1)
}

const token = process.env.TELEGRAM_TOKEN
if (!token) {
 console.error("Defina TELEGRAM_TOKEN no .env")
 process.exit(1)
}

const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim()
const url = `${base}/webhook`
const body = { url, allowed_updates: ["message", "edited_message"] }
if (secret.length) body.secret_token = secret

fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify(body)
})
 .then((r) => r.json())
 .then((j) => {
  console.log(JSON.stringify(j, null, 2))
  if (!j.ok) process.exit(1)
  console.log("\nWebhook:", url)
 })
 .catch((e) => {
  console.error(e)
  process.exit(1)
 })
