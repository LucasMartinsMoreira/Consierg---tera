require("dotenv").config()

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
const PORT = Number(process.env.PORT || 3000)
const MAX_CONTEXT_CHARS = 6000

const openai = new OpenAI({
 apiKey: process.env.OPENAI_API_KEY
})

const http = axios.create({
 timeout: 15000
})

const db = new Database("concierge.db")
db.pragma("journal_mode = WAL")
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
 chat_id TEXT PRIMARY KEY,
 context TEXT NOT NULL DEFAULT '',
 intent_status TEXT NOT NULL DEFAULT 'diagnosis',
 turn_count INTEGER NOT NULL DEFAULT 0,
 qualifiers_json TEXT NOT NULL DEFAULT '{}',
 qualifier_step INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 chat_id TEXT NOT NULL,
 query TEXT NOT NULL,
 model TEXT NOT NULL,
 price TEXT,
 store TEXT,
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

const upsertSessionStmt = db.prepare(`
INSERT INTO sessions (chat_id, context, intent_status, turn_count, qualifiers_json, qualifier_step, updated_at)
VALUES (@chat_id, @context, @intent_status, @turn_count, @qualifiers_json, @qualifier_step, CURRENT_TIMESTAMP)
ON CONFLICT(chat_id) DO UPDATE SET
 context = excluded.context,
 intent_status = excluded.intent_status,
 turn_count = excluded.turn_count,
 qualifiers_json = excluded.qualifiers_json,
 qualifier_step = excluded.qualifier_step,
 updated_at = CURRENT_TIMESTAMP;
`)

function getSession(chatId) {
 const row = db
  .prepare("SELECT chat_id, context, intent_status, turn_count, qualifiers_json, qualifier_step FROM sessions WHERE chat_id = ?")
  .get(String(chatId))

 if (row) return row

 const session = {
  chat_id: String(chatId),
  context: "",
  intent_status: "diagnosis",
  turn_count: 0,
  qualifiers_json: "{}",
  qualifier_step: 0
 }

 upsertSessionStmt.run(session)
 return session
}

