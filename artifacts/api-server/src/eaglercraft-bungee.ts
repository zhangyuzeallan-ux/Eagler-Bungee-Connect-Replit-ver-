import * as http from "http";
import * as net from "net";
import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./lib/logger";
import { EaglerPlayer } from "./eagler/player";

interface BungeeConfig {
  minecraftHost: string;
  minecraftPort: number;
  wsPath: string;
  serverName: string;
  motdLine1: string;
  motdLine2: string;
  maxPlayers: number;
  protocolVersion: number;
  eaglerNetworkVersion: number;
  brand: string;
  proxyVersion: string;
}

const DEFAULT_CONFIG: BungeeConfig = {
  minecraftHost: process.env["MC_HOST"] || "",
  minecraftPort: Number(process.env["MC_PORT"] || "25565"),
  wsPath: process.env["WS_PATH"] || "/api/eagler",
  serverName: process.env["SERVER_NAME"] || "EaglerCraft Bungee Proxy",
  motdLine1: process.env["MOTD_LINE1"] || "§aEaglerCraft Bungee Proxy",
  motdLine2: process.env["MOTD_LINE2"] || "§7Connecting to Aternos server",
  maxPlayers: Number(process.env["MAX_PLAYERS"] || "20"),
  protocolVersion: Number(process.env["MC_PROTOCOL"] || "47"),
  eaglerNetworkVersion: Number(process.env["EAGLER_NET_VERSION"] || "3"),
  brand: process.env["PROXY_BRAND"] || "lax1dude",
  proxyVersion: process.env["PROXY_VERSION"] || "1.0.0",
};

const SERVER_UUID = crypto.randomUUID();

const activePlayers = new Set<EaglerPlayer>();

function buildBaseResponse(config: BungeeConfig): Record<string, unknown> {
  return {
    name: config.serverName,
    brand: config.brand,
    vers: `EaglerXBungee/${config.proxyVersion}`,
    cracked: true,
    secure: false,
    time: Date.now(),
    uuid: SERVER_UUID,
  };
}

function buildMotdResponse(
  config: BungeeConfig,
  online: number,
  players: string[],
): string {
  const motdLines: string[] = [];
  if (config.motdLine1) motdLines.push(config.motdLine1);
  if (config.motdLine2) motdLines.push(config.motdLine2);
  return JSON.stringify({
    ...buildBaseResponse(config),
    type: "MOTD",
    data: {
      cache: false,
      motd: motdLines,
      icon: false,
      online,
      max: config.maxPlayers,
      players,
    },
  });
}

function buildVersionResponse(config: BungeeConfig): string {
  return JSON.stringify({
    ...buildBaseResponse(config),
    type: "version",
    data: {
      minEaglerProtocol: 2,
      maxEaglerProtocol: 3,
      minMinecraftProtocol: 47,
      maxMinecraftProtocol: 47,
    },
  });
}

// --- Vanilla Minecraft SLP for upstream player count ---

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) { bytes.push(v); break; }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}
function encodeMcString(s: string): Buffer {
  const str = Buffer.from(s, "utf8");
  return Buffer.concat([encodeVarInt(str.length), str]);
}
function encodeUShort(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}
function encodeMcPacket(packetId: number, fields: Buffer[]): Buffer {
  const body = Buffer.concat([encodeVarInt(packetId), ...fields]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}
function readVarIntFromBuf(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0, size = 0, byte: number;
  do {
    if (offset + size >= buf.length) return null;
    byte = buf[offset + size]!;
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) return null;
  } while ((byte & 0x80) !== 0);
  return { value, size };
}
function tryParseStatusResponse(buf: Buffer): { online: number; max: number; players: string[] } | null {
  const lenInfo = readVarIntFromBuf(buf, 0);
  if (!lenInfo) return null;
  if (buf.length < lenInfo.size + lenInfo.value) return null;
  let p = lenInfo.size;
  const idInfo = readVarIntFromBuf(buf, p);
  if (!idInfo || idInfo.value !== 0x00) return null;
  p += idInfo.size;
  const strLenInfo = readVarIntFromBuf(buf, p);
  if (!strLenInfo) return null;
  p += strLenInfo.size;
  if (buf.length < p + strLenInfo.value) return null;
  try {
    const obj = JSON.parse(buf.slice(p, p + strLenInfo.value).toString("utf8")) as {
      players?: { online?: number; max?: number; sample?: { name?: string }[] };
    };
    return {
      online: obj.players?.online ?? 0,
      max: obj.players?.max ?? 0,
      players: (obj.players?.sample ?? []).map((s) => s.name).filter((n): n is string => typeof n === "string"),
    };
  } catch { return null; }
}

