/**
 * Camada de dados: Neon (Postgres) se DATABASE_URL/POSTGRES_URL existir;
 * senão SQLite em concierge.db (dev local — o processo não cai no require).
 */
const path = require("path")
const { randomUUID } = require("crypto")

/** Nunca chamar neon() no load do modulo — evita crash na Vercel sem DATABASE_URL. */
const connectionStringRaw = process.env.DATABASE_URL || process.env.POSTGRES_URL || ""
const connectionString = String(connectionStringRaw).trim() || null

function makeNeon(connectionUrl) {
  const url = String(connectionUrl || "").trim()
  if (!url) {
    throw new Error("[db] makeNeon: connection string vazia")
  }
  const { neon } = require("@neondatabase/serverless")
  let sql = null
  function getSql() {
    if (!sql) sql = neon(url)
    return sql
  }
  let initialized = false

  async function initDb() {
    if (initialized) return
    await getSql()`
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
    await getSql()`
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
    await getSql()`
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id   BIGINT  PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `
    initialized = true
  }

  async function getSession(chatId) {
    await initDb()
    const rows = await getSql()`
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
        await getSql()`UPDATE sessions SET conversation_id = ${id} WHERE chat_id = ${String(chatId)}`
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
      resume_checkpoint_json: ""
    }
    await getSql()`
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
    await getSql()`
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
      await getSql()`INSERT INTO processed_updates (update_id) VALUES (${updateId})`
      return false
    } catch {
      return true
    }
  }

  async function savePriceSnapshot(chatId, query, phones) {
    if (!phones.length) return
    await initDb()
    for (const item of phones) {
      try {
        await getSql()`
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
    return getSql()`
    SELECT chat_id, context, qualifiers_json
    FROM sessions
    WHERE context <> ''
  `
  }

  async function getMonitorSessions(today) {
    await initDb()
    return getSql()`
    SELECT chat_id, context, monitor_target_brl, qualifiers_json
    FROM sessions
    WHERE operation_mode = 'monitor'
      AND monitor_target_brl IS NOT NULL
      AND monitor_target_brl > 0
      AND (monitor_alert_sent_on IS NULL OR monitor_alert_sent_on <> ${today})
  `
  }

  async function updateMonitorAlertSentOn(chatId, today) {
    await initDb()
    await getSql()`UPDATE sessions SET monitor_alert_sent_on = ${today} WHERE chat_id = ${String(chatId)}`
  }

  return {
    initDb,
    getSession,
    saveSession,
    markUpdateProcessed,
    savePriceSnapshot,
    getAllSessionsForCron,
    getMonitorSessions,
    updateMonitorAlertSentOn
  }
}

