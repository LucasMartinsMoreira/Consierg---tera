require("dotenv").config()

const { randomUUID } = require("crypto")
const express = require("express")
const axios = require("axios")
const cron = require("node-cron")
const db = require("./lib/db")
const agents = require("./lib/agents")

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

const http = axios.create({
 timeout: 15000
})

const getSession = db.getSession.bind(db)
const saveSession = db.saveSession.bind(db)

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

const markUpdateProcessed = db.markUpdateProcessed.bind(db)
const savePriceSnapshot = db.savePriceSnapshot.bind(db)

function appendContext(context, message) {
 const next = `${context}\n${message}`.trim()
 return next.length > MAX_CONTEXT_CHARS ? next.slice(-MAX_CONTEXT_CHARS) : next
}

function applyModeAndTarget(session, message) {
 session.operation_mode = detectOperationMode(message, session.operation_mode || "recommend")
 const alvo = parseMonitorTargetBrl(message)
 if (alvo !== null) session.monitor_target_brl = alvo
}

function isWebhookValid(req) {
 if (!TELEGRAM_WEBHOOK_SECRET) return true
 const token = req.headers["x-telegram-bot-api-secret-token"]
 return token === TELEGRAM_WEBHOOK_SECRET
}

const QUALIFIER_DONE_STEP = 99

const FLEX_DIAGNOSIS_RESUME =
 "Otimo, retomando — sem pressa. O que **mais importa** pra voce nesse celular agora?"

const FLEX_NEW_CHAT_OPENER =
 "Combinado, comecamos de novo. Me conta **com calma** o cenario: troca o que ta quebrado, upgrade, presente… o que trouxe voce aqui?"

const META_WHO_REPLY =
 "Sou o **Concierge**: te ajudo a escolher smartphone com **custo real** e segurança (loja confiavel, parcelas, o que importa pra voce). **Nao** sou formulario — manda ver o que precisa, ou diz **reiniciar** se quiser zerar o papo."

const UNCERTAIN_CONCIERGE_LINE =
 "Putz, me enrolei aqui! **Nao tenho essa informacao agora.** Vamos **retomar de onde paramos** ou prefere **resetar o papo**? (Pode escrever **reiniciar**.)"

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
 const ctx = session.context || ""
 const bud = q.budget ? String(q.budget).trim() : ""
 const hasBudget = Boolean(bud)
 const hasFlex = /flexivel/i.test(bud)
 const hasNumericBudget = /R\$\s*[\d.]+/i.test(bud) || /\d{3,}/.test(bud)
 const hasPath = Boolean(q.path_model)
 const hasUse = Boolean(q.primary_use || q.battery_need || q.storage)
 const tc = Number(session.turn_count || 0)
 const ctxLen = ctx.length
 const modeloDireto =
  /(quero (o |a )?(galaxy|iphone|pixel|redmi|poco|motorola)|\bS2[0-9]\b|iphone\s*(1[0-7]|pro|max|mini|se)|galaxy\s+[az]\s*\d|note\s*\d)/i.test(
   ctx
  )
 if (modeloDireto && (hasBudget || hasFlex || tc >= 1)) return true
 if (!hasBudget) return false
 if (hasFlex && !(hasPath || hasUse) && tc < 8) return false
 if ((hasNumericBudget || hasFlex) && (hasPath || hasUse)) return true
 if ((hasNumericBudget || hasFlex) && ctxLen >= 500) return true
 if (hasBudget && tc >= 12) return true
 return false
}

