/**
 * Limpa dados de conversa / histórico no SQLite.
 * Uso:
 *   node ops/reset-sessions.js                  — só sessions
 *   node ops/reset-sessions.js --price-history — sessions + price_history
 *   node ops/reset-sessions.js --full           — sessions + price_history + processed_updates (zero geral)
 */
const path = require("path")
const Database = require("better-sqlite3")

const dbPath = path.join(__dirname, "..", "concierge.db")
const withPriceHistory = process.argv.includes("--price-history")
const fullReset = process.argv.includes("--full")

const db = new Database(dbPath)

try {
 db.exec("DELETE FROM sessions;")
 console.log("OK: tabela sessions limpa.")
 if (withPriceHistory || fullReset) {
  db.exec("DELETE FROM price_history;")
  console.log("OK: tabela price_history limpa.")
 }
 if (fullReset) {
  db.exec("DELETE FROM processed_updates;")
  console.log("OK: tabela processed_updates limpa (cache de updates do Telegram).")
 }
} finally {
 db.close()
}