function makeSqlite(dbPath) {
  const Database = require("better-sqlite3")
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  let initialized = false

  async function initDb() {
    if (initialized) return
    db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id                TEXT PRIMARY KEY,
      conversation_id        TEXT NOT NULL DEFAULT '',
      context                TEXT NOT NULL DEFAULT '',
      intent_status          TEXT NOT NULL DEFAULT 'diagnosis',
      turn_count             INTEGER NOT NULL DEFAULT 0,
      qualifiers_json        TEXT NOT NULL DEFAULT '{}',
      qualifier_step         INTEGER NOT NULL DEFAULT 0,
      operation_mode         TEXT NOT NULL DEFAULT 'recommend',
      monitor_target_brl     REAL,
      monitor_alert_sent_on  TEXT,
      resume_checkpoint_json TEXT NOT NULL DEFAULT '',
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id        TEXT NOT NULL,
      query          TEXT NOT NULL,
      model          TEXT NOT NULL,
      price          TEXT,
      price_numeric  REAL,
      store          TEXT,
      product_url    TEXT,
      rank_score     REAL,
      rank_reason    TEXT,
      source_engine  TEXT NOT NULL DEFAULT 'serpapi_google_shopping',
      captured_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id   INTEGER PRIMARY KEY,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
    initialized = true
  }

  async function getSession(chatId) {
    await initDb()
    const key = String(chatId)
    const row = db
      .prepare(
        `SELECT chat_id, conversation_id, context, intent_status, turn_count,
            qualifiers_json, qualifier_step, operation_mode, monitor_target_brl,
            monitor_alert_sent_on, resume_checkpoint_json
         FROM sessions WHERE chat_id = ?`
      )
      .get(key)

    if (row) {
      if (!row.conversation_id) {
        const id = randomUUID()
        db.prepare("UPDATE sessions SET conversation_id = ? WHERE chat_id = ?").run(id, key)
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
      chat_id: key,
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
    db.prepare(
      `INSERT OR IGNORE INTO sessions
        (chat_id, conversation_id, context, intent_status, turn_count,
         qualifiers_json, qualifier_step, operation_mode, monitor_target_brl,
         monitor_alert_sent_on, resume_checkpoint_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      session.chat_id,
      session.conversation_id,
      session.context,
      session.intent_status,
      session.turn_count,
      session.qualifiers_json,
      session.qualifier_step,
      session.operation_mode,
      session.monitor_target_brl,
      session.monitor_alert_sent_on,
      session.resume_checkpoint_json
    )
    return session
  }

  async function saveSession(session) {
    await initDb()
    const monitorBrl =
      session.monitor_target_brl === null || session.monitor_target_brl === undefined
        ? null
        : Number(session.monitor_target_brl)
    const op = session.operation_mode === "monitor" ? "monitor" : "recommend"
    db.prepare(
      `INSERT INTO sessions
        (chat_id, conversation_id, context, intent_status, turn_count,
         qualifiers_json, qualifier_step, operation_mode, monitor_target_brl,
         monitor_alert_sent_on, resume_checkpoint_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET
         conversation_id = COALESCE(NULLIF(excluded.conversation_id,''), sessions.conversation_id),
         context = excluded.context,
         intent_status = excluded.intent_status,
         turn_count = excluded.turn_count,
         qualifiers_json = excluded.qualifiers_json,
         qualifier_step = excluded.qualifier_step,
         operation_mode = excluded.operation_mode,
         monitor_target_brl = excluded.monitor_target_brl,
         monitor_alert_sent_on = excluded.monitor_alert_sent_on,
         resume_checkpoint_json = excluded.resume_checkpoint_json,
         updated_at = datetime('now')`
    ).run(
      String(session.chat_id),
      session.conversation_id || "",
      session.context || "",
      session.intent_status || "diagnosis",
      Number(session.turn_count || 0),
      session.qualifiers_json || "{}",
      Number(session.qualifier_step || 0),
      op,
      monitorBrl,
      session.monitor_alert_sent_on || null,
      session.resume_checkpoint_json || ""
    )
  }

  async function markUpdateProcessed(updateId) {
    if (typeof updateId !== "number") return false
    await initDb()
    const info = db
      .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)")
      .run(updateId)
    return info.changes === 0
  }

  async function savePriceSnapshot(chatId, query, phones) {
    if (!phones.length) return
    await initDb()
    const ins = db.prepare(
      `INSERT INTO price_history
        (chat_id, query, model, price, price_numeric, store, product_url,
         rank_score, rank_reason, source_engine)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    for (const item of phones) {
      try {
        ins.run(
          String(chatId),
          query,
          item.model || "Modelo nao informado",
          item.price || "",
          item.price_numeric ?? null,
          item.store || "",
          item.link || null,
          item.rank_score ?? null,
          item.rank_reason || null,
          "serpapi_google_shopping"
        )
      } catch (e) {
        console.log("[DB] savePriceSnapshot erro:", e.message)
      }
    }
  }

  async function getAllSessionsForCron() {
    await initDb()
    return db
      .prepare(`SELECT chat_id, context, qualifiers_json FROM sessions WHERE context <> ''`)
      .all()
  }

  async function getMonitorSessions(today) {
    await initDb()
    return db
      .prepare(
        `SELECT chat_id, context, monitor_target_brl, qualifiers_json
         FROM sessions
         WHERE operation_mode = 'monitor'
           AND monitor_target_brl IS NOT NULL
           AND monitor_target_brl > 0
           AND (monitor_alert_sent_on IS NULL OR monitor_alert_sent_on <> ?)`
      )
      .all(today)
  }

  async function updateMonitorAlertSentOn(chatId, today) {
    await initDb()
    db.prepare("UPDATE sessions SET monitor_alert_sent_on = ? WHERE chat_id = ?").run(
      today,
      String(chatId)
    )
  }

  return {
    initDb,
    getSession,
    saveSession,
    markUpdateProcessed,
    savePriceSnapshot,
    getAllSessionsForCron,
    getMonitorSessions,
    updateMonitorAlertSentOn
  }
}

/**
 * Vercel sem DATABASE_URL: sessoes em RAM (sobrevive ao mesmo isolate; cold start zera).
 * Para producao seria, adicione DATABASE_URL (Neon) nas env vars.
 */
function makeVercelMemoryAdapter() {
  const sessions = new Map()
  const processedIds = new Set()
  const priceRows = []
  const PRICE_CAP = 3000
  let warned = false

  async function initDb() {
    if (!warned) {
      warned = true
      console.warn(
        "[db] Vercel: DATABASE_URL ausente — usando memoria volatil (cold start perde sessoes). Adicione Neon quando possivel."
      )
    }
  }

  function normalizeRow(stored) {
    const row = { ...stored }
    row.operation_mode = row.operation_mode || "recommend"
    row.monitor_target_brl =
      row.monitor_target_brl === null || row.monitor_target_brl === undefined
        ? null
        : Number(row.monitor_target_brl)
    row.monitor_alert_sent_on = row.monitor_alert_sent_on ?? null
    row.resume_checkpoint_json = row.resume_checkpoint_json || ""
    return row
  }

  async function getSession(chatId) {
    await initDb()
    const key = String(chatId)
    const stored = sessions.get(key)
    if (stored) {
      const row = normalizeRow(stored)
      if (!row.conversation_id) {
        const id = randomUUID()
        sessions.set(key, { ...stored, conversation_id: id })
        row.conversation_id = id
      }
      return row
    }
    const session = {
      chat_id: key,
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
    sessions.set(key, { ...session })
    return normalizeRow({ ...session })
  }

  async function saveSession(session) {
    await initDb()
    const monitorBrl =
      session.monitor_target_brl === null || session.monitor_target_brl === undefined
        ? null
        : Number(session.monitor_target_brl)
    sessions.set(String(session.chat_id), {
      chat_id: String(session.chat_id),
      conversation_id: session.conversation_id || "",
      context: session.context || "",
      intent_status: session.intent_status || "diagnosis",
      turn_count: Number(session.turn_count || 0),
      qualifiers_json: session.qualifiers_json || "{}",
      qualifier_step: Number(session.qualifier_step || 0),
      operation_mode: session.operation_mode === "monitor" ? "monitor" : "recommend",
      monitor_target_brl: monitorBrl,
      monitor_alert_sent_on: session.monitor_alert_sent_on || null,
      resume_checkpoint_json: session.resume_checkpoint_json || ""
    })
  }

  async function markUpdateProcessed(updateId) {
    if (typeof updateId !== "number") return false
    await initDb()
    if (processedIds.has(updateId)) return true
    processedIds.add(updateId)
    return false
  }

  async function savePriceSnapshot(chatId, query, phones) {
    if (!phones.length) return
    await initDb()
    for (const item of phones) {
      priceRows.push({
        chat_id: String(chatId),
        query,
        model: item.model || "Modelo nao informado",
        price: item.price || "",
        price_numeric: item.price_numeric ?? null,
        store: item.store || "",
        product_url: item.link || null,
        rank_score: item.rank_score ?? null,
        rank_reason: item.rank_reason || null,
        source_engine: "serpapi_google_shopping"
      })
    }
    while (priceRows.length > PRICE_CAP) priceRows.shift()
  }

  async function getAllSessionsForCron() {
    await initDb()
    return Array.from(sessions.values())
      .filter((s) => (s.context || "").trim() !== "")
      .map((s) => ({
        chat_id: s.chat_id,
        context: s.context || "",
        qualifiers_json: s.qualifiers_json || "{}"
      }))
  }

  async function getMonitorSessions(today) {
    await initDb()
    return Array.from(sessions.values()).filter(
      (s) =>
        s.operation_mode === "monitor" &&
        s.monitor_target_brl != null &&
        Number(s.monitor_target_brl) > 0 &&
        (s.monitor_alert_sent_on == null || s.monitor_alert_sent_on !== today)
    )
  }

  async function updateMonitorAlertSentOn(chatId, today) {
    await initDb()
    const key = String(chatId)
    const s = sessions.get(key)
    if (!s) return
    sessions.set(key, { ...s, monitor_alert_sent_on: today })
  }

  return {
    initDb,
    getSession,
    saveSession,
    markUpdateProcessed,
    savePriceSnapshot,
    getAllSessionsForCron,
    getMonitorSessions,
    updateMonitorAlertSentOn
  }
}

/** RAM só em deploy Vercel real (sem Neon). VERCEL=1 no PC não usa RAM — evita “sumir” sessão local. */
const useVercelMemoryAdapter =
  process.env.VERCEL === "1" &&
  ["production", "preview"].includes(String(process.env.VERCEL_ENV || ""))

let impl
if (connectionString) {
  impl = makeNeon(connectionString)
} else if (useVercelMemoryAdapter) {
  impl = makeVercelMemoryAdapter()
} else {
  console.warn(
    "[db] Sem DATABASE_URL/POSTGRES_URL — usando SQLite:",
    path.join(__dirname, "..", "concierge.db")
  )
  impl = makeSqlite(path.join(__dirname, "..", "concierge.db"))
}

module.exports = impl
