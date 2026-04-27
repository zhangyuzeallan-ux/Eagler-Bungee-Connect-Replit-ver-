import { WebSocketServer, WebSocket } from "ws";
import * as net from "net";
import * as http from "http";
import { logger } from "./lib/logger";

interface BungeeConfig {
  minecraftHost: string;
  minecraftPort: number;
  wsPath: string;
}

const DEFAULT_CONFIG: BungeeConfig = {
  minecraftHost: process.env["MC_HOST"] || "",
  minecraftPort: Number(process.env["MC_PORT"] || "25565"),
  wsPath: process.env["WS_PATH"] || "/api/eagler",
};

function readLenString(buf: Buffer, offset: number): { value: string; next: number } | null {
  if (buf.length < offset + 2) return null;
  const len = buf.readUInt16BE(offset);
  if (buf.length < offset + 2 + len) return null;
  return {
    value: buf.slice(offset + 2, offset + 2 + len).toString("utf8"),
    next: offset + 2 + len,
  };
}

function lenString(s: string): Buffer {
  const str = Buffer.from(s, "utf8");
  const out = Buffer.alloc(2 + str.length);
  out.writeUInt16BE(str.length, 0);
  str.copy(out, 2);
  return out;
}

// Build a "server version" hello packet that EaglerXBungee 1.3.x sends
// Format guess: [0x02][short numVersions][shorts versions...][string brand][string version]
function buildServerHello(): Buffer {
  const brand = lenString("EaglerXBungee");
  const version = lenString("1.3.4");
  // Type 0x02, num versions 1, version 2 (EaglerXBungee uses v1 or v2)
  const header = Buffer.from([0x02, 0x00, 0x01, 0x00, 0x02]);
  return Buffer.concat([header, brand, version]);
}

function buildMotdResponse(): Buffer {
  const json = JSON.stringify({
    vers: [0, 0],
    cracked: true,
    name: "EaglerCraft Bungee",
    motd: "§aConnecting to Aternos...",
    icon: null,
    players_online: 0,
    players_max: 20,
  });
  const jsonBuf = lenString(json);
  return Buffer.concat([Buffer.from([0x02]), jsonBuf]);
}

