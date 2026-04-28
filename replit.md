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

Full WebSocket ↔ vanilla Minecraft 1.8 protocol proxy that lets EaglercraftX browser clients connect to a normal Minecraft server (e.g. Aternos).

**Implementation:**
- `artifacts/api-server/src/eaglercraft-bungee.ts` — entry point: WSS server, MOTD/version text-query handling, vanilla MC SLP for upstream player count.
- `artifacts/api-server/src/eagler/protocol.ts` — VarInt/string/UUID encoding (uses `@thi.ng/leb128`).
- `artifacts/api-server/src/eagler/handshake.ts` — EaglerX binary handshake packet builders/parsers (CSLogin 0x01, SCIdentify 0x02, CSUsername 0x04, SCSyncUuid 0x05, CSSetSkin 0x07, CSReady 0x08, SCReady 0x09, SCDisconnect 0xFF).
- `artifacts/api-server/src/eagler/player.ts` — `EaglerPlayer` class: completes EaglerX handshake then opens a vanilla MC TCP connection via `minecraft-protocol` (`createClient` v1.8.9 offline-mode), and bidirectionally translates PLAY-state packets between WebSocket binary frames and the upstream TCP socket.
- `artifacts/api-server/src/eagler/util.ts` — offline-mode UUID v3 generation (`OfflinePlayer:<name>` MD5), username validation, packet awaits.

**Protocol flow (EaglerXBungee 1.3.4):**
1. **MOTD/version queries:** TEXT WebSocket frame `Accept: motd` (or `version`) → reply with TEXT JSON envelope `{name, brand, vers, cracked, secure, time, uuid, type, data}`. `data.online`/`data.players` are populated from a vanilla MC Server List Ping to the upstream host (falls back to 0/empty if upstream asleep).
2. **Login (binary):** Client → 0x01 CSLogin (game ver 47, brand, version, username). Server → 0x02 SCIdentify. Client → 0x04 CSUsername. Server → 0x05 SCSyncUuid (offline UUID). Client → 0x07 CSSetSkin + 0x08 CSReady (any order). Server → 0x09 SCReady. Then client streams vanilla MC PLAY packets in binary WS frames.
3. **PLAY-state bridge:** Server uses prismarine `createSerializer`/`createDeserializer` for vanilla MC 1.8.9, plus `minecraft-protocol`'s `createClient` to open a vanilla TCP connection. PLAY packets are forwarded transparently in both directions; the upstream "login" PLAY packet is forwarded to the EaglerX client to start the streaming session.

**Reference implementation:** `WorldEditAxe/eaglerproxy` (TypeScript, MIT). Local cache at `/tmp/eaglerproxy/` if present.

**Environment variables:**
- `MC_HOST`, `MC_PORT` — upstream Minecraft server (Aternos)
- `WS_PATH` — WebSocket path (default `/api/eagler`)
- `SERVER_NAME`, `MOTD_LINE1`, `MOTD_LINE2`, `MAX_PLAYERS` — MOTD customization
- `MC_PROTOCOL` (default 47), `EAGLER_NET_VERSION` (default 3), `PROXY_BRAND`, `PROXY_VERSION`

**Aternos server requirements (CRITICAL):**
- Server must be RUNNING (Aternos free servers sleep after inactivity).
- Must be Minecraft 1.8.x (protocol 47).
- **Must have `online-mode=false`** in server.properties (Aternos: Server → Settings → Online Mode → off). Without this, EaglerCraft players are kicked with "Failed to verify username" because the proxy connects with offline-mode UUIDs.

**Build notes:** `minecraft-protocol`, `prismarine-*`, `node-yggdrasil`, `node-rsa`, `@thi.ng/leb128` are externalized in `build.mjs` because they bundle game-data files dynamically via `require`.

**Production:** `wss://eagler-bungee-connect--zhangyuzeallan.replit.app/api/eagler`
**Status endpoint:** `GET /api/bungee/status`
