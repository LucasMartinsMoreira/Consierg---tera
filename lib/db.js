/**
 * Camada de banco de dados com detecção automática:
 *   - DATABASE_URL definida → Neon PostgreSQL (Vercel / produção)
 *   - VERCEL=1 sem DATABASE_URL → memória RAM (volátil, cold start zera)
 *   - Sem DATABASE_URL     → SQLite local (dev)
 */
const { randomUUID } = require("crypto")

const USE_NEON = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL)
const USE_MEMORY = !USE_NEON && process.env.VERCEL === "1"

// ─── Helpers base ───

function newSession(chatId) {
 return {
  chat_id: String(chatId),
  conversation_id: randomUUID(),
  context: "",
  intent_status: "diagnosis",
  turn_count: 0,
  qualifiers_json: "{}",
  qualifier_step: 0,
  operation_mode: "recommend",
  monitor_target_brl: null,
  monitor_alert_sent_on: null,
  resume_checkpoint_json: ""
 }
}

// ─── Drivers (carregados sob demanda) ───

let sql   // neon tagged-template
let lite  // better-sqlite3 instance + prepared statements

// ─── Memória (fallback Vercel sem DATABASE_URL) ───

const memSessions = new Map()
const memProcessed = new Set()

function memGetSession(chatId) {
 const key = String(chatId)
 if (memSessions.has(key)) return { ...memSessions.get(key) }
 const s = newSession(chatId)
 memSessions.set(key, { ...s })
 return s
}

function memSaveSession(session) {
 memSessions.set(String(session.chat_id), { ...session })
}

function memMarkProcessed(updateId) {
 if (memProcessed.has(updateId)) return true
 memProcessed.add(updateId)
 return false
}

function getNeon() {
 if (!sql) {
  const { neon } = require("@neondatabase/serverless")
  sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL)
 }
 return sql
}

function getLite() {
 if (!lite) {
  const Database = require("better-sqlite3")
  const path = require("path")
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "concierge.db")
  const db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")

  db.exec(`
   CREATE TABLE IF NOT EXISTS sessions (
    chat_id               TEXT    PRIMARY KEY,
    conversation_id       TEXT    NOT NULL DEFAULT '',
    context               TEXT    NOT NULL DEFAULT '',
    intent_status         TEXT    NOT NULL DEFAULT 'diagnosis',
    turn_count            INTEGER NOT NULL DEFAULT 0,
    qualifiers_json       TEXT    NOT NULL DEFAULT '{}',
    qualifier_step        INTEGER NOT NULL DEFAULT 0,
    operation_mode        TEXT    NOT NULL DEFAULT 'recommend',
    monitor_target_brl    REAL,
    monitor_alert_sent_on TEXT,
    resume_checkpoint_json TEXT   NOT NULL DEFAULT '',
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
   )
  `)
  db.exec(`
   CREATE TABLE IF NOT EXISTS price_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id        TEXT    NOT NULL,
    query          TEXT    NOT NULL,
    model          TEXT    NOT NULL,
    price          TEXT,
    price_numeric  REAL,
    store          TEXT,
    product_url    TEXT,
    rank_score     REAL,
    rank_reason    TEXT,
    source_engine  TEXT    NOT NULL DEFAULT 'serpapi_google_shopping',
    captured_at    TEXT    NOT NULL DEFAULT (datetime('now'))
   )
  `)
  db.exec(`
   CREATE TABLE IF NOT EXISTS processed_updates (
    update_id   INTEGER PRIMARY KEY,
    received_at TEXT    NOT NULL DEFAULT (datetime('now'))
   )
  `)

  lite = {
   getSession: db.prepare(`SELECT chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json FROM sessions WHERE chat_id = ?`),
   insertSession: db.prepare(`INSERT OR IGNORE INTO sessions (chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`),
   saveSession: db.prepare(`INSERT INTO sessions (chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET conversation_id = CASE WHEN excluded.conversation_id = '' THEN sessions.conversation_id ELSE excluded.conversation_id END, context = excluded.context, intent_status = excluded.intent_status, turn_count = excluded.turn_count, qualifiers_json = excluded.qualifiers_json, qualifier_step = excluded.qualifier_step, operation_mode = excluded.operation_mode, monitor_target_brl = excluded.monitor_target_brl, monitor_alert_sent_on = excluded.monitor_alert_sent_on, resume_checkpoint_json = excluded.resume_checkpoint_json, updated_at = datetime('now')`),
   insertUpdate: db.prepare(`INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)`),
   insertPrice: db.prepare(`INSERT INTO price_history (chat_id, query, model, price, price_numeric, store, product_url, rank_score, rank_reason, source_engine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'serpapi_google_shopping')`),
   updateConvId: db.prepare(`UPDATE sessions SET conversation_id = ? WHERE chat_id = ?`),
   allSessions: db.prepare(`SELECT chat_id, context, qualifiers_json FROM sessions WHERE context <> ''`),
   monitorSessions: db.prepare(`SELECT chat_id, context, monitor_target_brl, qualifiers_json FROM sessions WHERE operation_mode = 'monitor' AND monitor_target_brl IS NOT NULL AND monitor_target_brl > 0 AND (monitor_alert_sent_on IS NULL OR monitor_alert_sent_on <> ?)`),
   updateAlert: db.prepare(`UPDATE sessions SET monitor_alert_sent_on = ? WHERE chat_id = ?`)
  }
 }
 return lite
}