function parseHardInterrupt(text) {
 const t = normalizeChatTokens(text)
 if (!t || t.length > 120) return null
 if (
  /^(reiniciar|recomecar|comecar de novo|comecar do zero|zerar tudo|reset|resetar|limpar tudo|apagar tudo|nova conversa|quero recomecar|quero reiniciar)$/i.test(
   t
  )
 )
  return "restart"
 if (
  /^(reinicia|recomeca|zera|reseta)\b/i.test(t) &&
  t.length < 40
 )
  return "restart"
 if (/(mudar de assunto|outro assunto|esquece o que (eu )?disse|para com isso|cancela tudo)(\b|$)/i.test(t))
  return "restart"
 if (
  /(quem e voce|quem es|o que voce faz|o que vc faz|pra que (voce|vc) serve|o que e (esse|o) bot|voce e (um )?bot|como (voce|vc) funciona)/i.test(
   t
  )
 )
  return "meta_who"
 return null
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
 const t = normalizeChatTokens(text)
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

async function extractSearchQuery(context, traceCtx = {}) {
 try {
  const result = await agents.runSearchQueryAgent(context)
  return (result.query || "").trim() || "smartphone"
 } catch (e) {
  console.log("Erro parser query:", e.message)
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
O — OBJETIVO: Consultor **elite** em smartphones. Sucesso = conversa **fluida**; **priorize a vontade do usuario** sobre qualquer roteiro tecnico.

C — CONTEXTO: Guia **proativo**, nao formulario. Se o usuario mudar de assunto ou pedir para recomecar, o fluxo ja pode ter sido tratado — aqui continue **ouvindo** e respondendo a ultima mensagem de verdade.

CANAL API:
- Responda so JSON: user_message, user_profile, top_recommendations, intent_status, turn_count.
- user_message = **texto natural** para Telegram (sem JSON, sem codigo). **Negrito** em aparelhos e precos; bullets para pros/contras.
- Sem URLs na user_message se ja houver produtos na lista (o app envia links a parte).

A — ACOES:
- Se se perder ou for tema fora do escopo: algo como "**Putz, me enrolei aqui!** Nao tenho essa informacao agora. Vamos **retomar** ou **resetar o papo**?"
- **Custo e seguranca**: à vista vs parcelado sem juros quando der; cashback/frete quando fizer sentido; **Reclame Aqui** / reputacao das lojas (MVP: validar na pratica se nao tiver nota na lista).
- Comparativo: pro/contra em bateria real, camera, performance.

N — NORMAS:
- **Antigolpe**: lojas oficiais e grandes varejistas (Amazon BR, Magalu, Mercado Livre, Casas Bahia, KaBuM, Fast Shop, Ponto, etc.). Marketplace so se for logica de fabricante.
- Se **3 impasses** seguidos (sem avanco), sugira a **Nathalia** (criadora humana) com simpatia.

S — SAIDA: charmoso, direto. **Nunca** ignore uma frase do usuario para forcar pergunta de diagnostico.

Modo operation_mode: recommend | monitor (rotina de precos; sem prometer compra automatica).

intent_status: diagnosis | searching | options_given como ja definido.
`

const diagnosisExtractPrompt = `
O — OBJETIVO: Mesmo do Concierge — conversa fluida; **priorize o pedido atual** do usuario, nao um script.

C — CONTEXTO: **Nao e formulario.** Comandos tipo "reiniciar" ou "quem e voce?" o backend pode tratar antes; se a mensagem ainda for sobre isso, responda **humanamente** e convide a seguir.

A — ACOES:
1) **Escuta ativa (prioridade 1):** **Nunca ignore** o que a pessoa disse so para encaixar pergunta de diagnostico — cite ou responda primeiro.
2) **Diagnostico adaptativo:** vago ("quero um celular") → estilo de vida, curiosidade leve. **Direto** ("quero o S23") → menos rodeio; caminhe para **analise de custo e seguranca** (intent "searching" quando ja der pra buscar ofertas).
3) **Desconhecimento / fora do escopo:** use ideia de: "${UNCERTAIN_CONCIERGE_LINE}" (pode variar o texto, mantenha o tom).
4) Se **impasse_rodadas** no payload for >= 3: inclua oferta gentil de falar com a **Nathalia** (criadora).

qualifiers_patch (so o explicito na mensagem/historico):
- path_model: "modelo_em_mente" | "explorar_opcoes"
- budget: "R$ ..." ou "flexivel"
- primary_use, battery_need, storage (valores do sistema)

