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

const upsertSessionStmt = db.prepare(`
INSERT INTO sessions (chat_id, context, intent_status, turn_count, updated_at)
VALUES (@chat_id, @context, @intent_status, @turn_count, CURRENT_TIMESTAMP)
ON CONFLICT(chat_id) DO UPDATE SET
 context = excluded.context,
 intent_status = excluded.intent_status,
 turn_count = excluded.turn_count,
 updated_at = CURRENT_TIMESTAMP;
`)

function getSession(chatId) {
 const row = db
  .prepare("SELECT chat_id, context, intent_status, turn_count FROM sessions WHERE chat_id = ?")
  .get(String(chatId))

 if (row) return row

 const session = {
  chat_id: String(chatId),
  context: "",
  intent_status: "diagnosis",
  turn_count: 0
 }

 upsertSessionStmt.run(session)
 return session
}

function saveSession(session) {
 upsertSessionStmt.run({
  chat_id: String(session.chat_id),
  context: session.context || "",
  intent_status: session.intent_status || "diagnosis",
  turn_count: Number(session.turn_count || 0)
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

  let phones=[]

  if(session.intent_status==="searching"){

   const query=await extractSearchQuery(session.context)

   phones=await searchPhones(query)
   savePriceSnapshot(chatId, query, phones)

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