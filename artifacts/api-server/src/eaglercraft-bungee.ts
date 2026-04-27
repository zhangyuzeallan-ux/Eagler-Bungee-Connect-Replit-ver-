import { WebSocketServer, WebSocket } from "ws";
import * as net from "net";
import * as http from "http";
import * as crypto from "crypto";
import { logger } from "./lib/logger";

interface BungeeConfig {
  minecraftHost: string;
  minecraftPort: number;
  wsPath: string;
  serverName: string;
  motdLine1: string;
  motdLine2: string;
  maxPlayers: number;
}

const DEFAULT_CONFIG: BungeeConfig = {
  minecraftHost: process.env["MC_HOST"] || "",
  minecraftPort: Number(process.env["MC_PORT"] || "25565"),
  wsPath: process.env["WS_PATH"] || "/api/eagler",
  serverName: process.env["SERVER_NAME"] || "EaglerCraft Bungee Proxy",
  motdLine1: process.env["MOTD_LINE1"] || "§aEaglerCraft Bungee Proxy",
  motdLine2: process.env["MOTD_LINE2"] || "§7Connecting to Aternos server",
  maxPlayers: Number(process.env["MAX_PLAYERS"] || "20"),
};

const SERVER_UUID = crypto.randomUUID();
const PROXY_VERSION = "EaglerXBungee/1.3.4";
const BRAND = "lax1dude";

function buildBaseResponse(config: BungeeConfig): Record<string, unknown> {
  return {
    name: config.serverName,
    brand: BRAND,
    vers: PROXY_VERSION,
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

  const data = {
    cache: false,
    motd: motdLines,
    icon: false,
    online,
    max: config.maxPlayers,
    players,
  };
  return JSON.stringify({
    ...buildBaseResponse(config),
    type: "MOTD",
    data,
  });
}

function buildVersionResponse(config: BungeeConfig): string {
  const data = {
    minEaglerProtocol: 2,
    maxEaglerProtocol: 3,
    minMinecraftProtocol: 47,
    maxMinecraftProtocol: 47,
  };
  return JSON.stringify({
    ...buildBaseResponse(config),
    type: "version",
    data,
  });
}

// Best-effort Minecraft Server List Ping (SLP) to upstream
// Uses the modern handshake (state=1) + status request flow.
async function pingUpstream(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<{ online: number; max: number; players: string[] } | null> {
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
      // Build VarInt-encoded handshake
      const handshake = encodeMcPacket(0x00, [
        encodeVarInt(47), // protocol version
        encodeMcString(host),
        encodeUShort(port),
        encodeVarInt(1), // next state = status
      ]);
      const statusReq = encodeMcPacket(0x00, []);
      sock.write(Buffer.concat([handshake, statusReq]));
    });

    let recvBuf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      // Try to parse status response
      const parsed = tryParseStatusResponse(recvBuf);
      if (parsed) {
        clearTimeout(timer);
        finish(parsed);
      }
    });
    sock.on("error", () => { clearTimeout(timer); finish(null); });
    sock.on("close", () => { clearTimeout(timer); finish(null); });
  });
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    }
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

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0;
  let size = 0;
  let byte: number;
  do {
    if (offset + size >= buf.length) return null;
    byte = buf[offset + size]!;
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) return null;
  } while ((byte & 0x80) !== 0);
  return { value, size };
}

function tryParseStatusResponse(
  buf: Buffer,
): { online: number; max: number; players: string[] } | null {
  // Frame: VarInt length, VarInt packetId(=0), VarInt strLen, JSON string
  const lenInfo = readVarInt(buf, 0);
  if (!lenInfo) return null;
  if (buf.length < lenInfo.size + lenInfo.value) return null;

  let p = lenInfo.size;
  const idInfo = readVarInt(buf, p);
  if (!idInfo || idInfo.value !== 0x00) return null;
  p += idInfo.size;

  const strLenInfo = readVarInt(buf, p);
  if (!strLenInfo) return null;
  p += strLenInfo.size;
  if (buf.length < p + strLenInfo.value) return null;

  const json = buf.slice(p, p + strLenInfo.value).toString("utf8");
  try {
    const obj = JSON.parse(json) as {
      players?: { online?: number; max?: number; sample?: { name?: string }[] };
    };
    const online = obj.players?.online ?? 0;
    const max = obj.players?.max ?? 0;
    const players = (obj.players?.sample ?? [])
      .map((p) => p.name)
      .filter((n): n is string => typeof n === "string");
    return { online, max, players };
  } catch {
    return null;
  }
}

