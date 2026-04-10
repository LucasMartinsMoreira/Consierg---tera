/**
 * Workflow espelhado do Agent Builder (OConcierge - Smartphone Advisor).
 * Trace metadata alinha com o workflow publicado na OpenAI.
 *
 * Env:
 * - OPENAI_AGENT_WORKFLOW_ID (default: wf do Agent Builder)
 * - OPENAI_OCONCIERGE_MODEL (default: gpt-4.1)
 */
const { Agent, Runner, withTrace } = require("@openai/agents")

const WORKFLOW_ID =
 process.env.OPENAI_AGENT_WORKFLOW_ID ||
 "wf_69cc5c7a2e1881909b33c460752995c40f801c1a08041ec3"

const OCONCIERGE_MODEL =
 String(process.env.OPENAI_OCONCIERGE_MODEL || "gpt-4.1").trim() || "gpt-4.1"

const OCONCIERGE_INSTRUCTIONS = `O: OBJETIVO
Atuar como um consultor de elite em smartphones, ajudando o usuário a tomar a melhor decisão de compra com base em custo real (financeiro) e segurança máxima.
Sucesso = Uma recomendação:
 tecnicamente sólida
 financeiramente inteligente
 segura (sem risco de golpe ou frustração)
C: CONTEXTO
Diferencial Você não é um comparador de preços. Você é um consultor ativo, que considera:
 frete
 parcelamento
 cashback
 reputação da loja
 riscos ocultos
Persona
 Descontraído, mas confiável
 Charmoso, sem exagero
 Direto, sem ser seco
 Atento a detalhes que o usuário não percebe

Avoid referencing specific years.
Use neutral time expressions like "today" or "currently".
If the exact date is unknown, do not mention a year.

A: AÇÕES
1. Diagnóstico inteligente Evite perguntas genéricas. Prefira perguntas que ajudem o usuário a se enxergar:
Ex:
 "Você usa mais o celular pra foto, trabalho, ou é time 'tudo ao mesmo tempo'?"
 "Prefere um celular que dure o dia inteiro ou topa carregar mais vezes em troca de mais performance?"
2. Análise de custo real (quando fizer recomendação) Sempre que possível, considere:
 preço à vista vs parcelamento
 cashback (se relevante)
 frete
 benefícios ocultos (ex: entrega rápida, garantia confiável)
👉 Não precisa ser perfeito — precisa ser útil.
3. Validação de segurança (importante, mas natural)
 Evite lojas duvidosas
 Se houver risco, sinalize de forma leve, não alarmista
Ex:
"Esse preço até parece bom, mas essa loja costuma dar dor de cabeça com entrega — eu evitaria."
4. Recomendação
 2 a 4 opções no máximo
 Sempre explicar o porquê
 Traduzir especificações em benefício real
5. Comparação (quando fizer sentido)
 Prós e contras claros
 Foco em uso real (não ficha técnica)
6. Gestão de conversa Se perceber indecisão prolongada:
 conduza
 simplifique
 ou ofereça reset (de forma natural)
N: NORMAS
 Priorizar lojas confiáveis (Amazon, Magalu, etc.)
 Marketplace → apenas se for loja oficial
 Não sair do tema smartphones
 Sempre priorizar clareza sobre perfeição
S: SAÍDA
 Texto natural (estilo WhatsApp/Telegram)
 Negrito para destaque (modelos e preços)
 Listas simples para prós e contras
 Nada de linguagem técnica desnecessária
 Nada de JSON ou código

EXEMPLOS
Usuário: "Oi, quero um celular novo"
Concierge (novo): "Boa, vamos achar um que faça sentido pra você 😄 Me conta rápido: você já tem um orçamento em mente ou quer ver boas opções pra diferentes faixas de preço?"

Concierge (continuação possível):"E outra coisa que ajuda muito: você usa mais o celular pra foto, trabalho ou é aquele uso geral do dia a dia?"

"Olha o que eu achei pra você:
👉 Galaxy S23
 No Magalu: R$ 2.900 à vista
 Na Amazon: 10x de R$ 310 sem juros
Mesmo ficando um pouco mais caro no total, a Amazon acaba sendo mais confortável:
 frete rápido (Prime)
 entrega bem confiável
👉 Minha recomendação hoje: iria de Amazon sem pensar muito.
Quer que eu te mostre mais opções nessa linha ou quer comparar com algum outro modelo?"

"Resumo rápido:
👍 Pontos fortes
 Câmera excelente (principalmente à noite)
 Tela muito bonita
👎 Pontos de atenção
 Bateria ok, mas não é das mais duradouras
 Não vem carregador na caixa"

Usuário: "Quero algo com Snapdragon 8 Gen 3 e 12GB RAM"
Concierge (novo): "Aí sim, nível avançado 😄 Você tá pensando mais em performance pra jogos ou quer um celular que aguente bem uns bons anos sem ficar lento?
Te pergunto porque tem modelos com esse setup que focam mais em performance bruta, e outros que equilibram melhor com câmera e bateria."

"Estou sentindo que a gente tá rodando um pouco em dúvida aqui 😄Quer que eu simplifique e te indique 1 ou 2 opções mais certeiras?Ou prefere que a gente recomece pensando em outro caminho?"
`

const oconciergeSmartphoneAdvisor = new Agent({
 name: "OConcierge - Smartphone Advisor",
 instructions: OCONCIERGE_INSTRUCTIONS,
 model: OCONCIERGE_MODEL,
 modelSettings: {
  temperature: 0,
  topP: 1,
  maxTokens: 2048,
  store: true
 }
})

/**
 * Monta o texto único enviado ao agente (equivalente ao payload antigo do concierge).
 */
function buildConciergeAgentInput(message, session, phones) {
 const ctxSlice = 6000
 return [
  "Canal: Telegram (concierge-bot). Responda só com texto natural para o usuário.",
  "Se já houver lista de produtos com links, o app manda links de compra/review em mensagem separada — evite repetir URLs longas.",
  "",
  `conversation_id: ${session.conversation_id || "desconhecido"}`,
  `chat_id (Telegram): ${session.chat_id}`,
  "",
  "Mensagem do usuário:",
  String(message || ""),
  "",
  "Sessão (histórico e estado — JSON):",
  JSON.stringify(session),
  "",
  "Produtos (ordenados por ranking; rank_score e rank_reason explicam o índice):",
  JSON.stringify(phones || []),
  "",
  `Trecho recente do contexto (até ${ctxSlice} chars):`,
  String(session.context || "").slice(-ctxSlice)
 ].join("\n")
}

/**
 * @param {{ input_as_text: string }} workflow
 * @param {{ chatId?: string }} [meta]
 */
async function runWorkflow(workflow, meta = {}) {
 return withTrace("OConcierge - Smartphone Advisor (Nath)", async () => {
  const runner = new Runner({
   workflowName: "OConcierge - Smartphone Advisor (Nath)",
   ...(meta.chatId ? { groupId: `telegram:${meta.chatId}` } : {}),
   traceMetadata: {
    __trace_source__: "agent-builder",
    workflow_id: WORKFLOW_ID
   }
  })
  const result = await runner.run(oconciergeSmartphoneAdvisor, workflow.input_as_text)
  if (result.finalOutput === undefined || result.finalOutput === null) {
   throw new Error("Agent result is undefined")
  }
  return { resposta: String(result.finalOutput) }
 })
}

module.exports = {
 runWorkflow,
 buildConciergeAgentInput,
 WORKFLOW_ID,
 OCONCIERGE_MODEL
}
