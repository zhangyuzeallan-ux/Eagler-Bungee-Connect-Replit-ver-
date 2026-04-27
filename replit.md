# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## EaglerCraft Bungee Proxy

WebSocket-to-Minecraft proxy for EaglercraftX 1.8 browser clients.

**Implementation:** `artifacts/api-server/src/eaglercraft-bungee.ts`

**Protocol (EaglerXBungee 1.3.4):**
- **MOTD/version queries:** TEXT WebSocket frame `Accept: motd` (or `version`) → server replies with TEXT frame containing JSON envelope `{name, brand, vers, cracked, secure, time, uuid, type, data}` where `data` includes `{cache, motd[], icon, online, max, players[]}`. Source reference: `EaglerStorage/EaglerXbungee` repo, `MOTDQueryHandler.java` + `QueryManager.createBaseResponse()`.
- **Login handshake:** BINARY WebSocket frame starting with `0x01` (PROTOCOL_CLIENT_VERSION). Server responds with `0x02` (PROTOCOL_SERVER_VERSION). Currently the proxy returns `0xFF 0x08` (PROTOCOL_SERVER_ERROR + SERVER_ERROR_CUSTOM_MESSAGE) explaining login isn't yet implemented (full vanilla-MC ↔ EaglerX translation is a larger task).
- **Upstream player count:** When MOTD is requested, the proxy attempts a vanilla Minecraft Server List Ping (handshake state=1 + status request) to the configured Aternos host to get real `online`/`players` data. Falls back to 0/empty if upstream is asleep.

**Environment variables:**
- `MC_HOST`, `MC_PORT` — upstream Minecraft server (Aternos)
- `WS_PATH` — WebSocket path (default `/api/eagler`)
- `SERVER_NAME`, `MOTD_LINE1`, `MOTD_LINE2`, `MAX_PLAYERS` — MOTD customization

**Production:** `wss://eagler-bungee-connect--zhangyuzeallan.replit.app/api/eagler`