// ─── Neon: init lazy ───

let neonInitialized = false
async function initNeon() {
 if (neonInitialized) return
 const s = getNeon()
 await s`CREATE TABLE IF NOT EXISTS sessions (
  chat_id               TEXT    PRIMARY KEY,
  conversation_id       TEXT    NOT NULL DEFAULT '',
  context               TEXT    NOT NULL DEFAULT '',
  intent_status         TEXT    NOT NULL DEFAULT 'diagnosis',
  turn_count            INTEGER NOT NULL DEFAULT 0,
  qualifiers_json       TEXT    NOT NULL DEFAULT '{}',
  qualifier_step        INTEGER NOT NULL DEFAULT 0,
  operation_mode        TEXT    NOT NULL DEFAULT 'recommend',
  monitor_target_brl    REAL,
  monitor_alert_sent_on TEXT,
  resume_checkpoint_json TEXT   NOT NULL DEFAULT '',
  updated_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
 )`
 await s`CREATE TABLE IF NOT EXISTS price_history (
  id             SERIAL  PRIMARY KEY,
  chat_id        TEXT    NOT NULL,
  query          TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  price          TEXT,
  price_numeric  REAL,
  store          TEXT,
  product_url    TEXT,
  rank_score     REAL,
  rank_reason    TEXT,
  source_engine  TEXT    NOT NULL DEFAULT 'serpapi_google_shopping',
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
 )`
 await s`CREATE TABLE IF NOT EXISTS processed_updates (
  update_id   BIGINT  PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
 )`
 neonInitialized = true
}

// ─── Normalização de row ───

function normalizeRow(row) {
 if (!row) return null
 row.operation_mode = row.operation_mode || "recommend"
 row.monitor_target_brl = row.monitor_target_brl == null ? null : Number(row.monitor_target_brl)
 row.monitor_alert_sent_on = row.monitor_alert_sent_on ?? null
 row.resume_checkpoint_json = row.resume_checkpoint_json || ""
 return row
}

function sessionParams(session) {
 const monitorBrl = session.monitor_target_brl == null ? null : Number(session.monitor_target_brl)
 return [
  String(session.chat_id),
  session.conversation_id || "",
  session.context || "",
  session.intent_status || "diagnosis",
  Number(session.turn_count || 0),
  session.qualifiers_json || "{}",
  Number(session.qualifier_step || 0),
  session.operation_mode === "monitor" ? "monitor" : "recommend",
  monitorBrl,
  session.monitor_alert_sent_on || null,
  session.resume_checkpoint_json || ""
 ]
}

// ─── API pública ───

async function getSession(chatId) {
 if (USE_MEMORY) return memGetSession(chatId)

 if (USE_NEON) {
  await initNeon()
  const s = getNeon()
  const rows = await s`SELECT chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json FROM sessions WHERE chat_id = ${String(chatId)}`
  if (rows.length > 0) {
   const row = normalizeRow(rows[0])
   if (!row.conversation_id) {
    const id = randomUUID()
    await s`UPDATE sessions SET conversation_id = ${id} WHERE chat_id = ${String(chatId)}`
    row.conversation_id = id
   }
   return row
  }
  const session = newSession(chatId)
  await s`INSERT INTO sessions (chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json, updated_at) VALUES (${session.chat_id}, ${session.conversation_id}, ${session.context}, ${session.intent_status}, ${session.turn_count}, ${session.qualifiers_json}, ${session.qualifier_step}, ${session.operation_mode}, ${session.monitor_target_brl}, ${session.monitor_alert_sent_on}, ${session.resume_checkpoint_json}, CURRENT_TIMESTAMP) ON CONFLICT (chat_id) DO NOTHING`
  return session
 }

 // SQLite
 const db = getLite()
 const row = db.getSession.get(String(chatId))
 if (row) {
  if (!row.conversation_id) {
   const id = randomUUID()
   db.updateConvId.run(id, String(chatId))
   row.conversation_id = id
  }
  return normalizeRow(row)
 }
 const session = newSession(chatId)
 const p = sessionParams(session)
 db.insertSession.run(...p)
 return session
}