async function pingUpstream(host: string, port: number, timeoutMs = 2000): Promise<{ online: number; max: number; players: string[] } | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (val: { online: number; max: number; players: string[] } | null) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("connect", () => {
      const hs = encodeMcPacket(0x00, [encodeVarInt(47), encodeMcString(host), encodeUShort(port), encodeVarInt(1)]);
      const sr = encodeMcPacket(0x00, []);
      sock.write(Buffer.concat([hs, sr]));
    });
    let recvBuf = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer | string) => {
      recvBuf = Buffer.concat([recvBuf, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const parsed = tryParseStatusResponse(recvBuf);
      if (parsed) { clearTimeout(timer); finish(parsed); }
    });
    sock.on("error", () => { clearTimeout(timer); finish(null); });
    sock.on("close", () => { clearTimeout(timer); finish(null); });
  });
}

// --- WebSocket connection handler ---

async function handleClient(ws: WebSocket, req: http.IncomingMessage, config: BungeeConfig) {
  const clientIp =
    ((req.headers["x-forwarded-for"] as string) || "").split(",")[0]?.trim() ||
    req.socket.remoteAddress || "unknown";

  logger.info(
    {
      clientIp,
      origin: req.headers["origin"],
      ua: req.headers["user-agent"],
      url: req.url,
      protocol: (ws as unknown as { protocol?: string }).protocol,
      cookie: req.headers["cookie"] ? "(present)" : "(none)",
    },
    "[BUNGEE] Client connected",
  );

  // Wait for the very first frame to decide: query (text) or login (binary)
  let firstMsg: { data: Buffer; isBinary: boolean } | null = null;
  try {
    firstMsg = await new Promise<{ data: Buffer; isBinary: boolean }>((resolve, reject) => {
      const onMsg = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        ws.off("message", onMsg);
        ws.off("close", onClose);
        clearTimeout(timer);
        const buf = Buffer.isBuffer(data) ? data
          : data instanceof ArrayBuffer ? Buffer.from(data)
          : Buffer.concat(data as Buffer[]);
        resolve({ data: buf, isBinary });
      };
      const onClose = (code: number, reason: Buffer) => {
        ws.off("message", onMsg);
        clearTimeout(timer);
        reject(new Error(`client closed before sending data (code=${code} reason=${reason.toString("utf8") || "(empty)"})`));
      };
      const timer = setTimeout(() => {
        ws.off("message", onMsg); ws.off("close", onClose);
        reject(new Error("no first packet within 60s"));
      }, 60000);
      ws.on("message", onMsg);
      ws.on("close", onClose);
    });
  } catch (err) {
    logger.warn({ clientIp, errMsg: err instanceof Error ? err.message : String(err) }, "[BUNGEE] First-packet wait failed");
    try { ws.close(); } catch { /* ignore */ }
    return;
  }

  // Always log the first frame in detail so we can diagnose unknown clients
  logger.info(
    {
      clientIp,
      isBinary: firstMsg.isBinary,
      length: firstMsg.data.length,
      firstByte: firstMsg.data.length > 0 ? "0x" + firstMsg.data[0]!.toString(16) : "(empty)",
      hex: firstMsg.data.subarray(0, 64).toString("hex"),
      utf8: firstMsg.isBinary ? null : firstMsg.data.toString("utf8").slice(0, 120),
    },
    "[BUNGEE] First frame received",
  );

  // ----- TEXT FRAME: MOTD/version query -----
  if (!firstMsg.isBinary) {
    const text = firstMsg.data.toString("utf8");
    const lower = text.toLowerCase();
    logger.info({ clientIp, text: text.slice(0, 80) }, "[BUNGEE] Query frame");
    if (lower.startsWith("accept:")) {
      const queryType = text.substring(7).trim().toLowerCase();
      if (queryType.startsWith("motd")) {
        let upstream: { online: number; max: number; players: string[] } | null = null;
        if (config.minecraftHost) {
          upstream = await pingUpstream(config.minecraftHost, config.minecraftPort);
        }
        const localOnline = activePlayers.size;
        const localPlayers = Array.from(activePlayers).map((p) => p.username).filter(Boolean).slice(0, 9);
        const online = (upstream?.online ?? 0) + localOnline;
        const players = [...localPlayers, ...(upstream?.players ?? [])].slice(0, 9);
        ws.send(buildMotdResponse(config, online, players));
        logger.info({ clientIp }, "[BUNGEE] MOTD sent, waiting for login on same connection");

        // EaglerCraft browser client reuses the same WS connection:
        // after MOTD it sends CSLogin binary frame on the same socket.
        // Wait longer here because browsers on Replit can stall briefly after MOTD.
        let loginMsg: { data: Buffer; isBinary: boolean } | null = null;
        try {
          loginMsg = await new Promise<{ data: Buffer; isBinary: boolean }>((resolve, reject) => {
            const onMsg = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
              ws.off("message", onMsg);
              ws.off("close", onClose);
              clearTimeout(idleTimer);
              const buf = Buffer.isBuffer(data) ? data
                : data instanceof ArrayBuffer ? Buffer.from(data)
                : Buffer.concat(data as Buffer[]);
              resolve({ data: buf, isBinary });
            };
            const onClose = (code: number) => {
              ws.off("message", onMsg);
              clearTimeout(idleTimer);
              reject(new Error(`closed after motd (code=${code})`));
            };
            const idleTimer = setTimeout(() => {
              ws.off("message", onMsg);
              ws.off("close", onClose);
              reject(new Error("idle after motd"));
            }, 60000);
            ws.on("message", onMsg);
            ws.on("close", onClose);
          });
        } catch {
          try { ws.close(1000, "motd-done"); } catch { /* ignore */ }
          return;
        }

        if (!loginMsg.isBinary) {
          logger.warn({ clientIp }, "[BUNGEE] Expected login binary after MOTD, got text");
          try { ws.close(1003, "expected-binary"); } catch { /* ignore */ }
          return;
        }

        logger.info(
          {
            clientIp,
            isBinary: true,
            length: loginMsg.data.length,
            firstByte: "0x" + loginMsg.data[0]!.toString(16),
            hex: loginMsg.data.subarray(0, 64).toString("hex"),
          },
          "[BUNGEE] Login frame on same connection",
        );

        // Fall through to login handler with the captured binary frame
        firstMsg = loginMsg;
      } else if (queryType === "version") {
        ws.send(buildVersionResponse(config));
        try { ws.close(1000, "version-done"); } catch { /* ignore */ }
        return;
      } else {
        logger.warn({ clientIp, text: text.slice(0, 80) }, "[BUNGEE] Unknown query type");
        try { ws.close(1003, "unknown-query"); } catch { /* ignore */ }
        return;
      }
    } else {
      logger.warn({ clientIp, text: text.slice(0, 80) }, "[BUNGEE] Unknown text query");
      try { ws.close(1003, "unknown-text"); } catch { /* ignore */ }
      return;
    }

    // At this point firstMsg is the binary login frame (same connection after MOTD)
  }

  // ----- BINARY FRAME: EaglerX login -----
  if (!config.minecraftHost) {
    logger.warn({ clientIp }, "[BUNGEE] Login attempted but MC_HOST is not configured");
    try { ws.send(Buffer.concat([Buffer.from([0xff, 0x08]), Buffer.from([21]), Buffer.from("Server not configured", "utf8")])); ws.close(); } catch { /* ignore */ }
    return;
  }

  const player = new EaglerPlayer({
    ws, req,
    upstreamHost: config.minecraftHost,
    upstreamPort: config.minecraftPort,
    protocolVersion: config.protocolVersion,
    eaglerNetworkVersion: config.eaglerNetworkVersion,
    brand: config.brand,
    proxyVersion: config.proxyVersion,
  });
  activePlayers.add(player);
  player.once("disconnect", () => {
    activePlayers.delete(player);
    logger.info({ clientIp, username: player.username }, "[BUNGEE] Player removed");
  });
  await player.run(firstMsg.data);
}

