require("dotenv").config()

const path = require("path")
const { randomUUID } = require("crypto")
const express = require("express")
const axios = require("axios")
const OpenAI = require("openai")
const Database = require("better-sqlite3")
const cron = require("node-cron")

const app = express()
app.use(express.json({ limit: "256kb" }))

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const SERPAPI_KEY = process.env.SERPAPI_KEY
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ""
const LOG_VIEWER_SECRET = process.env.LOG_VIEWER_SECRET || ""
const PORT = Number(process.env.PORT || 3000)
const MAX_CONTEXT_CHARS = 6000
const TELEGRAM_LOG_MAX = 500
const telegramMessageLog = []

function pushTelegramLog(entry) {
 telegramMessageLog.unshift({
  t: Date.now(),
  ...entry
 })
 while (telegramMessageLog.length > TELEGRAM_LOG_MAX) telegramMessageLog.pop()
}

function escapeHtml(s) {
 return String(s)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
}

function formatLogPage(logs) {
 const rows =
  logs.length === 0
   ? '<tr><td colspan="5">Nenhum evento ainda.</td></tr>'
   : logs
      .map((e) => {
       const d = new Date(e.t).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
       return `<tr><td>${escapeHtml(d)}</td><td><code>${escapeHtml(String(e.chatId))}</code></td><td>${escapeHtml(e.direction || "in")}</td><td>${escapeHtml(e.text || "")}</td><td>${escapeHtml(e.note || "")}</td></tr>`
      })
      .join("")
 const keyHint = LOG_VIEWER_SECRET
  ? `<p class="hint">Acesso protegido: abra com <code>?key=SUA_CHAVE</code> (LOG_VIEWER_SECRET no .env).</p>`
  : `<p class="hint">Sem senha: em produção, defina <code>LOG_VIEWER_SECRET</code> no .env.</p>`
 return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="4"/>
<title>Concierge — log Telegram</title>
<style>
 body{font-family:system-ui,sans-serif;background:#0f1419;color:#e7e9ea;margin:0;padding:1rem;}
 h1{font-size:1.1rem;font-weight:600;}
 .hint{color:#71767b;font-size:0.85rem;}
 table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:0.9rem;}
 th,td{border:1px solid #38444d;padding:0.5rem 0.65rem;text-align:left;vertical-align:top;}
 th{background:#1d292e;color:#8b98a5;font-weight:600;}
 tr:nth-child(even){background:#1a2228;}
 code{font-size:0.85rem;word-break:break-all;}
 td:last-child{max-width:40vw;word-break:break-word;}
</style>
</head>
<body>
<h1>Mensagens Telegram (últimas ${logs.length})</h1>
<p class="hint">Atualiza a cada 4s. Entrada = usuário; Saída = texto enviado pelo bot.</p>
${keyHint}
<table>
<thead><tr><th>Hora (SP)</th><th>chat_id</th><th>Dir</th><th>Texto</th><th>Nota</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">Nenhum evento ainda.</td></tr>'}</tbody>
</table>
</body>
</html>`
}

const openai = new OpenAI({
 apiKey: process.env.OPENAI_API_KEY
})

const http = axios.create({
 timeout: 15000
})

const db = new Database(path.join(__dirname, "concierge.db"))
db.pragma("journal_mode = WAL")
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
 chat_id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 context TEXT NOT NULL DEFAULT '',
 intent_status TEXT NOT NULL DEFAULT 'diagnosis',
 turn_count INTEGER NOT NULL DEFAULT 0,
 qualifiers_json TEXT NOT NULL DEFAULT '{}',
 qualifier_step INTEGER NOT NULL DEFAULT 0,
 operation_mode TEXT NOT NULL DEFAULT 'recommend',
 monitor_target_brl REAL,
 monitor_alert_sent_on TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 chat_id TEXT NOT NULL,
 query TEXT NOT NULL,
 model TEXT NOT NULL,
 price TEXT,
 price_numeric REAL,
 store TEXT,
 product_url TEXT,
 rank_score REAL,
 rank_reason TEXT,
 source_engine TEXT NOT NULL DEFAULT 'serpapi_google_shopping',
 captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_updates (
 update_id INTEGER PRIMARY KEY,
 received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`)
try {
 db.exec("ALTER TABLE sessions ADD COLUMN qualifiers_json TEXT NOT NULL DEFAULT '{}';")
} catch {}
try {
 db.exec("ALTER TABLE sessions ADD COLUMN qualifier_step INTEGER NOT NULL DEFAULT 0;")
} catch {}
try {
 db.exec("ALTER TABLE sessions ADD COLUMN conversation_id TEXT;")
} catch {}
try {
 db.exec("ALTER TABLE sessions ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'recommend';")
} catch {}
try {
 db.exec("ALTER TABLE sessions ADD COLUMN monitor_target_brl REAL;")
} catch {}
try {
 db.exec("ALTER TABLE sessions ADD COLUMN monitor_alert_sent_on TEXT;")
} catch {}

try {
 db.exec("ALTER TABLE price_history ADD COLUMN price_numeric REAL;")
} catch {}
try {
 db.exec("ALTER TABLE price_history ADD COLUMN product_url TEXT;")
} catch {}
try {
 db.exec("ALTER TABLE price_history ADD COLUMN rank_score REAL;")
} catch {}
try {
 db.exec("ALTER TABLE price_history ADD COLUMN rank_reason TEXT;")
} catch {}
try {
 db.exec("ALTER TABLE price_history ADD COLUMN source_engine TEXT DEFAULT 'serpapi_google_shopping';")
} catch {}
try {
 db.exec("ALTER TABLE sessions ADD COLUMN resume_checkpoint_json TEXT NOT NULL DEFAULT '';")
} catch {}

const upsertSessionStmt = db.prepare(`
INSERT INTO sessions (chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json, updated_at)
VALUES (@chat_id, @conversation_id, @context, @intent_status, @turn_count, @qualifiers_json, @qualifier_step, @operation_mode, @monitor_target_brl, @monitor_alert_sent_on, @resume_checkpoint_json, CURRENT_TIMESTAMP)
ON CONFLICT(chat_id) DO UPDATE SET
 conversation_id = COALESCE(NULLIF(excluded.conversation_id, ''), sessions.conversation_id),
 context = excluded.context,
 intent_status = excluded.intent_status,
 turn_count = excluded.turn_count,
 qualifiers_json = excluded.qualifiers_json,
 qualifier_step = excluded.qualifier_step,
 operation_mode = excluded.operation_mode,
 monitor_target_brl = excluded.monitor_target_brl,
 monitor_alert_sent_on = excluded.monitor_alert_sent_on,
 resume_checkpoint_json = excluded.resume_checkpoint_json,
 updated_at = CURRENT_TIMESTAMP;
`)

function getSession(chatId) {
 const row = db
  .prepare("SELECT chat_id, conversation_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, operation_mode, monitor_target_brl, monitor_alert_sent_on, resume_checkpoint_json FROM sessions WHERE chat_id = ?")
  .get(String(chatId))

 if (row) {
  if (!row.conversation_id) {
   const id = randomUUID()
   db.prepare("UPDATE sessions SET conversation_id = ? WHERE chat_id = ?").run(id, String(chatId))
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

 upsertSessionStmt.run(session)
 return session
}

function saveSession(session) {
 upsertSessionStmt.run({
  chat_id: String(session.chat_id),
  conversation_id: session.conversation_id || randomUUID(),
  context: session.context || "",
  intent_status: session.intent_status || "diagnosis",
  turn_count: Number(session.turn_count || 0),
  qualifiers_json: session.qualifiers_json || "{}",
  qualifier_step: Number(session.qualifier_step || 0),
  operation_mode: session.operation_mode === "monitor" ? "monitor" : "recommend",
  monitor_target_brl:
   session.monitor_target_brl === null || session.monitor_target_brl === undefined
    ? null
    : Number(session.monitor_target_brl),
  monitor_alert_sent_on: session.monitor_alert_sent_on || null,
  resume_checkpoint_json: session.resume_checkpoint_json || ""
 })
}

const TRUSTED_STORE_HINTS = [
 "amazon",
 "mercado livre",
 "magazine",
 "magalu",
 "americanas",
 "casas bahia",
 "extra",
 "ponto",
 "shopee",
 "samsung",
 "apple",
 "xiaomi"
]

function parseBrlPriceString(priceStr) {
 if (priceStr === null || priceStr === undefined) return null
 let s = String(priceStr).trim().replace(/R\$\s*/i, "")
 if (!s) return null
 const onlyDigits = s.replace(/\D/g, "")
 if (/^\d{3,7}$/.test(onlyDigits) && !/[.,]/.test(s))
  return Number(onlyDigits)
 if (/^\d{1,3}(\.\d{3})+(,\d{2})$/.test(s))
  return parseFloat(s.replace(/\./g, "").replace(",", "."))
 if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g, ""))
 if (/^\d+,\d{2}$/.test(s)) return parseFloat(s.replace(",", "."))
 if (/^\d+\.\d{2}$/.test(s)) return parseFloat(s)
 const n = parseFloat(s.replace(/[^\d.,]/g, "").replace(",", "."))
 return Number.isFinite(n) ? n : null
}

function storeTrustScore(storeName) {
 if (!storeName) return 0
 const low = String(storeName).toLowerCase()
 let hits = 0
 for (const h of TRUSTED_STORE_HINTS) {
  if (low.includes(h)) hits++
 }
 if (hits >= 2) return 12
 if (hits === 1) return 8
 return 0
}

function storageHintMatch(title, qualifiers) {
 const st = (qualifiers.storage || "").toLowerCase()
 const t = (title || "").toLowerCase()
 if (!st || st === "nao informado") return 3
 if (st.includes("1tb") && (t.includes("1 tb") || t.includes("1tb"))) return 10
 if (st.includes("512") && t.includes("512")) return 10
 if (st.includes("256") && t.includes("256")) return 10
 if (st.includes("128") && t.includes("128")) return 10
 return 2
}

function rankAndEnrichPhones(phones, qualifiers) {
 const q = qualifiers || {}
 const withNum = phones.map((p) => ({
  ...p,
  price_numeric: parseBrlPriceString(p.price)
 }))
 const nums = withNum.map((p) => p.price_numeric).filter((n) => n !== null && n > 0)
 const minP = nums.length ? Math.min(...nums) : 0
 const maxP = nums.length ? Math.max(...nums) : 1
 const ranged = withNum.map((p) => {
  let pricePart = 35
  if (p.price_numeric && maxP > minP) {
   pricePart = 35 * (1 - (p.price_numeric - minP) / (maxP - minP))
  } else if (p.price_numeric && maxP === minP) {
   pricePart = 35
  }
  const trust = storeTrustScore(p.store)
  const storM = storageHintMatch(p.model, q)
  const score = pricePart + trust + storM
  const reasons = []
  if (p.price_numeric) reasons.push(`preço relativo ${pricePart.toFixed(0)}/35`)
  if (trust) reasons.push(`loja +${trust}`)
  if (storM > 2) reasons.push(`armazenamento +${storM}`)
  return {
   ...p,
   rank_score: Math.round(score * 10) / 10,
   rank_reason: reasons.join("; ") || "sem desempate extra"
  }
 })
 return ranged.sort((a, b) => b.rank_score - a.rank_score)
}

function detectOperationMode(message, currentMode) {
 const l = (message || "").toLowerCase()
 if (
  /monitor|acompanh|alerta|avisar|avis(o|e)|pre[cç]o alvo|preco-alvo|esperar cair|queda de pre/.test(l)
 )
  return "monitor"
 if (/comprar agora|recomend|melhor op|qual (comprar|pego)|sugest(a|ão)/.test(l)) return "recommend"
 return currentMode === "monitor" ? "monitor" : currentMode === "recommend" ? "recommend" : "recommend"
}

function parseMonitorTargetBrl(message) {
 const raw = message || ""
 const m = raw.match(
  /(?:alvo|ate|até|m[aá]ximo|teto|m[aá]x)\s*[:\s]*R?\$?\s*([\d]{1,3}(?:\.[\d]{3})*(?:,[\d]{2})?|[\d]+(?:,[\d]{2})?)/i
 )
 if (m) {
  const n = parseBrlPriceString(m[1])
  if (n && n > 0) return n
 }
 if (/monitor|alvo|pre[cç]o|preco|acompanh/i.test(raw)) {
  const d = raw.match(/\b(\d{3,5})\b/)
  if (d) {
   const n = Number(d[1])
   if (n >= 300) return n
  }
 }
 return null
}

function todayKeySaoPaulo() {
 return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })
}

function markUpdateProcessed(updateId) {
 if (typeof updateId !== "number") return false
 try {
  db.prepare("INSERT INTO processed_updates (update_id) VALUES (?)").run(updateId)
  return false
 } catch {
  return true
 }
}

function savePriceSnapshot(chatId, query, phones) {
 if (!phones.length) return
 const insert = db.prepare(`
INSERT INTO price_history (chat_id, query, model, price, price_numeric, store, product_url, rank_score, rank_reason, source_engine)
VALUES (@chat_id, @query, @model, @price, @price_numeric, @store, @product_url, @rank_score, @rank_reason, @source_engine)
`)
 const tx = db.transaction((items) => {
  for (const item of items) {
   const priceNum =
    item.price_numeric !== null && item.price_numeric !== undefined
     ? item.price_numeric
     : parseBrlPriceString(item.price)
   insert.run({
    chat_id: String(chatId),
    query,
    model: item.model || "Modelo nao informado",
    price: item.price || "",
    price_numeric: priceNum,
    store: item.store || "",
    product_url: item.link || null,
    rank_score: item.rank_score ?? null,
    rank_reason: item.rank_reason || null,
    source_engine: "serpapi_google_shopping"
   })
  }
 })
 tx(phones)
}

function appendContext(context, message) {
 const next = `${context}\n${message}`.trim()
 return next.length > MAX_CONTEXT_CHARS ? next.slice(-MAX_CONTEXT_CHARS) : next
}

function isWebhookValid(req) {
 if (!TELEGRAM_WEBHOOK_SECRET) return true
 const token = req.headers["x-telegram-bot-api-secret-token"]
 return token === TELEGRAM_WEBHOOK_SECRET
}

/** Passo “terminamos o funil” (sem perguntas fixas por indice). */
const QUALIFIER_DONE_STEP = 99

const FLEX_DIAGNOSIS_RESUME =
 "Otimo, retomando — sem pressa. O que **mais importa** pra voce nesse celular agora?"

const FLEX_NEW_CHAT_OPENER =
 "Combinado, comecamos de novo. Me conta **com calma** o cenario: troca o que ta quebrado, upgrade, presente… o que trouxe voce aqui?"

function parseQualifiers(raw) {
 try {
  const parsed = JSON.parse(raw || "{}")
  return typeof parsed === "object" && parsed ? parsed : {}
 } catch {
  return {}
 }
}

function extractBudgetReaisFromMessage(text) {
 const raw = String(text || "").trim()
 if (!raw) return null
 const nFull = parseBrlPriceString(raw)
 if (nFull !== null && nFull >= 200 && nFull <= 1500000) return nFull

 const lower = raw.toLowerCase()
 const mil = lower.match(/\b(\d{1,2})\s*mil(?:\s*(?:de)?\s*reais)?\b/)
 if (mil) {
  const v = Number(mil[1]) * 1000
  if (v >= 200) return v
 }
 const km = lower.match(/\b(\d{1,3})\s*k\b/)
 if (km) {
  const v = Number(km[1]) * 1000
  if (v >= 200) return v
 }
 const rsMatches = raw.matchAll(/r\$\s*([\d.,]+)/gi)
 for (const m of rsMatches) {
  const n = parseBrlPriceString(m[1])
  if (n !== null && n >= 200 && n <= 1500000) return n
 }
 const ate = lower.match(/(?:ate|até)\s+(?:uns?\s+)?(?:r\$\s*)?([\d.,]+)\s*(?:reais)?/)
 if (ate) {
  const n = parseBrlPriceString(ate[1])
  if (n !== null && n >= 200 && n <= 1500000) return n
 }
 const scrubbed = raw.replace(/\b\d{1,4}\s*(?:gb|tb)\b/gi, " ")
 const mNum = scrubbed.match(/\b(\d{3,7})\b/)
 if (mNum) {
  const v = Number(mNum[1])
  if (v >= 400 && v <= 1500000) return v
 }
 return null
}

function parseQualifierAnswer(key, message) {
 const text = (message || "").trim()
 const lower = text.toLowerCase()
 if (!text) return null

 if (key === "path_model") {
  if (
   /(iphone|galaxy|pixel|motorola|xiaomi|samsung|apple|redmi|poco|zenfone|\bS\d{2}\b|note\s*\d|nothing phone|\d+\s*(pro|max|ultra|plus|fe|mini)\b|\bA\d{2}\s*5g)/i.test(
    text
   )
  )
   return "modelo_em_mente"
  if (/(explorar|indica|sugere|nao sei|não sei|melhor opc|custo benef|orça|orçamento)/i.test(lower))
   return "explorar_opcoes"
  return "explorar_opcoes"
 }

 if (key === "budget") {
  if (
   /sem limite|sem teto|flex[ií]vel|ilimitad|nao sei|não sei|nao tenho|não tenho|qualquer|tanto faz|open budget|economizar|o mais barato|^barato$/i.test(
    lower
   )
  )
   return "flexivel"
  const extracted = extractBudgetReaisFromMessage(text)
  if (extracted !== null)
   return `R$ ${Math.round(extracted).toLocaleString("pt-BR")}`
  if (
   /(quero|preciso|busco|pretendo|vou comprar|comprar um|comprar uma|to querendo|tou querendo|gostaria de comprar)/i.test(
    text
   ) &&
   /(iphone|galaxy|pixel|celular|smartphone|motorola|xiaomi|\bapple\b|sansung|samsung)/i.test(text)
  )
   return "flexivel"
  if (isCasualGreeting(text)) return "flexivel"
  if (isBudgetConversationFiller(text)) return "flexivel"
  return null
 }

 if (key === "primary_use") {
  if (/(noturn|noite|balada|festa|low light|paisagem)/i.test(lower)) return "camera"
  if (/(iphone|apple|ios)/i.test(text)) return "uso geral"
  if (/(camera|foto|video|selfie|instagram)/.test(lower)) return "camera"
  if (/(jogo|games|fps|gamer|pesad|pubg|cod|fortnite)/.test(lower)) return "jogos"
  if (/(trabalho|produtividade|office|estud)/.test(lower)) return "trabalho"
  if (/(trilha|viagem longa|dois dias|acamp)/i.test(lower)) return "uso geral"
  return "uso geral"
 }

 if (key === "battery_need") {
  if (
   /(sim|muito|bastante|dia todo|o dia inteiro|o dia todo|pesad[o]|aguenta|duradour|autonomia|no m[ií]nimo|preciso.*bateria|bateria.*importante|trilha|dois dias|rolê|role)/i.test(
    lower
   )
  )
   return "alta"
  if (/(nao|não|normal|leve|moderad|basico|s[oó] redes sociais)/.test(lower)) return "normal"
  return null
 }

 if (key === "storage") {
  if (/(1tb|1024)/.test(lower)) return "1TB"
  if (/(512)/.test(lower)) return "512GB"
  if (/(256)/.test(lower)) return "256GB"
  if (/(128)/.test(lower)) return "128GB"
  if (/medio|m[eé]dia|intermedi|nao sei|não sei|tanto faz|indiferente/.test(lower)) return "256GB"
  return null
 }

 return null
}

function normalizeChatTokens(s) {
 return String(s || "")
  .trim()
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[!?.#,;:…]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
}

function isCasualGreeting(text) {
 const raw = String(text || "").trim()
 if (!raw || raw.length > 120) return false
 if (
  /(quero|preciso|comprar|or[cç]amento|orcamento|iphone|android|celular|smartphone|pixel|galaxy|xiaomi|motorola|r\$|\breais\b|\b\d{4,}\b)/i.test(
   raw
  )
 )
  return false
 const t = normalizeChatTokens(raw)
 const wordCount = t.split(" ").filter(Boolean).length
 if (wordCount > 14) return false
 return (
  /\b(oi|ola|opa|e\s*ai|eae|hey|bom dia|boa tarde|boa noite|tudo bem|td bem|como vai|como voce esta|beleza|suave|sumido|tranquilo|fala|salve|blz|e\s*entao)\b/i.test(
   t
  ) || /^(oi|ola|opa|eae|eai|salve|fala)\b/i.test(t)
 )
}

/** Saudacao / encheção curta no passo de orçamento (evita loop em "e ai beleza?"). */
function isBudgetConversationFiller(text) {
 const raw = String(text || "").trim()
 if (!raw || raw.length > 90) return false
 if (/\br\$\s*[\d.,]+/i.test(raw)) return false
 if (extractBudgetReaisFromMessage(raw) !== null) return false
 if (
  /(quero|preciso|vou comprar|comprar um|comprar uma|iphone|galaxy|pixel|celular|smartphone|or[cç]amento|orcamento)/i.test(
   raw
  )
 )
  return false
 const t = normalizeChatTokens(raw)
 const wc = t.split(" ").filter(Boolean).length
 if (wc > 10) return false
 if (
  /\b(oi|ola|opa|eae|eai|e\s*ai|salve|fala|blz|beleza|tranquilo|suave|tudo bem|td bem|como vai|como vai vc|e\s*entao|opa tudo)\b/i.test(
   t
  )
 )
  return true
 if (/^(kk+|haha|rsrs?)\b/i.test(t)) return true
 if (wc <= 5 && /^(blz|beleza|oi|ola|opa|eae|fala|salve)$/.test(t)) return true
 return false
}

function mergeQualifiersFromPatch(qualifiers, patch, message) {
 const p = patch && typeof patch === "object" ? patch : {}
 for (const key of ["path_model", "budget", "primary_use", "battery_need", "storage"]) {
  const v = p[key]
  if (v == null || String(v).trim() === "") continue
  const str = String(v).trim()
  const parsed = parseQualifierAnswer(key, str)
  if (parsed) {
   qualifiers[key] = parsed
   continue
  }
  if (key === "budget") {
   const n = extractBudgetReaisFromMessage(str)
   if (n != null)
    qualifiers[key] = `R$ ${Math.round(n).toLocaleString("pt-BR")}`
   else if (/flex|sem limite|tanto faz|nao sei/i.test(str)) qualifiers[key] = "flexivel"
  }
 }
 const hint = message ? String(message).trim() : ""
 if (hint) {
  if (!qualifiers.budget) {
   const n = extractBudgetReaisFromMessage(hint)
   if (n != null)
    qualifiers.budget = `R$ ${Math.round(n).toLocaleString("pt-BR")}`
  }
  for (const key of ["path_model", "primary_use", "battery_need", "storage"]) {
   if (!qualifiers[key]) {
    const x = parseQualifierAnswer(key, hint)
    if (x) qualifiers[key] = x
   }
  }
 }
}

function qualifiersRoughlyReadyForSearch(qualifiers, session) {
 const q = qualifiers || {}
 const bud = q.budget ? String(q.budget).trim() : ""
 const hasBudget = Boolean(bud)
 const hasFlex = /flexivel/i.test(bud)
 const hasNumericBudget = /R\$\s*[\d.]+/i.test(bud) || /\d{3,}/.test(bud)
 const hasPath = Boolean(q.path_model)
 const hasUse = Boolean(q.primary_use || q.battery_need || q.storage)
 const tc = Number(session.turn_count || 0)
 const ctxLen = (session.context || "").length
 if (!hasBudget) return false
 if (hasFlex && !(hasPath || hasUse) && tc < 8) return false
 if ((hasNumericBudget || hasFlex) && (hasPath || hasUse)) return true
 if ((hasNumericBudget || hasFlex) && ctxLen >= 500) return true
 if (hasBudget && tc >= 12) return true
 return false
}

function hasResumableConversation(session) {
 const ctx = (session.context || "").trim()
 if (ctx.length >= 35) return true
 if (Number(session.qualifier_step || 0) > 0) return true
 const q = parseQualifiers(session.qualifiers_json)
 const meaningful = Object.keys(q).filter(
  k => !k.startsWith("_") && q[k] != null && String(q[k]).trim() !== ""
 )
 if (meaningful.length > 0) return true
 if (["searching", "options_given"].includes(session.intent_status)) return true
 if (Number(session.turn_count || 0) >= 2) return true
 return false
}

function buildResumeCheckpoint(session) {
 return {
  intent_status: session.intent_status || "diagnosis",
  qualifier_step: Number(session.qualifier_step || 0),
  qualifiers_json: session.qualifiers_json || "{}",
  turn_count: Number(session.turn_count || 0),
  context: session.context || "",
  operation_mode: session.operation_mode || "recommend",
  monitor_target_brl: session.monitor_target_brl,
  monitor_alert_sent_on: session.monitor_alert_sent_on
 }
}

function restoreResumeCheckpoint(session) {
 try {
  const raw = session.resume_checkpoint_json
  if (!raw || !String(raw).trim()) return false
  const c = JSON.parse(raw)
  session.intent_status = c.intent_status || "diagnosis"
  session.qualifier_step = Number(c.qualifier_step || 0)
  session.qualifiers_json = c.qualifiers_json || "{}"
  session.turn_count = Number(c.turn_count || 0)
  session.context = c.context || ""
  session.operation_mode = c.operation_mode === "monitor" ? "monitor" : "recommend"
  session.monitor_target_brl =
   c.monitor_target_brl === null || c.monitor_target_brl === undefined
    ? null
    : Number(c.monitor_target_brl)
  session.monitor_alert_sent_on = c.monitor_alert_sent_on ?? null
  session.resume_checkpoint_json = ""
  return true
 } catch {
  return false
 }
}

function resetSessionNewJourney(session) {
 session.conversation_id = randomUUID()
 session.context = ""
 session.intent_status = "diagnosis"
 session.turn_count = 0
 session.qualifiers_json = "{}"
 session.qualifier_step = 0
 session.resume_checkpoint_json = ""
 session.operation_mode = "recommend"
 session.monitor_target_brl = null
 session.monitor_alert_sent_on = null
}

function parseResumeChoice(text) {
 const t = String(text || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .replace(/\s+/g, " ")
 if (!t) return null
 if (
  /(prefiro\s+(comecar|uma\s+nova)|quero\s+(comecar|uma\s+nova|uma\s+nova)|nao\s+(quero|vou)\s+continu)/i.test(
   t
  )
 )
  return "new"
 if (
  /(^|\b)(comecar\s+uma\s+nova|comecar\s+nova\b|uma\s+nova\s+conversa|so\s+nova\b|s[oó]\s+nova\b)(\b|$)/i.test(
   t
  )
 )
  return "new"
 if (
  /(^|\b)(nova\s+conversa|conversa\s+nova|recomecar|comecar\s+do\s+zero|do\s+zero|outra\s+conversa|limpar\s+tudo|reinici|apagar\s+tudo|falar\s+de\s+outra)(\b|$)/i.test(
   t
  )
 )
  return "new"
 if (/^nova[!.?]*$/i.test(t)) return "new"
 if (
  /(voltar|continuar|retomar|ultima|onde\s+p(ar|a)re|seguir|mesma\s+conversa|como\s+estavamos|\bseguimos\b)/i.test(
   t
  )
 )
  return "resume"
 if (/^[\s]*2[\s]*$/.test(t) || /^dois$/i.test(t)) return "new"
 if (/^[\s]*1[\s]*$/.test(t) || /^um$/i.test(t)) return "resume"
 return null
}

/** Depois de pedir confirmacao para conversa nova: sim = zera; nao = restaura checkpoint. */
function parseNewConversationConfirm(message) {
 const t = normalizeChatTokens(message)
 if (!t) return null
 if (
  /(volta|volto|\bcancela\b|onde\s+par(ou|amos)|voltar\s+onde|de\s+onde|ultima\s+conversa|prefiro\s+continu|mantenha|nao\s+quero\s+zerar|deixa\s+como)/i.test(
   t
  )
 )
  return "no"
 if (
  /^(sim|isso|aham|uhum|pode|ok|beleza|confirmo|com\s+certeza|zera|zerar|comeca\s+do\s+zero)(\b|[\s,!]|$)/i.test(
   t
  ) ||
  /^\s*sim\s*[!?.]*\s*$/i.test(t)
 )
  return "yes"
 if (/^(nao|nah|cancela)\b|^\s*nao\s*[!?.]*\s*$/i.test(t)) return "no"
 if (/^s$/i.test(t)) return "yes"
 if (/^n$/i.test(t)) return "no"
 return null
}

function qualifiersToContext(qualifiers) {
 const parts = []
 if (qualifiers.path_model)
  parts.push(
   `percurso: ${qualifiers.path_model === "modelo_em_mente" ? "ja tem modelo em mente" : "aberto a sugestoes"}`
  )
 parts.push(`orcamento: ${qualifiers.budget || "nao informado"}`)
 parts.push(`uso principal: ${qualifiers.primary_use || "nao informado"}`)
 parts.push(`bateria: ${qualifiers.battery_need || "nao informado"}`)
 parts.push(`armazenamento: ${qualifiers.storage || "nao informado"}`)
 return parts.join(", ")
}

function youtubeReviewSearchUrl(productTitle) {
 const q = `${(productTitle || "smartphone").trim()} review celular`
 return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
}

function shoppingFallbackUrl(productTitle) {
 const q = `${(productTitle || "smartphone").trim()} comprar`
 return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`
}

const TRANSPARENCY_FOOTER = `---
Transparencia: ranking por score (preco relativo + loja conhecida + armazenamento no titulo). Valida **Reclame Aqui**, prazo de entrega e nota da loja antes de pagar.
Links: busca publica; sem afiliado automatico neste MVP.`

function formatProductLinksMessage(phones, session) {
 if (!phones.length) return ""
 const lines = ["Links rapidos (ordenados por ranking; compra + review no YouTube):"]
 if (session && session.operation_mode === "monitor") {
  const alvo =
   session.monitor_target_brl !== null && session.monitor_target_brl !== undefined
    ? `R$ ${Number(session.monitor_target_brl).toFixed(2)}`
    : "nao definido"
  lines.push(`Modo monitoramento: rotina diaria checa precos. Seu alvo: ${alvo}.`)
  lines.push(
   "Quando algo ficar abaixo do alvo, te aviso (no maximo 1 vez por dia, mesmo dia)."
  )
 }
 phones.forEach((p, i) => {
  const n = i + 1
  const buy = p.link || shoppingFallbackUrl(p.model)
  const yt = p.review_youtube || youtubeReviewSearchUrl(p.model)
  const sc = p.rank_score !== undefined ? ` [score ${p.rank_score}]` : ""
  lines.push(`${n}) ${p.model}${sc}`)
  lines.push(`   Comprar: ${buy}`)
  lines.push(`   Review YouTube: ${yt}`)
  if (p.rank_reason) lines.push(`   Criterios: ${p.rank_reason}`)
 })
 lines.push(TRANSPARENCY_FOOTER)
 return lines.join("\n")
}

/*
========================================
EXTRAIR QUERY DE BUSCA
========================================
*/

async function extractSearchQuery(context){

 try{

  const completion = await openai.chat.completions.create({

   model:"gpt-4o-mini",

   messages:[
    {
     role:"system",
     content:"Extraia uma query curta para buscar smartphones e retorne JSON com a chave query."
    },
    {
     role:"user",
     content:`
Contexto do usuário:

${context}

Retorne somente JSON valido: {"query":"..."}.
`
    }
   ],
   response_format: { type: "json_object" }

  })

  const raw = completion.choices[0].message.content || "{}"
  const parsed = JSON.parse(raw)
  return (parsed.query || "").trim() || "smartphone"

 }catch(e){

  console.log("Erro parser query")

  return "smartphone"

 }

}

/*
========================================
BUSCA GOOGLE SHOPPING
========================================
*/

async function searchPhones(query){

 try{

  console.log("Buscando:", query)

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&tbm=shop&api_key=${SERPAPI_KEY}`

  const response = await http.get(url)

  const products = response.data.shopping_results || []

  const phones = products.slice(0,5).map((p) => {
   const model = p.title || "Smartphone"
   const link = p.link || p.product_link || shoppingFallbackUrl(model)
   return {
    model,
    price: p.price,
    store: p.source,
    link,
    review_youtube: youtubeReviewSearchUrl(model)
   }
  })

  console.log("Phones encontrados:",phones)

  return phones

 }catch(e){

  console.log("Erro busca:",e.message)

  return []

 }

}

/*
========================================
PROMPT CONCIERGE
========================================
*/

const conciergePrompt = `
Motor do Concierge (MVP v4.0) — voce e consultor elite em smartphones: **Custo Real** (beneficio financeiro) e **Seguranca**. Tom descontraido, charmoso, direto e atento a detalhes.

CANAL API (obrigatorio):
- Responda apenas com JSON valido: user_message, user_profile, top_recommendations, intent_status, turn_count.
- O usuario ve **somente** user_message: texto natural para Telegram, sem JSON, sem blocos de codigo, sem crases.
- Em user_message use **negrito** (asteriscos duplos) em nomes de aparelhos e precos; use linhas com • ou - para pros e contras quando fizer comparativo.
- Se ja existirem produtos na lista, NAO cole URLs em user_message (o sistema manda links em outra mensagem). Mantenha user_message ate ~8 linhas quando houver comparativo.

O — Objetivo: recomendacao tecnicamente forte, financeiramente otimizada e segura.

C — Contexto: nao somos comparador passivo. Antecipe frete, parcelas sem juros, cashback (Méliuz / Inter / Cuponomia quando fizer sentido), reputacao (Reclame Aqui / entregas) — use linguagem de alerta honesta; no MVP os dados de loja vêm da busca, entao cite como verificacao manual se nao tiver nota.

A — Acoes:
- Tom: **conversa de bar / consultor de confianca** — respire, ouça, reformule o que entendeu antes de puxar preco. Nao atropele o usuario.
- Diagnostico: use o historico; **uma** duvida ou reflexao por mensagem quando precisar; evite checklist e frases de call center.
- Custo total: compare a vista vs parcelado sem juros quando os precos da lista permitirem inferir (ex.: "10x de R$ X").
- Versus: quando sugerir 2 opcoes, pro/contra focando bateria real, camera, processamento.
- Se turn_count > 10 e intent_status ainda diagnosis, ou se o usuario repete duvida, sugira gentilmente: "Parece que estamos em duvida! Quer **recomecar do zero** ou prefere que eu chame a **Nathalia** (minha criadora humana) pra dar um pitaco aqui?"

N — Normas:
- Antigolpe: prefira lojas conhecidas (Amazon BR, ML, Magalu, Casas Bahia, KaBuM, Fast Shop, Ponto, oficiais). Marketplace so fabricante. Desconfie de preco irreais.
- Transparente: se a vista for pior mas parcelas sem juros mudam o jogo, diga isso.
- Fora de tema smartphone: recuse com charme breve.

E — Estilo de exemplo (nao copie literal): comparar duas lojas com parcelas, frete e nota; pro/contra curtos.

Modo sessao (operation_mode): recommend (fechar melhor opcao) ou monitor (rotina de precos, alvo — nao prometa compra automatica).

intent_status: diagnosis enquanto falta criterio; searching quando for buscar/ofertas; options_given quando listou opcoes fortes.
`

const diagnosisExtractPrompt = `
Voce **conduz** a conversa para entender o que a pessoa quer de verdade — nao e questionario, nem suporte nivel 1.

REGRAS DE OURO:
1) **Espelhe** o que a pessoa disse (meia frase bastante) antes de perguntar outra coisa — ela precisa sentir que foi ouvida.
2) Tom brasileiro, **mate a formalidade**: pode ser "beleza", "entendi", "faz sentido", mas sem ser brega.
3) **No maximo UMA** curiosidade nova por resposta — ou nenhuma, se ela ainda esta se abrindo. Nada de 3 perguntas em sequencia.
4) Proibido: listas numeradas de opcoes, "escolha A/B/C", "digite X", bloco de FAQ, tom de bot.
5) Se o usuario so cumprimentou ou esta vago, **convoque** ele com leveza (troca, problema com o celular atual, sonho de aparelho) — nao exija orcamento ja de cara.
6) **Prioridade "diagnosis"**: fique conversando ate ter **orcamento (ou flexivel) + alguma direcao** (modelo, uso, prioridade) OU muita conversa acumulada. Nao corra para "buscar ofertas".

qualifiers_patch (só trechos evidentes no que ela falou — pode ser {} vazio):
- path_model: "modelo_em_mente" | "explorar_opcoes"
- budget: "R$ ..." ou "flexivel"
- primary_use, battery_need, storage: como ja definido no sistema

intent_status:
- "diagnosis" — quase sempre.
- "searching" — **só** se ela deixou claro que quer ver precos/opcoes *agora* e o contexto ja tem orcamento ou flexivel **e** direcao de uso/modelo (ou conversa longa o bastante). Na duvida, "diagnosis".

JSON estrito: {"user_message":"...","qualifiers_patch":{},"intent_status":"diagnosis"|"searching"}
`

function diagnosisStageHint(turnCount) {
 const tc = Number(turnCount || 0)
 if (tc <= 2)
  return "Estagio: inicio — conheça a pessoa; nao cobre teto de preco se ela só entrou no assunto."
 if (tc <= 6)
  return "Estagio: meio — aprofunde uso real (foto, bateria, trabalho, jogo) com naturalidade."
 return "Estagio: maturo — se faltar só um detalhe, pode puxar com leveza; se ja deu pra montar perfil, pode encaminhar."
}

async function runFlexibleDiagnosis(message, session) {
 const completion = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
   { role: "system", content: diagnosisExtractPrompt },
   {
    role: "user",
    content: JSON.stringify({
     ultima_mensagem: message,
     historico: (session.context || "").slice(-4500),
     perfil_ja_extraido: parseQualifiers(session.qualifiers_json),
     turn_count: session.turn_count,
     guia_de_ritmo: diagnosisStageHint(session.turn_count),
     operation_mode: session.operation_mode || "recommend"
    })
   }
  ],
  response_format: { type: "json_object" }
 })
 const raw = completion.choices[0].message.content || "{}"
 const parsed = JSON.parse(raw)
 return {
  user_message:
   parsed.user_message ||
   "Oi — tô aqui pra te ajudar a achar o celular certo, sem pressa. O que te fez pensar em trocar ou em comprar um agora?",
  qualifiers_patch:
   parsed.qualifiers_patch && typeof parsed.qualifiers_patch === "object"
    ? parsed.qualifiers_patch
    : {},
  intent_status: parsed.intent_status === "searching" ? "searching" : "diagnosis"
 }
}

