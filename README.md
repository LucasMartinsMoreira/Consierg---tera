# Concierge Bot

Bot de Telegram que ajuda pessoas a escolherem o melhor smartphone para suas necessidades. Ele conversa de forma natural, entende o que o usuario precisa (camera, bateria, jogos, orcamento) e busca ofertas reais no Google Shopping.

## Como funciona

O bot funciona em 3 etapas:

1. **Diagnostico** -- Conversa com o usuario para entender o que ele procura (modelo, orcamento, uso principal, bateria, armazenamento)
2. **Busca** -- Quando tem informacao suficiente, busca ofertas reais no Google Shopping via SerpAPI
3. **Recomendacao** -- Apresenta os melhores resultados com ranking por preco, loja confiavel e compatibilidade

Alem disso, tem um **modo monitoramento**: o usuario define um preco-alvo e o bot checa diariamente se apareceu algo abaixo desse valor.

## Arquitetura

```
index.js                   Express + Telegram + logica de fluxo
  |
  +-- lib/agents.js        Agentes OpenAI (Diagnosis, Concierge, Search Query)
  |
  +-- lib/db.js            Banco de dados (auto-detecta Neon ou SQLite)
  |
  +-- api/index.js          Entry point para Vercel Serverless
```

### Agentes (lib/agents.js)

A integracao com a OpenAI usa o **OpenAI Agents SDK** (`@openai/agents`) em vez de chamadas diretas a API. Isso traz:

- **Saida estruturada com Zod** -- Em vez de pedir JSON e torcer para o modelo retornar no formato certo, definimos schemas Zod que o SDK valida automaticamente. Se o modelo retornar algo fora do formato, o SDK ja trata o erro.
- **Runner** -- Gerencia a execucao dos agentes, tracing e historico de conversa.

Sao 3 agentes:

| Agente | O que faz | Schema de saida |
|---|---|---|
| **Diagnosis** | Conversa com o usuario para entender o que ele precisa | `user_message`, `qualifiers_patch`, `intent_status` |
| **Concierge** | Analisa produtos encontrados e monta a recomendacao | `user_message`, `user_profile`, `top_recommendations`, `intent_status`, `turn_count` |
| **Search Query** | Extrai uma query de busca a partir do contexto | `query` |

Os prompts dos agentes estao no `index.js` (constantes `conciergePrompt` e `diagnosisExtractPrompt`). O `lib/agents.js` recebe esses prompts como parametro -- assim da para ajustar sem mexer no modulo de agentes.

### Banco de dados (lib/db.js)

O banco detecta automaticamente qual driver usar:

| Ambiente | Condicao | Driver | Banco |
|---|---|---|---|
| **Local (dev)** | Sem `DATABASE_URL` no `.env` | `better-sqlite3` | Arquivo `concierge.db` na raiz |
| **Vercel (producao)** | `DATABASE_URL` definida | `@neondatabase/serverless` | Neon PostgreSQL |

Os dois drivers exportam a mesma interface async. O `index.js` nao sabe (e nem precisa saber) qual banco esta por tras.

As tabelas sao criadas automaticamente na primeira execucao:

- `sessions` -- Estado da conversa de cada usuario (contexto, qualificadores, modo de operacao)
- `price_history` -- Historico de precos encontrados
- `processed_updates` -- IDs de updates do Telegram ja processados (evita duplicatas)

## Rodando localmente

### Pre-requisitos