function createBungeeProxy(server: http.Server, config: BungeeConfig = DEFAULT_CONFIG): WebSocketServer {
  logger.info(
    {
      wsPath: config.wsPath,
      minecraftHost: config.minecraftHost || "(not set)",
      minecraftPort: config.minecraftPort,
      serverName: config.serverName,
      protocolVersion: config.protocolVersion,
    },
    "EaglerCraft Bungee WebSocket proxy starting",
  );

  // Use noServer:true for ALL WebSocketServers so each one does NOT register its own
  // 'upgrade' listener. Multiple { server, path } WebSocketServers on the same HTTP server
  // cause every non-matching server to call abortHandshake(socket, 400), writing HTTP 400
  // bytes into the already-upgraded WebSocket stream → RSV1 corruption / 1006 disconnect.
  //
  // Instead, we register a single 'upgrade' handler and route manually via handleUpgrade().
  //
  // perMessageDeflate MUST be disabled: compressed frames set RSV1 which nginx/h2 bridges
  // cannot relay (browser gets OPEN but 1006 on first frame).

  const echoWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  echoWss.on("connection", (ws, req) => {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress ?? "unknown";
    logger.info(
      {
        ip,
        url: req.url,
        origin: req.headers["origin"],
        secWebSocketProtocol: req.headers["sec-websocket-protocol"],
      },
      "[ECHO] Browser WebSocket connected ✓",
    );
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data as Buffer[]);
      logger.info(
        {
          ip,
          isBinary,
          len: buf.length,
          hex: buf.subarray(0, 32).toString("hex"),
        },
        "[ECHO] message received, echoing back",
      );
      ws.send(buf, { binary: isBinary });
    });
    ws.on("close", (code, reason) => logger.info({ ip, code, reason: reason.toString("utf8") }, "[ECHO] closed"));
    ws.on("error", (err) => logger.warn({ ip, errMsg: err.message, stack: err.stack }, "[ECHO] error"));
  });
  echoWss.on("error", (err) => logger.error({ errMsg: err.message }, "[ECHO] WSS error"));

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  wss.on("connection", (ws, req) => {
    handleClient(ws, req, config).catch((err) => {
      logger.error(
        { errMsg: err instanceof Error ? err.message : String(err) },
        "[BUNGEE] handleClient threw",
      );
      try { ws.close(); } catch { /* ignore */ }
    });
  });
  wss.on("error", (err) => logger.error({ errMsg: err.message }, "[BUNGEE] WSS error"));

  // Single upgrade router — only ONE handler touches the socket per request.
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const pathname = url.split("?")[0] ?? "";

    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";

    logger.info(
      {
        method: req.method,
        url,
        upgrade: req.headers["upgrade"],
        origin: req.headers["origin"],
        proto: req.headers["x-forwarded-proto"],
        ip,
      },
      "[BUNGEE] Raw HTTP upgrade event",
    );

    if (pathname === "/api/ws-echo") {
      echoWss.handleUpgrade(req, socket, head, (ws) => {
        echoWss.emit("connection", ws, req);
      });
    } else if (pathname === config.wsPath) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      logger.warn({ pathname, ip }, "[BUNGEE] Unknown upgrade path, destroying socket");
      socket.destroy();
    }
  });

  return wss;
}

export { createBungeeProxy };
export type { BungeeConfig };