/*
========================================
IA CONVERSACIONAL
========================================
*/

async function runConcierge(message,session,phones){

 try{

  const completion = await openai.chat.completions.create({

   model:"gpt-4o-mini",

   messages:[

    {
     role:"system",
     content:conciergePrompt
    },

    {
     role:"user",
     content:`
conversation_id: ${session.conversation_id || "desconhecido"}
chat_id (Telegram): ${session.chat_id}

Mensagem:

${message}

Sessão (historico e estado — use context como linha do tempo da conversa):

${JSON.stringify(session)}

Produtos (ja ordenados por ranking; campos rank_score e rank_reason explicam o indice):

${JSON.stringify(phones)}

Retorne apenas JSON valido com:
{
 "user_message": "string",
 "user_profile": "string",
 "top_recommendations": [],
 "intent_status": "diagnosis|searching|options_given",
 "turn_count": number
}
`
    }

   ],
   response_format: { type: "json_object" }

  })

  const raw = completion.choices[0].message.content || "{}"
  const parsed = JSON.parse(raw)
  return {
   user_message: parsed.user_message || "Tenho uma opcao forte para voce. Vamos ajustar 2 detalhes?",
   user_profile: parsed.user_profile || "",
   top_recommendations: Array.isArray(parsed.top_recommendations) ? parsed.top_recommendations : [],
   intent_status: ["diagnosis", "searching", "options_given"].includes(parsed.intent_status)
    ? parsed.intent_status
    : session.intent_status || "diagnosis",
   turn_count: Number.isInteger(parsed.turn_count) ? parsed.turn_count : session.turn_count
  }

 }catch(e){

  console.log("Erro IA:",e.message)

  return {
   user_message: "Tive um problema rapido aqui. Me diga seu foco: camera, bateria ou preco?",
   user_profile: "",
   top_recommendations: [],
   intent_status: "diagnosis",
   turn_count: session.turn_count
  }

 }

}

