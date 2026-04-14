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

// Read a length-prefixed string from a buffer starting at offset
// Format: [uint16 BE length][utf8 bytes]
function readLenString(buf: Buffer, offset: number): { value: string; next: number } | null {
  if (buf.length < offset + 2) return null;
  const len = buf.readUInt16BE(offset);
  if (buf.length < offset + 2 + len) return null;
  return {
    value: buf.slice(offset + 2, offset + 2 + len).toString("utf8"),
    next: offset + 2 + len,
  };
}

// Write a length-prefixed string into a buffer builder
function lenString(s: string): Buffer {
  const str = Buffer.from(s, "utf8");
  const out = Buffer.alloc(2 + str.length);
  out.writeUInt16BE(str.length, 0);
  str.copy(out, 2);
  return out;
}

function buildMotdResponse(): Buffer {
  // EaglercraftX 1.8 MOTD response packet (type 0x02)
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

// Build a VarInt (Minecraft protocol)
function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

// Build Minecraft 1.8 Handshake packet for the proxy to send to the server
function buildMcHandshake(host: string, port: number, nextState: number): Buffer {
  const protoVersion = writeVarInt(47); // Minecraft 1.8 protocol
  const serverAddr = lenString(host);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const next = writeVarInt(nextState);
  const payload = Buffer.concat([protoVersion, serverAddr, portBuf, next]);
  const packetId = writeVarInt(0x00);
  const payloadWithId = Buffer.concat([packetId, payload]);
  const lenPrefix = writeVarInt(payloadWithId.length);
  return Buffer.concat([lenPrefix, payloadWithId]);
}

// Build Minecraft 1.8 Status Request packet
function buildMcStatusRequest(): Buffer {
  // Packet ID 0x00, no payload
  return Buffer.from([0x01, 0x00]);
}

// Build Minecraft 1.8 Login Start packet
function buildMcLoginStart(username: string): Buffer {
  const nameBuf = lenString(username);
  const packetId = writeVarInt(0x00);
  const payload = Buffer.concat([packetId, nameBuf]);
  const lenPrefix = writeVarInt(payload.length);
  return Buffer.concat([lenPrefix, payload]);
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
  const path = req.url || "(unknown)";

  logger.info({ clientIp, path, protocol: ws.protocol }, "EaglerCraft client connected");

  if (!config.minecraftHost) {
    logger.error("MC_HOST is not set — cannot connect to Minecraft server");
    ws.close(1011, "Proxy misconfigured: MC_HOST not set");
    return;
  }

  let handshakeDone = false;
  let tcpSocket: net.Socket | null = null;

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.concat(data as Buffer[]);

    logger.info(
      {
        clientIp,
        byteLength: buf.byteLength,
        hexPreview: buf.slice(0, 32).toString("hex"),
        textPreview: buf.slice(0, 64).toString("utf8").replace(/[^\x20-\x7e]/g, "?"),
      },
      "WS→proxy data",
    );

    // If handshake not done yet, inspect the first packet
    if (!handshakeDone) {
      const packetType = buf[0];

      // EaglercraftX MOTD/status ping: type 0x02 + "eaglercraft"
      if (packetType === 0x02) {
        const str = readLenString(buf, 1);
        if (str && str.value === "eaglercraft") {
          logger.info({ clientIp }, "EaglercraftX MOTD ping — responding with server info");
          const motd = buildMotdResponse();
          ws.send(motd);
          // Keep connection open briefly so client can read the response
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1000, "motd");
          }, 500);
          return;
        }
      }

      // EaglercraftX login handshake: type 0x01 = client hello
      if (packetType === 0x01) {
        const str = readLenString(buf, 1);
        if (str && str.value === "eaglercraft") {
          logger.info({ clientIp }, "EaglercraftX login handshake detected");
          // Server hello response: accept the connection
          // type 0x01 + string "EAGLERXBUNGEE"
          const serverHello = Buffer.concat([
            Buffer.from([0x01]),
            lenString("EAGLERXBUNGEE"),
          ]);
          ws.send(serverHello);
          handshakeDone = true;
          // Now start forwarding to Minecraft
          startTcpRelay(ws, config, clientIp, null);
          return;
        }
      }

      // Fallback: treat as raw Minecraft protocol, relay directly
      logger.info({ clientIp, packetType: packetType.toString(16) }, "Unknown packet type — relaying directly to Minecraft");
      handshakeDone = true;
      startTcpRelay(ws, config, clientIp, buf);
      return;
    }

    // After handshake: forward to TCP
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(buf);
    }
  });

  // Store tcp socket reference so post-handshake messages can forward
  function startTcpRelay(ws: WebSocket, config: BungeeConfig, clientIp: string, firstBuf: Buffer | null) {
    const sock = net.createConnection(
      { host: config.minecraftHost, port: config.minecraftPort },
      () => {
        logger.info({ clientIp, host: config.minecraftHost, port: config.minecraftPort }, "Connected to Minecraft server");
        if (firstBuf && !sock.destroyed) sock.write(firstBuf);
      },
    );

    tcpSocket = sock;

    sock.on("data", (data: Buffer) => {
      logger.info(
        { clientIp, byteLength: data.byteLength, hexPreview: data.slice(0, 32).toString("hex") },
        "MC→WS data",
      );
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    sock.on("end", () => {
      logger.info({ clientIp }, "Minecraft server closed connection");
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Minecraft server disconnected");
    });

    sock.on("error", (err: Error) => {
      logger.error({ clientIp, err }, "TCP socket error");
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Connection to Minecraft server failed");
    });
  }

  ws.on("close", (code: number, reason: Buffer) => {
    logger.info({ clientIp, code, reason: reason.toString() }, "EaglerCraft client disconnected");
    if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
  });

  ws.on("error", (err: Error) => {
    logger.error({ clientIp, err }, "WebSocket client error");
    if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
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
    handleProtocols: (protocols: Set<string>) => {
      const first = protocols.values().next().value;
      return first ? first : false;
    },
  });

  wss.on("connection", (ws, req) => handleClient(ws, req, config));
  wss.on("error", (err) => logger.error({ err }, "WebSocket server error"));

  return wss;
}

export { createBungeeProxy };
export type { BungeeConfig };