- Node.js 18+
- Contas com chave de API: [OpenAI](https://platform.openai.com/), [SerpAPI](https://serpapi.com/), [Telegram Bot](https://core.telegram.org/bots#botfather)

### Passo a passo

1. Clone o repositorio e instale as dependencias:

```bash
git clone <url-do-repo>
cd Consierg---tera
npm install
```

2. Crie o arquivo `.env` na raiz:

```env
TELEGRAM_TOKEN=seu_token_do_botfather
OPENAI_API_KEY=sk-...
SERPAPI_KEY=sua_chave_serpapi
```

So isso. Nao precisa de banco externo -- o SQLite cria o arquivo `concierge.db` automaticamente.

3. Rode o servidor:

```bash
npm start
```

O servidor sobe na porta 3000. Para testar localmente com o Telegram, voce precisa expor a porta com um tunel (ngrok, cloudflared, etc.) e configurar o webhook:

```bash
# Em outro terminal:
ngrok http 3000

# Depois, configure o webhook (edite a URL em ops/set-telegram-webhook.js):
npm run webhook:set
```

4. Mande uma mensagem para o bot no Telegram.

### Variaveis de ambiente opcionais (local)

| Variavel | Padrao | Descricao |
|---|---|---|
| `PORT` | `3000` | Porta do servidor Express |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Modelo da OpenAI |
| `LOG_VIEWER_SECRET` | (sem senha) | Senha para acessar `/logs` no navegador |
| `TELEGRAM_WEBHOOK_SECRET` | (vazio) | Secret para validar webhooks do Telegram |
| `OPENAI_STORE_COMPLETIONS` | `false` | Salvar completions no dashboard da OpenAI (`1` ou `true`) |
| `DB_PATH` | `./concierge.db` | Caminho do arquivo SQLite |
| `RUN_HARD_TO_BEAT_ON_STARTUP` | `false` | Rodar rotina de busca ao iniciar (`true`) |

## Deploy no Vercel

### 1. Criar banco Neon PostgreSQL

1. Acesse [neon.tech](https://neon.tech/) e crie uma conta (tem plano gratuito)
2. Crie um novo projeto
3. Copie a **connection string** (formato: `postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`)

### 2. Configurar o projeto no Vercel

1. Importe o repositorio no [Vercel](https://vercel.com/)
2. Em **Settings > Environment Variables**, adicione:

| Variavel | Obrigatoria | Valor |
|---|---|---|
| `DATABASE_URL` | Sim | Connection string do Neon |
| `TELEGRAM_TOKEN` | Sim | Token do bot (BotFather) |
| `OPENAI_API_KEY` | Sim | Chave da OpenAI |
| `SERPAPI_KEY` | Sim | Chave da SerpAPI |
| `TELEGRAM_WEBHOOK_SECRET` | Recomendado | Uma string aleatoria para validar webhooks |
| `CRON_SECRET` | Recomendado | Secret para proteger a rota `/api/cron` |
| `OPENAI_MODEL` | Nao | Padrao: `gpt-4.1-mini` |
| `OPENAI_STORE_COMPLETIONS` | Nao | `1` para salvar completions na OpenAI |

3. Faca o deploy (push para o branch ou deploy manual)

### 3. Configurar webhook do Telegram

Depois do deploy, aponte o webhook do Telegram para a URL do Vercel:

```bash
# Edite ops/set-telegram-webhook.js com a URL do Vercel e rode:
npm run webhook:set

# Ou manualmente:
curl "https://api.telegram.org/bot<SEU_TOKEN>/setWebhook?url=https://seu-projeto.vercel.app/webhook"
```

Se definiu `TELEGRAM_WEBHOOK_SECRET`, adicione o parametro `secret_token`:

```bash
curl "https://api.telegram.org/bot<SEU_TOKEN>/setWebhook?url=https://seu-projeto.vercel.app/webhook&secret_token=SUA_SECRET"
```

### 4. Cron job (rotina diaria)

O `vercel.json` ja configura um cron job que roda ao meio-dia UTC:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 12 * * *"
    }
  ]
}
```

Essa rotina:
- Busca precos atualizados para todos os usuarios com conversa ativa
- Envia alertas para usuarios em modo monitoramento cujo preco-alvo foi atingido

Para proteger essa rota, defina `CRON_SECRET` nas env vars do Vercel.

## Estrutura de arquivos

```
.
|-- api/
|   +-- index.js              Entry point Vercel (importa o Express app)
|-- lib/
|   |-- agents.js             Agentes OpenAI com schemas Zod
|   +-- db.js                 Banco de dados (SQLite local / Neon producao)
|-- ops/
|   |-- reset-sessions.js     Utilitario para resetar sessoes
|   +-- set-telegram-webhook.js  Configura webhook do Telegram
|-- index.js                  App principal (Express + logica do bot)
|-- vercel.json               Configuracao de deploy Vercel
|-- package.json
+-- .env                      Variaveis de ambiente (nao versionado)
```

## Scripts disponiveis

| Comando | Descricao |
|---|---|
| `npm start` | Inicia o servidor local |
| `npm run webhook:set` | Configura o webhook do Telegram |
| `npm run concierge:reset` | Reseta sessoes do bot |
| `npm run concierge:reset-full` | Reset completo (apaga tudo) |

## Painel de logs

Acesse `http://localhost:3000/logs` (local) ou `https://seu-projeto.vercel.app/logs` (producao) para ver as mensagens trocadas com o Telegram em tempo real. Se `LOG_VIEWER_SECRET` estiver definida, acesse com `?key=SUA_CHAVE`.