/*
========================================
TELEGRAM
========================================
*/

function toTelegramHtml(text) {
 const s = String(text ?? "")
 const parts = s.split("**")
 return parts
  .map((p, i) => {
   const esc = p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   return i % 2 === 1 ? `<b>${esc}</b>` : esc
  })
  .join("")
}

async function sendTelegram(chatId, text) {
 const payload = {
  chat_id: chatId,
  text: toTelegramHtml(text),
  parse_mode: "HTML",
  disable_web_page_preview: true
 }
 try {
  await http.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload)
 } catch (e1) {
  try {
   await http.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text: String(text || "").slice(0, 4090),
    disable_web_page_preview: true
   })
  } catch (e2) {
   console.log("Erro Telegram", e2.message || e2)
   pushTelegramLog({
    chatId,
    text: "(falha ao enviar)",
    direction: "out",
    note: String(e2.message || e2).slice(0, 120)
   })
   return
  }
 }
 const preview = (text || "").slice(0, 800)
 pushTelegramLog({
  chatId,
  text: preview + ((text || "").length > 800 ? "…" : ""),
  direction: "out",
  note: "resposta bot"
 })
}

/*
========================================
LOG VIEWER (navegador)
========================================
*/

app.get("/logs", (req, res) => {
 if (LOG_VIEWER_SECRET && req.query.key !== LOG_VIEWER_SECRET) {
  return res.status(401).type("html").send("<p>401 — defina <code>LOG_VIEWER_SECRET</code> no .env e abra <code>/logs?key=SUA_CHAVE</code></p>")
 }
 res.type("html").send(formatLogPage(telegramMessageLog))
})