async function saveSession(session) {
 if (USE_MEMORY) { memSaveSession(session); return }

 const p = sessionParams(session)
 if (USE_NEON) {
  await initNeon()
  const s = getNeon()
  await s`INSERT INTO sessions (chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json, updated_at) VALUES (${p[0]}, ${p[1]}, ${p[2]}, ${p[3]}, ${p[4]}, ${p[5]}, ${p[6]}, ${p[7]}, ${p[8]}, ${p[9]}, ${p[10]}, CURRENT_TIMESTAMP) ON CONFLICT (chat_id) DO UPDATE SET conversation_id = COALESCE(NULLIF(EXCLUDED.conversation_id, ''), sessions.conversation_id), context = EXCLUDED.context, intent_status = EXCLUDED.intent_status, turn_count = EXCLUDED.turn_count, qualifiers_json = EXCLUDED.qualifiers_json, qualifier_step = EXCLUDED.qualifier_step, operation_mode = EXCLUDED.operation_mode, monitor_target_brl = EXCLUDED.monitor_target_brl, monitor_alert_sent_on = EXCLUDED.monitor_alert_sent_on, resume_checkpoint_json = EXCLUDED.resume_checkpoint_json, updated_at = CURRENT_TIMESTAMP`
  return
 }
 getLite().saveSession.run(...p)
}

async function markUpdateProcessed(updateId) {
 if (typeof updateId !== "number") return false
 if (USE_MEMORY) return memMarkProcessed(updateId)

 if (USE_NEON) {
  await initNeon()
  const s = getNeon()
  try {
   await s`INSERT INTO processed_updates (update_id) VALUES (${updateId})`
   return false
  } catch { return true }
 }
 const info = getLite().insertUpdate.run(updateId)
 return info.changes === 0
}

async function savePriceSnapshot(chatId, query, phones) {
 if (!phones.length) return
 if (USE_MEMORY) return  // memória não persiste histórico de preços

 if (USE_NEON) {
  await initNeon()
  const s = getNeon()
  for (const item of phones) {
   try {
    await s`INSERT INTO price_history (chat_id, query, model, price, price_numeric, store, product_url, rank_score, rank_reason, source_engine) VALUES (${String(chatId)}, ${query}, ${item.model || "Modelo nao informado"}, ${item.price || ""}, ${item.price_numeric ?? null}, ${item.store || ""}, ${item.link || null}, ${item.rank_score ?? null}, ${item.rank_reason || null}, 'serpapi_google_shopping')`
   } catch (e) { console.log("[DB] savePriceSnapshot erro:", e.message) }
  }
  return
 }
 const db = getLite()
 for (const item of phones) {
  try {
   db.insertPrice.run(String(chatId), query, item.model || "Modelo nao informado", item.price || "", item.price_numeric ?? null, item.store || "", item.link || null, item.rank_score ?? null, item.rank_reason || null)
  } catch (e) { console.log("[DB] savePriceSnapshot erro:", e.message) }
 }
}

async function getAllSessionsForCron() {
 if (USE_MEMORY) return [...memSessions.values()].filter(s => s.context)

 if (USE_NEON) {
  await initNeon()
  return getNeon()`SELECT chat_id, context, qualifiers_json FROM sessions WHERE context <> ''`
 }
 return getLite().allSessions.all()
}

async function getMonitorSessions(today) {
 if (USE_MEMORY) return [...memSessions.values()].filter(
  s => s.operation_mode === "monitor" && s.monitor_target_brl > 0 && s.monitor_alert_sent_on !== today
 )

 if (USE_NEON) {
  await initNeon()
  return getNeon()`SELECT chat_id, context, monitor_target_brl, qualifiers_json FROM sessions WHERE operation_mode = 'monitor' AND monitor_target_brl IS NOT NULL AND monitor_target_brl > 0 AND (monitor_alert_sent_on IS NULL OR monitor_alert_sent_on <> ${today})`
 }
 return getLite().monitorSessions.all(today)
}

async function updateMonitorAlertSentOn(chatId, today) {
 if (USE_MEMORY) {
  const s = memSessions.get(String(chatId))
  if (s) { s.monitor_alert_sent_on = today; memSessions.set(String(chatId), s) }
  return
 }

 if (USE_NEON) {
  await initNeon()
  await getNeon()`UPDATE sessions SET monitor_alert_sent_on = ${today} WHERE chat_id = ${String(chatId)}`
  return
 }
 getLite().updateAlert.run(today, String(chatId))
}

console.log(`[DB] modo: ${USE_NEON ? "Neon PostgreSQL" : USE_MEMORY ? "RAM (Vercel sem DATABASE_URL)" : "SQLite local"}`)

module.exports = {
 getSession,
 saveSession,
 markUpdateProcessed,
 savePriceSnapshot,
 getAllSessionsForCron,
 getMonitorSessions,
 updateMonitorAlertSentOn
}