function handleClient(
  ws: WebSocket,
  req: http.IncomingMessage,
  config: BungeeConfig,
) {
  const clientIp =
    (req.headers["x-forwarded-for"] as string) ||
    req.socket.remoteAddress ||
    "unknown";

  // LOG EVERYTHING about the upgrade request
  logger.info(
    {
      clientIp,
      url: req.url,
      headers: req.headers,
      protocol: ws.protocol || "(none)",
    },
    "[BUNGEE] Client connected — full request info",
  );

  if (!config.minecraftHost) {
    ws.close(1011, "Proxy misconfigured: MC_HOST not set");
    return;
  }

  let firstMessageSeen = false;
  let tcpSocket: net.Socket | null = null;

  // Set a timeout: if client sends nothing within 5s, log it
  const silenceTimer = setTimeout(() => {
    if (!firstMessageSeen) {
      logger.warn({ clientIp }, "[BUNGEE] Client connected but sent NO data after 5s");
    }
  }, 5000);

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    firstMessageSeen = true;
    clearTimeout(silenceTimer);

    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.concat(data as Buffer[]);

    logger.info(
      {
        clientIp,
        isBinary,
        byteLength: buf.byteLength,
        hexPreview: buf.slice(0, 64).toString("hex"),
        textPreview: buf.slice(0, 80).toString("utf8").replace(/[^\x20-\x7e]/g, "?"),
      },
      "[BUNGEE] WS→proxy data",
    );

    // If TCP relay already started, just forward
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(buf);
      return;
    }

    // Inspect first byte to decide what to do
    const packetType = buf[0];

    // EaglercraftX MOTD/version request: type 0x02 + "eaglercraft"
    if (packetType === 0x02) {
      const str = readLenString(buf, 1);
      if (str && (str.value === "eaglercraft" || str.value === "eaglercraftx")) {
        logger.info({ clientIp, brand: str.value }, "[BUNGEE] EaglercraftX status/version ping — responding with MOTD");
        const motd = buildMotdResponse();
        ws.send(motd);
        // Keep open briefly so client can read
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.close(1000, "motd-done");
        }, 500);
        return;
      }
      logger.info({ clientIp, parsed: str?.value }, "[BUNGEE] 0x02 packet but not 'eaglercraft' — relaying to TCP");
    }

    // For everything else, start TCP relay and forward
    logger.info({ clientIp, packetType: packetType?.toString(16) }, "[BUNGEE] Starting TCP relay to Minecraft");
    startTcpRelay(buf);
  });

  function startTcpRelay(firstBuf: Buffer | null) {
    const sock = net.createConnection(
      { host: config.minecraftHost, port: config.minecraftPort },
      () => {
        logger.info({ clientIp, host: config.minecraftHost, port: config.minecraftPort }, "[BUNGEE] TCP connected to Minecraft");
        if (firstBuf && !sock.destroyed) sock.write(firstBuf);
      },
    );
    tcpSocket = sock;

    sock.on("data", (data: Buffer) => {
      logger.info(
        { clientIp, byteLength: data.byteLength, hexPreview: data.slice(0, 64).toString("hex") },
        "[BUNGEE] MC→WS data",
      );
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    sock.on("end", () => {
      logger.info({ clientIp }, "[BUNGEE] MC closed connection");
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "mc-closed");
    });
    sock.on("error", (err: Error) => {
      logger.error({ clientIp, errMsg: err.message }, "[BUNGEE] TCP error");
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "tcp-error");
    });
  }

  ws.on("close", (code: number, reason: Buffer) => {
    clearTimeout(silenceTimer);
    logger.info(
      { clientIp, code, reason: reason.toString(), receivedAnyData: firstMessageSeen },
      "[BUNGEE] Client disconnected",
    );
    if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
  });

  ws.on("error", (err: Error) => {
    logger.error({ clientIp, errMsg: err.message }, "[BUNGEE] WS error");
    if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
  });

  ws.on("ping", (data: Buffer) => {
    logger.info({ clientIp, hex: data.toString("hex") }, "[BUNGEE] WS ping received");
  });
  ws.on("pong", (data: Buffer) => {
    logger.info({ clientIp, hex: data.toString("hex") }, "[BUNGEE] WS pong received");
  });
}

function createBungeeProxy(
  server: http.Server,
  config: BungeeConfig = DEFAULT_CONFIG,
): WebSocketServer {
  logger.info(
    { wsPath: config.wsPath, minecraftHost: config.minecraftHost, minecraftPort: config.minecraftPort },
    "EaglerCraft Bungee WebSocket proxy starting",
  );

  const wss = new WebSocketServer({
    server,
    path: config.wsPath,
    handleProtocols: (protocols: Set<string>, req: http.IncomingMessage) => {
      const offered = Array.from(protocols);
      logger.info({ offered, url: req.url }, "[BUNGEE] handleProtocols called");
      // Accept whatever subprotocol the client offers; fall back to no subprotocol
      const first = offered[0];
      return first || false;
    },
  });

  // Log every upgrade attempt
  server.on("upgrade", (req, _socket, _head) => {
    logger.info(
      {
        url: req.url,
        origin: req.headers["origin"],
        userAgent: req.headers["user-agent"],
        subprotocol: req.headers["sec-websocket-protocol"],
        clientIp: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
      },
      "[BUNGEE] HTTP upgrade request",
    );
  });

  wss.on("connection", (ws, req) => handleClient(ws, req, config));
  wss.on("error", (err) => logger.error({ errMsg: err.message }, "[BUNGEE] WSS error"));

  return wss;
}

export { createBungeeProxy };
export type { BungeeConfig };