/*
========================================
WEBHOOK
========================================
*/

app.post("/webhook",async(req,res)=>{

 try{
  if (!isWebhookValid(req)) {
   return res.sendStatus(401)
  }

  const updateId = req.body.update_id
  if (markUpdateProcessed(updateId)) {
   return res.sendStatus(200)
  }

  const message=(req.body.message?.text || "").trim().slice(0, 1200)
  const chatId=req.body.message?.chat?.id

  if (!message || !chatId) {
   if (chatId && req.body.message) {
    pushTelegramLog({
     chatId,
     text: "(sem texto — mídia, sticker ou comando)",
     direction: "in",
     note: `update_id ${updateId}`
    })
   }
   return res.sendStatus(200)
  }

  console.log("Mensagem:",message)
  pushTelegramLog({
   chatId,
   text: message,
   direction: "in",
   note: `update_id ${updateId}`
  })

  const session = getSession(chatId)
  session.qualifiers_json = session.qualifiers_json || "{}"
  session.qualifier_step = Number(session.qualifier_step || 0)

  if (session.intent_status === "await_resume_confirm_new") {
   session.operation_mode = detectOperationMode(message, session.operation_mode || "recommend")
   const alvoConf = parseMonitorTargetBrl(message)
   if (alvoConf !== null) session.monitor_target_brl = alvoConf

   session.context = appendContext(session.context, message)
   session.turn_count++
   const conf = parseNewConversationConfirm(message)
   if (conf === "yes") {
    resetSessionNewJourney(session)
    session.context = appendContext("", message)
    session.turn_count = 1
    await sendTelegram(chatId, FLEX_NEW_CHAT_OPENER)
    saveSession(session)
    return res.sendStatus(200)
   }
   if (conf === "no") {
    const ok = restoreResumeCheckpoint(session)
    session.context = appendContext(session.context, message)
    if (!ok) {
     session.intent_status = "diagnosis"
     session.resume_checkpoint_json = ""
     await sendTelegram(
      chatId,
      "Sem problema — me diz por onde a gente segue: modelo ou faixa de preco?"
     )
     saveSession(session)
     return res.sendStatus(200)
    }
    await sendTelegram(chatId, "Beleza — **volto onde a gente parou.**")
    if (session.intent_status === "diagnosis")
     await sendTelegram(chatId, FLEX_DIAGNOSIS_RESUME)
    saveSession(session)
    return res.sendStatus(200)
   }
   await sendTelegram(
    chatId,
    "Voce tem **certeza** que quer **comecar do zero**? Responde **sim** pra zerar ou **nao** pra continuarmos de onde estavamos."
   )
   saveSession(session)
   return res.sendStatus(200)
  }

  if (session.intent_status === "await_resume_choice") {
   session.operation_mode = detectOperationMode(message, session.operation_mode || "recommend")
   const alvoResume = parseMonitorTargetBrl(message)
   if (alvoResume !== null) session.monitor_target_brl = alvoResume

   session.context = appendContext(session.context, message)
   session.turn_count++
   const choice = parseResumeChoice(message)
   if (choice === "new") {
    session.intent_status = "await_resume_confirm_new"
    await sendTelegram(
     chatId,
     "Entendi — **conversa nova.** Antes de apagar o que tinhamos: **voce tem certeza?** Responde **sim** pra comecar do zero ou **nao** pra eu **voltar onde paramos**."
    )
    saveSession(session)
    return res.sendStatus(200)
   }
   if (choice === "resume") {
    const ok = restoreResumeCheckpoint(session)
    session.context = appendContext(session.context, message)
    if (!ok) {
     session.intent_status = "diagnosis"
     session.resume_checkpoint_json = ""
     await sendTelegram(
      chatId,
      "Nao achei o estado anterior. Me diz por onde comecamos: orcamento aproximado ou modelo que voce quer?"
     )
     saveSession(session)
     return res.sendStatus(200)
    }
    await sendTelegram(chatId, "Beleza, seguimos de onde paramos.")
    if (session.intent_status === "diagnosis") await sendTelegram(chatId, FLEX_DIAGNOSIS_RESUME)
    saveSession(session)
    return res.sendStatus(200)
   }
   await sendTelegram(
    chatId,
    "Pode dizer de um jeito natural: **continuar** a conversa anterior ou **comecar uma nova**."
   )
   saveSession(session)
   return res.sendStatus(200)
  }

  session.operation_mode = detectOperationMode(message, session.operation_mode || "recommend")
  const alvo = parseMonitorTargetBrl(message)
  if (alvo !== null) session.monitor_target_brl = alvo

  if (isCasualGreeting(message) && hasResumableConversation(session)) {
   const checkpoint = buildResumeCheckpoint(session)
   session.resume_checkpoint_json = JSON.stringify(checkpoint)
   session.intent_status = "await_resume_choice"
   session.context = appendContext(session.context, message)
   session.turn_count = Number(session.turn_count || 0) + 1
   await sendTelegram(
    chatId,
    "Olá! Gostaria de voltar para a nossa última conversa ou prefere começar uma conversa nova?"
   )
   saveSession(session)
   return res.sendStatus(200)
  }

  session.context = appendContext(session.context, message)

  session.turn_count++

  if (session.intent_status === "diagnosis") {
   const qualifiers = parseQualifiers(session.qualifiers_json)
   let diag
   try {
    diag = await runFlexibleDiagnosis(message, session)
   } catch (e) {
    console.log("Erro diagnosis flex:", e.message)
    diag = {
     user_message:
      "Opa, perdi o fio por aqui — me conta de novo o que voce busca, do seu jeito, que eu acompanho.",
     qualifiers_patch: {},
     intent_status: "diagnosis"
    }
   }
   mergeQualifiersFromPatch(qualifiers, diag.qualifiers_patch, message)
   session.qualifiers_json = JSON.stringify(qualifiers)
   let nextIntent = diag.intent_status === "searching" ? "searching" : "diagnosis"
   if (nextIntent === "searching" && !qualifiersRoughlyReadyForSearch(qualifiers, session)) {
    nextIntent = "diagnosis"
   }
   session.intent_status = nextIntent
   if (nextIntent === "searching") {
    session.qualifier_step = QUALIFIER_DONE_STEP
    session.context = appendContext(
     session.context,
     `perfil qualificado: ${qualifiersToContext(qualifiers)}`
    )
    saveSession(session)
   } else {
    await sendTelegram(chatId, diag.user_message)
    saveSession(session)
    return res.sendStatus(200)
   }
  }

  let phones=[]

  if(session.intent_status==="searching"){

   const query=await extractSearchQuery(session.context)

   phones = await searchPhones(query)
   phones = rankAndEnrichPhones(phones, parseQualifiers(session.qualifiers_json))
   savePriceSnapshot(chatId, query, phones)
   if (!phones.length) {
    session.intent_status = "diagnosis"
    session.qualifier_step = 0
    saveSession(session)
    await sendTelegram(
     chatId,
     "Nao achei oferta boa nessa rodada — manda **modelo ou faixa em reais** (ou descreve o uso) que eu busco de novo, bem solto."
    )
    return res.sendStatus(200)
   }

  }

  const aiResponse=await runConcierge(message,session,phones)
  session.intent_status = aiResponse.intent_status
  saveSession(session)
  await sendTelegram(chatId,aiResponse.user_message)

  if (phones.length > 0) {
   const linksMsg = formatProductLinksMessage(phones, session)
   if (linksMsg) await sendTelegram(chatId, linksMsg)
  }

  res.sendStatus(200)

 }catch(e){

  console.log("Erro webhook:",e.message)

  res.sendStatus(200)

 }

})

