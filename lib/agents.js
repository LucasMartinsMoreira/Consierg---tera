const { z } = require("zod")
const { Agent, Runner } = require("@openai/agents")

const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini"
const STORE = /^1|true|yes$/i.test(String(process.env.OPENAI_STORE_COMPLETIONS || ""))

// --- Schemas Zod (substituem JSON.parse manual) ---

const DiagnosisSchema = z.object({
 user_message: z.string(),
 qualifiers_patch: z.object({
  path_model: z.enum(["modelo_em_mente", "explorar_opcoes"]).optional(),
  budget: z.string().optional(),
  primary_use: z.string().optional(),
  battery_need: z.string().optional(),
  storage: z.string().optional()
 }).optional().default({}),
 intent_status: z.enum(["diagnosis", "searching"]).default("diagnosis")
})

const ConciergeSchema = z.object({
 user_message: z.string(),
 user_profile: z.string().optional().default(""),
 top_recommendations: z.array(z.any()).optional().default([]),
 intent_status: z.enum(["diagnosis", "searching", "options_given"]),
 turn_count: z.number().int()
})

const SearchQuerySchema = z.object({
 query: z.string()
})

// --- Agentes ---

function createDiagnosisAgent(instructions) {
 return new Agent({
  name: "Concierge Diagnosis",
  instructions,
  model: OPENAI_MODEL,
  outputType: DiagnosisSchema,
  modelSettings: {
   temperature: 0.7,
   store: STORE
  }
 })
}

function createConciergeAgent(instructions) {
 return new Agent({
  name: "Concierge",
  instructions,
  model: OPENAI_MODEL,
  outputType: ConciergeSchema,
  modelSettings: {
   temperature: 0.7,
   store: STORE
  }
 })
}

function createSearchQueryAgent() {
 return new Agent({
  name: "Search Query Extractor",
  instructions: "Extraia uma query curta para buscar smartphones. Retorne JSON com a chave query.",
  model: OPENAI_MODEL,
  outputType: SearchQuerySchema,
  modelSettings: {
   temperature: 0,
   store: STORE
  }
 })
}

// --- Runner singleton ---

const runner = new Runner({
 modelSettings: { store: STORE }
})

// --- Funções de execução ---

async function runDiagnosisAgent(diagnosisPrompt, userPayload) {
 const agent = createDiagnosisAgent(diagnosisPrompt)
 const result = await runner.run(agent, [
  { role: "user", content: userPayload }
 ])
 return result.finalOutput
}

async function runConciergeAgent(conciergePrompt, userPayload) {
 const agent = createConciergeAgent(conciergePrompt)
 const result = await runner.run(agent, [
  { role: "user", content: userPayload }
 ])
 return result.finalOutput
}

async function runSearchQueryAgent(context) {
 const agent = createSearchQueryAgent()
 const result = await runner.run(agent, [
  { role: "user", content: `Contexto do usuário:\n\n${context}` }
 ])
 return result.finalOutput
}

module.exports = {
 runDiagnosisAgent,
 runConciergeAgent,
 runSearchQueryAgent,
 DiagnosisSchema,
 ConciergeSchema,
 SearchQuerySchema
}