intent_status: "diagnosis" na duvida. "searching" se usuario **direto** com modelo claro ou contexto ja fechado para buscar ofertas.

JSON: {"user_message":"...","qualifiers_patch":{},"intent_status":"diagnosis"|"searching"}
`

function diagnosisStageHint(turnCount) {
 const tc = Number(turnCount || 0)
 if (tc <= 2)
  return "Estagio: inicio — conheça a pessoa; nao cobre teto de preco se ela só entrou no assunto."
 if (tc <= 6)
  return "Estagio: meio — aprofunde uso real (foto, bateria, trabalho, jogo) com naturalidade."
 return "Estagio: maturo — se faltar só um detalhe, pode puxar com leveza; se ja deu pra montar perfil, pode encaminhar."
}

async function runFlexibleDiagnosis(message, session, impasseRodadas = 0) {
 const userPayload = JSON.stringify({
  ultima_mensagem: message,
  historico: (session.context || "").slice(-4500),
  perfil_ja_extraido: parseQualifiers(session.qualifiers_json),
  turn_count: session.turn_count,
  impasse_rodadas: Number(impasseRodadas || 0),
  guia_de_ritmo: diagnosisStageHint(session.turn_count),
  operation_mode: session.operation_mode || "recommend"
 })
 const result = await agents.runDiagnosisAgent(diagnosisExtractPrompt, userPayload)
 return {
  user_message: result.user_message ||
   "Oi — tô aqui pra te ajudar a achar o celular certo, sem pressa. O que te fez pensar em trocar ou em comprar um agora?",
  qualifiers_patch: result.qualifiers_patch || {},
  intent_status: result.intent_status === "searching" ? "searching" : "diagnosis"
 }
}

/*
========================================
IA CONVERSACIONAL
========================================
*/

async function runConcierge(message, session, phones) {
 try {
  const userPayload = `conversation_id: ${session.conversation_id || "desconhecido"}
chat_id (Telegram): ${session.chat_id}

Mensagem:

${message}

Sessão (historico e estado — use context como linha do tempo da conversa):

${JSON.stringify(session)}

Produtos (ja ordenados por ranking; campos rank_score e rank_reason explicam o indice):