function handleClient(
  ws: WebSocket,
  req: http.IncomingMessage,
  config: BungeeConfig,
) {
  const clientIp =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const origin = req.headers["origin"] as string | undefined;

  logger.info(
    { clientIp, origin, url: req.url, subprotocol: ws.protocol || "(none)" },
    "[BUNGEE] Client connected",
  );

  let firstPacketSeen = false;
  let isQueryConnection = false;

  const silenceTimer = setTimeout(() => {
    if (!firstPacketSeen) {
      logger.warn({ clientIp }, "[BUNGEE] Client sent NO data after 5s");
    }
  }, 5000);

  ws.on("message", async (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    firstPacketSeen = true;
    clearTimeout(silenceTimer);

    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.concat(data as Buffer[]);

    // ---------- TEXT FRAME PATH (MOTD / version queries) ----------
    if (!isBinary) {
      const str = buf.toString("utf8");
      logger.info(
        { clientIp, isBinary, byteLength: buf.length, text: str.slice(0, 120) },
        "[BUNGEE] WS text frame",
      );

      const lower = str.toLowerCase();
      if (lower.startsWith("accept:")) {
        isQueryConnection = true;
        const queryType = str.substring(7).trim().toLowerCase();
        const isMotd = queryType.startsWith("motd");
        const isVersion = queryType === "version";

        if (isMotd) {
          // Try to ping the upstream Minecraft server for real player count
          let upstream: { online: number; max: number; players: string[] } | null = null;
          if (config.minecraftHost) {
            upstream = await pingUpstream(config.minecraftHost, config.minecraftPort, 2500);
          }
          const online = upstream?.online ?? 0;
          const players = (upstream?.players ?? []).slice(0, 9);
          const response = buildMotdResponse(config, online, players);
          logger.info(
            { clientIp, queryType, upstreamOk: !!upstream, online, players: players.length },
            "[BUNGEE] Sending MOTD response",
          );
          ws.send(response);
          // Close shortly after — MOTD queries are one-shot
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1000, "motd-done");
          }, 200);
          return;
        }

        if (isVersion) {
          const response = buildVersionResponse(config);
          logger.info({ clientIp }, "[BUNGEE] Sending version response");
          ws.send(response);
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1000, "version-done");
          }, 200);
          return;
        }

        logger.warn({ clientIp, queryType }, "[BUNGEE] Unsupported query type");
        ws.send(JSON.stringify({ ...buildBaseResponse(config), type: queryType, data: { unsupported: true } }));
        ws.close(1000, "unsupported-query");
        return;
      }

      // Unknown text command → close
      logger.warn({ clientIp, text: str.slice(0, 80) }, "[BUNGEE] Unknown text command");
      ws.close(1003, "unknown-text");
      return;
    }

    // ---------- BINARY FRAME PATH ----------
    const packetType = buf[0];
    logger.info(
      {
        clientIp,
        isBinary,
        byteLength: buf.length,
        packetType: packetType !== undefined ? `0x${packetType.toString(16).padStart(2, "0")}` : "?",
        hexPreview: buf.slice(0, 64).toString("hex"),
      },
      "[BUNGEE] WS binary frame",
    );

    // EaglerXBungee binary login handshake (PROTOCOL_CLIENT_VERSION = 0x01)
    if (packetType === 0x01 && !isQueryConnection) {
      // The client wants to LOG IN. Our proxy doesn't actually translate
      // EaglerX login → vanilla Minecraft login (that's a much larger project).
      // Send a friendly error so the client shows a clear message instead of
      // "Connection Refused".
      const errMsg = "Login through this proxy is not yet supported. The server appears in your list, but joining requires an EaglerXBungee plugin installed on the server.";
      const errBytes = Buffer.from(errMsg, "utf8");
      // PROTOCOL_SERVER_ERROR (0xFF) + SERVER_ERROR_CUSTOM_MESSAGE (0x08) + uint8 len + msg
      const truncated = errBytes.slice(0, 255);
      const out = Buffer.concat([
        Buffer.from([0xff, 0x08, truncated.length]),
        truncated,
      ]);
      logger.info({ clientIp }, "[BUNGEE] Login attempted — sending unsupported message");
      ws.send(out);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "login-unsupported");
      }, 300);
      return;
    }

    // Legacy/unknown binary packet — log and close
    logger.warn(
      { clientIp, packetType: packetType?.toString(16) },
      "[BUNGEE] Unrecognized binary packet — closing",
    );
    ws.close(1003, "unsupported-binary");
  });

  ws.on("close", (code: number, reason: Buffer) => {
    clearTimeout(silenceTimer);
    logger.info(
      { clientIp, code, reason: reason.toString(), receivedAnyData: firstPacketSeen },
      "[BUNGEE] Client disconnected",
    );
  });

  ws.on("error", (err: Error) => {
    logger.error({ clientIp, errMsg: err.message }, "[BUNGEE] WS error");
  });
}

function createBungeeProxy(
  server: http.Server,
  config: BungeeConfig = DEFAULT_CONFIG,
): WebSocketServer {
  logger.info(
    {
      wsPath: config.wsPath,
      minecraftHost: config.minecraftHost || "(not set)",
      minecraftPort: config.minecraftPort,
      serverName: config.serverName,
    },
    "EaglerCraft Bungee WebSocket proxy starting",
  );

  const wss = new WebSocketServer({
    server,
    path: config.wsPath,
    handleProtocols: (protocols: Set<string>) => {
      const offered = Array.from(protocols);
      const first = offered[0];
      return first || false;
    },
  });

  wss.on("connection", (ws, req) => handleClient(ws, req, config));
  wss.on("error", (err) => logger.error({ errMsg: err.message }, "[BUNGEE] WSS error"));

  return wss;
}

export { createBungeeProxy };
export type { BungeeConfig };
