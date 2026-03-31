/**
 * Camada de banco de dados usando @neondatabase/serverless (Neon PostgreSQL).
 * Substitui better-sqlite3; todas as funÃ§Ãµes sÃ£o async.
 * LÃª DATABASE_URL do ambiente (setado pelo Vercel/Neon ou pelo .env local).
 */
const { neon } = require("@neondatabase/serverless")
const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL)
const { randomUUID } = require("crypto")

let initialized = false

async function initDb() {
  if (initialized) return
  await sql`
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
      updated_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS price_history (
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
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id   BIGINT  PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `
  initialized = true
}

async function getSession(chatId) {
  await initDb()
  const rows = await sql`
    SELECT chat_id, conversation_id, context, intent_status, turn_count,
           qualifiers_json, qualifier_step, operation_mode, monitor_target_brl,
           monitor_alert_sent_on, resume_checkpoint_json
    FROM sessions
    WHERE chat_id = ${String(chatId)}
  `
  if (rows.length > 0) {
    const row = rows[0]
    if (!row.conversation_id) {
      const id = randomUUID()
      await sql`UPDATE sessions SET conversation_id = ${id} WHERE chat_id = ${String(chatId)}`
      row.conversation_id = id
    }
    row.operation_mode = row.operation_mode || "recommend"
    row.monitor_target_brl =
      row.monitor_target_brl === null || row.monitor_target_brl === undefined
        ? null
        : Number(row.monitor_target_brl)
    row.monitor_alert_sent_on = row.monitor_alert_sent_on ?? null
    row.resume_checkpoint_json = row.resume_checkpoint_json || ""
    return row
  }

  const session = {
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
    resume_checkpoint_json: "",
  }
  await sql`
    INSERT INTO sessions
      (chat_id, conversation_id, context, intent_status, turn_count,
       qualifiers_json, qualifier_step, operation_mode, monitor_target_brl,
       monitor_alert_sent_on, resume_checkpoint_json, updated_at)
    VALUES
      (${session.chat_id}, ${session.conversation_id}, ${session.context},
       ${session.intent_status}, ${session.turn_count}, ${session.qualifiers_json},
       ${session.qualifier_step}, ${session.operation_mode}, ${session.monitor_target_brl},
       ${session.monitor_alert_sent_on}, ${session.resume_checkpoint_json}, CURRENT_TIMESTAMP)
    ON CONFLICT (chat_id) DO NOTHING
  `
  return session
}

async function saveSession(session) {
  await initDb()
  const monitorBrl =
    session.monitor_target_brl === null || session.monitor_target_brl === undefined
      ? null
      : Number(session.monitor_target_brl)
  await sql`
    INSERT INTO sessions
      (chat_id, conversation_id, context, intent_status, turn_count,
       qualifiers_json, qualifier_step, operation_mode, monitor_target_brl,
       monitor_alert_sent_on, resume_checkpoint_json, updated_at)
    VALUES
      (${String(session.chat_id)},
       ${session.conversation_id || ""},
       ${session.context || ""},
       ${session.intent_status || "diagnosis"},
       ${Number(session.turn_count || 0)},
       ${session.qualifiers_json || "{}"},
       ${Number(session.qualifier_step || 0)},
       ${session.operation_mode === "monitor" ? "monitor" : "recommend"},
       ${monitorBrl},
       ${session.monitor_alert_sent_on || null},
       ${session.resume_checkpoint_json || ""},
       CURRENT_TIMESTAMP)
    ON CONFLICT (chat_id) DO UPDATE SET
      conversation_id       = COALESCE(NULLIF(EXCLUDED.conversation_id, ''), sessions.conversation_id),
      context               = EXCLUDED.context,
      intent_status         = EXCLUDED.intent_status,
      turn_count            = EXCLUDED.turn_count,
      qualifiers_json       = EXCLUDED.qualifiers_json,
      qualifier_step        = EXCLUDED.qualifier_step,
      operation_mode        = EXCLUDED.operation_mode,
      monitor_target_brl    = EXCLUDED.monitor_target_brl,
      monitor_alert_sent_on = EXCLUDED.monitor_alert_sent_on,
      resume_checkpoint_json = EXCLUDED.resume_checkpoint_json,
      updated_at            = CURRENT_TIMESTAMP
  `
}

async function markUpdateProcessed(updateId) {
  if (typeof updateId !== "number") return false
  await initDb()
  try {
    await sql`INSERT INTO processed_updates (update_id) VALUES (${updateId})`
    return false
  } catch {
    return true // registro duplicado = update jÃ¡ processado
  }
}

async function savePriceSnapshot(chatId, query, phones) {
  if (!phones.length) return
  await initDb()
  for (const item of phones) {
    try {
      await sql`
        INSERT INTO price_history
          (chat_id, query, model, price, price_numeric, store, product_url,
           rank_score, rank_reason, source_engine)
        VALUES
          (${String(chatId)}, ${query},
           ${item.model || "Modelo nao informado"},
           ${item.price || ""},
           ${item.price_numeric ?? null},
           ${item.store || ""},
           ${item.link || null},
           ${item.rank_score ?? null},
           ${item.rank_reason || null},
           'serpapi_google_shopping')
      `
    } catch (e) {
      console.log("[DB] savePriceSnapshot erro:", e.message)
    }
  }
}

async function getAllSessionsForCron() {
  await initDb()
  const rows = await sql`
    SELECT chat_id, context, qualifiers_json
    FROM sessions
    WHERE context <> ''
  `
  return rows
}

async function getMonitorSessions(today) {
  await initDb()
  const rows = await sql`
    SELECT chat_id, context, monitor_target_brl, qualifiers_json
    FROM sessions
    WHERE operation_mode = 'monitor'
      AND monitor_target_brl IS NOT NULL
      AND monitor_target_brl > 0
      AND (monitor_alert_sent_on IS NULL OR monitor_alert_sent_on <> ${today})
  `
  return rows
}

async function updateMonitorAlertSentOn(chatId, today) {
  await initDb()
  await sql`UPDATE sessions SET monitor_alert_sent_on = ${today} WHERE chat_id = ${String(chatId)}`
}

module.exports = {
  initDb,
  getSession,
  saveSession,
  markUpdateProcessed,
  savePriceSnapshot,
  getAllSessionsForCron,
  getMonitorSessions,
  updateMonitorAlertSentOn,
}