${JSON.stringify(phones)}`

  const result = await agents.runConciergeAgent(conciergePrompt, userPayload)
  return {
   user_message: result.user_message || "Tenho uma opcao forte para voce. Vamos ajustar 2 detalhes?",
   user_profile: result.user_profile || "",
   top_recommendations: result.top_recommendations || [],
   intent_status: ["diagnosis", "searching", "options_given"].includes(result.intent_status)
    ? result.intent_status
    : session.intent_status || "diagnosis",
   turn_count: Number.isInteger(result.turn_count) ? result.turn_count : session.turn_count
  }
 } catch (e) {
  console.log("Erro IA:", e.message)
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
  if (await markUpdateProcessed(updateId)) {
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

  const session = await getSession(chatId)

  const interrupt = parseHardInterrupt(message)
  if (interrupt === "restart") {
   resetSessionNewJourney(session)
   session.context = appendContext("", message)
   session.turn_count = 1
   await sendTelegram(chatId, "Recomeçando agora! **Vamos do zero.**")
   await sendTelegram(chatId, FLEX_NEW_CHAT_OPENER)
   await saveSession(session)
   return res.sendStatus(200)
  }
  if (interrupt === "meta_who") {
   session.context = appendContext(session.context, message)
   session.turn_count = Number(session.turn_count || 0) + 1
   await sendTelegram(chatId, META_WHO_REPLY)
   await saveSession(session)
   return res.sendStatus(200)
  }

  if (session.intent_status === "await_resume_confirm_new") {
   applyModeAndTarget(session, message)
   session.context = appendContext(session.context, message)
   session.turn_count++
   const conf = parseNewConversationConfirm(message)
   if (conf === "yes") {
    resetSessionNewJourney(session)
    session.context = appendContext("", message)
    session.turn_count = 1
    await sendTelegram(chatId, FLEX_NEW_CHAT_OPENER)
    await saveSession(session)
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
     await saveSession(session)
     return res.sendStatus(200)
    }
    await sendTelegram(chatId, "Beleza — **volto onde a gente parou.**")
    if (session.intent_status === "diagnosis")
     await sendTelegram(chatId, FLEX_DIAGNOSIS_RESUME)
    await saveSession(session)
    return res.sendStatus(200)
   }
   await sendTelegram(
    chatId,
    "Voce tem **certeza** que quer **comecar do zero**? Responde **sim** pra zerar ou **nao** pra continuarmos de onde estavamos."
   )
   await saveSession(session)
   return res.sendStatus(200)
  }

  if (session.intent_status === "await_resume_choice") {
   applyModeAndTarget(session, message)
   session.context = appendContext(session.context, message)
   session.turn_count++
   const choice = parseResumeChoice(message)
   if (choice === "new") {
    session.intent_status = "await_resume_confirm_new"
    await sendTelegram(
     chatId,
     "Entendi — **conversa nova.** Antes de apagar o que tinhamos: **voce tem certeza?** Responde **sim** pra comecar do zero ou **nao** pra eu **voltar onde paramos**."
    )
    await saveSession(session)
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
     await saveSession(session)
     return res.sendStatus(200)
    }
    await sendTelegram(chatId, "Beleza, seguimos de onde paramos.")
    if (session.intent_status === "diagnosis") await sendTelegram(chatId, FLEX_DIAGNOSIS_RESUME)
    await saveSession(session)
    return res.sendStatus(200)
   }
   await sendTelegram(
    chatId,
    "Pode dizer de um jeito natural: **continuar** a conversa anterior ou **comecar uma nova**."
   )
   await saveSession(session)
   return res.sendStatus(200)
  }

  applyModeAndTarget(session, message)

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
   await saveSession(session)
   return res.sendStatus(200)
  }

  session.context = appendContext(session.context, message)

  session.turn_count++

  if (session.intent_status === "diagnosis") {
   const qualifiers = parseQualifiers(session.qualifiers_json)
   qualifiers._meta =
    qualifiers._meta && typeof qualifiers._meta === "object" ? qualifiers._meta : {}
   const impasseBefore = Number(qualifiers._meta.diagnosis_impasse || 0)
   const beforeSnap = {}
   for (const k of ["path_model", "budget", "primary_use", "battery_need", "storage"]) {
    beforeSnap[k] = qualifiers[k]
   }
   let diag
   try {
    diag = await runFlexibleDiagnosis(message, session, impasseBefore)
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
   const progressed = ["path_model", "budget", "primary_use", "battery_need", "storage"].some(
    k => qualifiers[k] !== beforeSnap[k]
   )
   let nextIntent = diag.intent_status === "searching" ? "searching" : "diagnosis"
   if (nextIntent === "searching" && !qualifiersRoughlyReadyForSearch(qualifiers, session))
    nextIntent = "diagnosis"
   if (nextIntent === "searching") {
    qualifiers._meta.diagnosis_impasse = 0
   } else {
    qualifiers._meta.diagnosis_impasse = progressed ? 0 : impasseBefore + 1
   }
   session.qualifiers_json = JSON.stringify(qualifiers)
   session.intent_status = nextIntent
   if (nextIntent === "searching") {
    session.qualifier_step = QUALIFIER_DONE_STEP
    session.context = appendContext(
     session.context,
     `perfil qualificado: ${qualifiersToContext(qualifiers)}`
    )
    await saveSession(session)
   } else {
    await sendTelegram(chatId, diag.user_message)
    await saveSession(session)
    return res.sendStatus(200)
   }
  }

  let phones=[]

  if(session.intent_status==="searching"){

   const query = await extractSearchQuery(session.context, {
    chatId: session.chat_id,
    conversationId: session.conversation_id
   })

   phones = await searchPhones(query)
   phones = rankAndEnrichPhones(phones, parseQualifiers(session.qualifiers_json))
   await savePriceSnapshot(chatId, query, phones)
   if (!phones.length) {
    session.intent_status = "diagnosis"
    session.qualifier_step = 0
    await saveSession(session)
    await sendTelegram(
     chatId,
     "Nao achei oferta boa nessa rodada — manda **modelo ou faixa em reais** (ou descreve o uso) que eu busco de novo, bem solto."
    )
    return res.sendStatus(200)
   }

  }

  const aiResponse=await runConcierge(message,session,phones)
  session.intent_status = aiResponse.intent_status
  await saveSession(session)
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
  const rows = await db.getAllSessionsForCron()
  if (!rows.length) return

  await Promise.all(rows.map(async (row) => {
   const query = await extractSearchQuery(row.context, { chatId: row.chat_id })
   const raw = await searchPhones(query)
   const phones = rankAndEnrichPhones(raw, parseQualifiers(row.qualifiers_json || "{}"))
   await savePriceSnapshot(row.chat_id, query, phones)
  }))

  console.log(`[HARD_TO_BEAT] rotina concluida para ${rows.length} usuarios`)
 } catch (e) {
  console.log("[HARD_TO_BEAT] erro:", e.message)
 }
}

async function runMonitorTargetAlerts() {
 try {
  const today = todayKeySaoPaulo()
  const sessions = await db.getMonitorSessions(today)

  await Promise.all(sessions.map(async (s) => {
   const query = await extractSearchQuery(s.context || "", { chatId: s.chat_id })
   const raw = await searchPhones(query)
   const phones = rankAndEnrichPhones(raw, parseQualifiers(s.qualifiers_json || "{}"))
   const prices = phones.map((p) => p.price_numeric).filter((n) => n !== null && n > 0)
   if (!prices.length) return
   const minP = Math.min(...prices)
   const alvo = Number(s.monitor_target_brl)
   if (minP <= alvo) {
    await sendTelegram(
     s.chat_id,
     `Alerta Concierge: vi ofertas a partir de R$ ${minP.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} (seu alvo: R$ ${alvo.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}). Volte no chat e peca "buscar de novo" para links atualizados.`
    )
    await db.updateMonitorAlertSentOn(s.chat_id, today)
   }
  }))

  if (sessions.length) console.log(`[MONITOR_ALERT] checados ${sessions.length} usuario(s) com alvo`)
 } catch (e) {
  console.log("[MONITOR_ALERT] erro:", e.message)
 }
}

/*
========================================
CRON — rota HTTP para Vercel Cron Jobs (/api/cron)
========================================
*/
app.get("/api/cron", async (req, res) => {
 if (
  process.env.CRON_SECRET &&
  req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
 ) {
  return res.status(401).json({ error: "Unauthorized" })
 }
 try {
  await Promise.all([runHardToBeatRoutine(), runMonitorTargetAlerts()])
  res.json({ ok: true })
 } catch (e) {
  console.log("[CRON] erro:", e.message)
  res.status(500).json({ error: e.message })
 }
})

/*
========================================
SERVIDOR — local dev ou Vercel
========================================
*/

if (require.main === module) {
 cron.schedule(
  "0 9 * * *",
  async () => {
   await Promise.all([runHardToBeatRoutine(), runMonitorTargetAlerts()])
  },
  { timezone: "America/Sao_Paulo" }
 )

 if (process.env.RUN_HARD_TO_BEAT_ON_STARTUP === "true") {
  Promise.all([runHardToBeatRoutine(), runMonitorTargetAlerts()])
 }

 app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
  console.log(`Log Telegram (navegador): http://localhost:${PORT}/logs`)
  if (LOG_VIEWER_SECRET) console.log("Log protegido: use /logs?key=...")
 })
}

module.exports = app