function saveSession(session) {
 upsertSessionStmt.run({
  chat_id: String(session.chat_id),
  context: session.context || "",
  intent_status: session.intent_status || "diagnosis",
  turn_count: Number(session.turn_count || 0),
  qualifiers_json: session.qualifiers_json || "{}",
  qualifier_step: Number(session.qualifier_step || 0)
 })
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
INSERT INTO price_history (chat_id, query, model, price, store)
VALUES (@chat_id, @query, @model, @price, @store)
`)
 const tx = db.transaction((items) => {
  for (const item of items) {
   insert.run({
    chat_id: String(chatId),
    query,
    model: item.model || "Modelo nao informado",
    price: item.price || "",
    store: item.store || ""
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

const SALES_QUESTIONS = [
 { key: "budget", question: "Perfeito. Qual seu teto de investimento? Ex: ate R$ 3.000." },
 { key: "primary_use", question: "Top. Seu foco e camera, jogos, trabalho ou uso geral?" },
 { key: "battery_need", question: "Voce precisa de bateria para o dia todo pesado? (sim/nao)" },
 { key: "storage", question: "Quanto armazenamento voce quer? 128, 256, 512 ou 1TB?" }
]

function parseQualifiers(raw) {
 try {
  const parsed = JSON.parse(raw || "{}")
  return typeof parsed === "object" && parsed ? parsed : {}
 } catch {
  return {}
 }
}

function parseQualifierAnswer(key, message) {
 const text = (message || "").trim()
 const lower = text.toLowerCase()
 if (!text) return null

 if (key === "budget") {
  const digits = lower.replace(/[^\d]/g, "")
  if (!digits) return null
  return `R$ ${Number(digits).toLocaleString("pt-BR")}`
 }

 if (key === "primary_use") {
  if (/(camera|foto|video)/.test(lower)) return "camera"
  if (/(jogo|games|fps)/.test(lower)) return "jogos"
  if (/(trabalho|produtividade|office)/.test(lower)) return "trabalho"
  return "uso geral"
 }

 if (key === "battery_need") {
  if (/(sim|muito|bastante)/.test(lower)) return "alta"
  if (/(nao|não|normal)/.test(lower)) return "normal"
  return null
 }

 if (key === "storage") {
  if (/(1tb|1024)/.test(lower)) return "1TB"
  if (/(512)/.test(lower)) return "512GB"
  if (/(256)/.test(lower)) return "256GB"
  if (/(128)/.test(lower)) return "128GB"
  return null
 }

 return null
}

function qualifiersToContext(qualifiers) {
 return [
  `orcamento: ${qualifiers.budget || "nao informado"}`,
  `uso principal: ${qualifiers.primary_use || "nao informado"}`,
  `bateria: ${qualifiers.battery_need || "nao informado"}`,
  `armazenamento: ${qualifiers.storage || "nao informado"}`
 ].join(", ")
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

  const phones = products.slice(0,5).map(p=>({

   model:p.title,
   price:p.price,
   store:p.source

  }))

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
Voce e um concierge especialista em smartphones no tom de vendedor premium.
Seja curto, pratico e direto. Maximo de 4 linhas na resposta ao usuario.
Fale como vendedor humano, sem texto tecnico desnecessario.
Sempre confirme o criterio principal do cliente antes de fechar recomendacao.

Antes de recomendar produtos, faça perguntas sobre:

- fotografia
- bateria
- jogos
- armazenamento

Somente quando tiver informacoes suficientes
defina intent_status = searching.
`

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
Mensagem:

${message}

Sessão:

${JSON.stringify(session)}

Produtos:

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

async function sendTelegram(chatId,text){

 try{

  await http.post(

   `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,

   {
    chat_id:chatId,
    text:text
   }

  )

 }catch(e){

  console.log("Erro Telegram")

 }

}

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

  if(!message || !chatId) return res.sendStatus(200)

  console.log("Mensagem:",message)

  const session = getSession(chatId)
  session.context = appendContext(session.context, message)

  session.turn_count++
  session.qualifiers_json = session.qualifiers_json || "{}"
  session.qualifier_step = Number(session.qualifier_step || 0)

  if (session.intent_status === "diagnosis" && session.qualifier_step < SALES_QUESTIONS.length) {
   const qualifiers = parseQualifiers(session.qualifiers_json)
   const currentQuestion = SALES_QUESTIONS[session.qualifier_step]
   const parsedAnswer = parseQualifierAnswer(currentQuestion.key, message)

   if (session.turn_count === 1 && !parsedAnswer) {
    await sendTelegram(chatId, "Fechado. Vou te achar a melhor oferta com 4 perguntas rapidas.")
    await sendTelegram(chatId, SALES_QUESTIONS[0].question)
    saveSession(session)
    return res.sendStatus(200)
   }

   if (parsedAnswer) {
    qualifiers[currentQuestion.key] = parsedAnswer
    session.qualifier_step += 1
    session.qualifiers_json = JSON.stringify(qualifiers)
   }

   if (session.qualifier_step < SALES_QUESTIONS.length) {
    await sendTelegram(chatId, SALES_QUESTIONS[session.qualifier_step].question)
    saveSession(session)
    return res.sendStatus(200)
   }

   session.intent_status = "searching"
   session.context = appendContext(session.context, `perfil qualificado: ${qualifiersToContext(qualifiers)}`)
  }

  let phones=[]

  if(session.intent_status==="searching"){

   const query=await extractSearchQuery(session.context)

   phones=await searchPhones(query)
   savePriceSnapshot(chatId, query, phones)
   if (!phones.length) {
    session.intent_status = "diagnosis"
    saveSession(session)
    await sendTelegram(chatId, "Nao achei oferta forte agora. Me passe faixa de preco e prioridade em 1 frase.")
    return res.sendStatus(200)
   }

  }

  const aiResponse=await runConcierge(message,session,phones)
  session.intent_status = aiResponse.intent_status
  saveSession(session)
  await sendTelegram(chatId,aiResponse.user_message)

  res.sendStatus(200)

 }catch(e){

  console.log("Erro webhook:",e.message)

  res.sendStatus(200)

 }

})

async function runHardToBeatRoutine() {
 try {
  const rows = db.prepare("SELECT chat_id, context FROM sessions WHERE context <> ''").all()
  if (!rows.length) return

  for (const row of rows) {
   const query = await extractSearchQuery(row.context)
   const phones = await searchPhones(query)
   savePriceSnapshot(row.chat_id, query, phones)
  }

  console.log(`[HARD_TO_BEAT] rotina concluida para ${rows.length} usuarios`)
 } catch (e) {
  console.log("[HARD_TO_BEAT] erro:", e.message)
 }
}

cron.schedule("0 9 * * *", () => {
 runHardToBeatRoutine()
}, { timezone: "America/Sao_Paulo" })

if (process.env.RUN_HARD_TO_BEAT_ON_STARTUP === "true") {
 runHardToBeatRoutine()
}

/*
========================================
SERVIDOR
========================================
*/

app.listen(PORT,()=>{

 console.log(`Servidor rodando na porta ${PORT}`)

})