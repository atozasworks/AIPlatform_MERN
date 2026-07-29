# AiChat — Unified Multi-Model AI Platform (MERN)

A production-oriented, provider-agnostic AI assistant platform. Users interact with multiple
LLM providers through a single conversational interface with streaming responses, conversation
history, file/RAG analysis, tools, subscriptions, and admin controls.

> This platform is a **multi-model AI orchestration layer** built on official provider APIs.
> It does not claim ownership of any foundation model.

## Tech Stack

- **Frontend:** React + Vite, Tailwind CSS, PWA
- **Backend:** Node.js + Express (ESM), Socket.IO, SSE streaming
- **Database:** MongoDB (Mongoose)
- **Cache/Queue:** Redis + BullMQ (later phases)
- **Auth:** JWT in HTTP-only cookies, refresh-token rotation, bcrypt
- **Deploy:** Ubuntu VPS + Nginx + PM2

## Monorepo layout

```
AiChat_MERN/
├─ server/   Express API, models, AI gateway, streaming
├─ client/   React + Vite SPA / PWA
├─ deploy/   Nginx, PM2, backup scripts
└─ docs/     API, DB, deployment, security docs
```

## Quick start (development)

```bash
# 1. Install all dependencies (root + server + client)
npm run install:all

# 2. Configure backend env
cp server/.env.example server/.env
#   Edit server/.env — set MONGO_URI, JWT secrets, and (optionally) OPENAI_API_KEY.
#   With no provider key, the built-in MockProvider is used (zero API cost).

# 3. Run both apps
npm run dev
#   API:    http://localhost:5000
#   Client: http://localhost:5173
```

## Phase status

- [x] **Phase 1** — Auth, single-provider streaming chat, conversation history, responsive PWA UI
- [ ] Phase 2 — Multi-provider, model selector, usage tracking, fallback
- [ ] Phase 3 — Files, embeddings, RAG, citations, knowledge bases
- [ ] Phase 4 — Web search, data/code sandbox, image + voice
- [ ] Phase 5 — Subscriptions, payments, orgs, admin dashboard
- [ ] Phase 6 — Hardening, tests, monitoring, backups, deploy

See `docs/` for detailed architecture, API, and deployment guides.