async function runHardToBeatRoutine() {
 try {
  const rows = db.prepare("SELECT chat_id, context, qualifiers_json FROM sessions WHERE context <> ''").all()
  if (!rows.length) return

  for (const row of rows) {
   const query = await extractSearchQuery(row.context)
   const raw = await searchPhones(query)
   const phones = rankAndEnrichPhones(raw, parseQualifiers(row.qualifiers_json || "{}"))
   savePriceSnapshot(row.chat_id, query, phones)
  }

  console.log(`[HARD_TO_BEAT] rotina concluida para ${rows.length} usuarios`)
 } catch (e) {
  console.log("[HARD_TO_BEAT] erro:", e.message)
 }
}

async function runMonitorTargetAlerts() {
 try {
  const today = todayKeySaoPaulo()
  const sessions = db
   .prepare(
    `SELECT chat_id, context, monitor_target_brl, qualifiers_json
     FROM sessions
     WHERE operation_mode = 'monitor'
     AND monitor_target_brl IS NOT NULL
     AND monitor_target_brl > 0
     AND (monitor_alert_sent_on IS NULL OR monitor_alert_sent_on <> ?)`
   )
   .all(today)

  for (const s of sessions) {
   const query = await extractSearchQuery(s.context || "")
   const raw = await searchPhones(query)
   const phones = rankAndEnrichPhones(raw, parseQualifiers(s.qualifiers_json || "{}"))
   const prices = phones.map((p) => p.price_numeric).filter((n) => n !== null && n > 0)
   if (!prices.length) continue
   const minP = Math.min(...prices)
   const alvo = Number(s.monitor_target_brl)
   if (minP <= alvo) {
    await sendTelegram(
     s.chat_id,
     `Alerta Concierge: vi ofertas a partir de R$ ${minP.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} (seu alvo: R$ ${alvo.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}). Volte no chat e peca "buscar de novo" para links atualizados.`
    )
    db.prepare("UPDATE sessions SET monitor_alert_sent_on = ? WHERE chat_id = ?").run(today, s.chat_id)
   }
  }

  if (sessions.length) console.log(`[MONITOR_ALERT] checados ${sessions.length} usuario(s) com alvo`)
 } catch (e) {
  console.log("[MONITOR_ALERT] erro:", e.message)
 }
}

cron.schedule(
 "0 9 * * *",
 async () => {
  await runHardToBeatRoutine()
  await runMonitorTargetAlerts()
 },
 { timezone: "America/Sao_Paulo" }
)

if (process.env.RUN_HARD_TO_BEAT_ON_STARTUP === "true") {
 runHardToBeatRoutine().then(() => runMonitorTargetAlerts())
}

/*
========================================
SERVIDOR
========================================
*/

app.listen(PORT, () => {
 console.log(`Servidor rodando na porta ${PORT}`)
 console.log(`Log Telegram (navegador): http://localhost:${PORT}/logs`)
 if (LOG_VIEWER_SECRET) console.log("Log protegido: use /logs?key=...")
})