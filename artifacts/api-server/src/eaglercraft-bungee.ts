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

  const tcpSocket = net.createConnection(
    {
      host: config.minecraftHost,
      port: config.minecraftPort,
    },
    () => {
      logger.info(
        { clientIp, host: config.minecraftHost, port: config.minecraftPort },
        "Connected to Minecraft server",
      );
    },
  );

  tcpSocket.on("data", (data: Buffer) => {
    logger.info(
      {
        clientIp,
        byteLength: data.byteLength,
        hexPreview: data.slice(0, 32).toString("hex"),
        textPreview: data.slice(0, 64).toString("utf8").replace(/[^\x20-\x7e]/g, "?"),
      },
      "MC→WS data",
    );
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  tcpSocket.on("end", () => {
    logger.info({ clientIp }, "Minecraft server closed connection");
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "Minecraft server disconnected");
    }
  });

  tcpSocket.on("error", (err: Error) => {
    logger.error({ clientIp, err }, "TCP socket error");
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, "Connection to Minecraft server failed");
    }
  });

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
      "WS→MC data",
    );

    if (!tcpSocket.destroyed) {
      tcpSocket.write(buf);
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    logger.info({ clientIp, code, reason: reason.toString() }, "EaglerCraft client disconnected");
    if (!tcpSocket.destroyed) {
      tcpSocket.destroy();
    }
  });

  ws.on("error", (err: Error) => {
    logger.error({ clientIp, err }, "WebSocket client error");
    if (!tcpSocket.destroyed) {
      tcpSocket.destroy();
    }
  });
}

function createBungeeProxy(
  server: http.Server,
  config: BungeeConfig = DEFAULT_CONFIG,
): WebSocketServer {
  logger.info(
    {
      wsPath: config.wsPath,
      minecraftHost: config.minecraftHost,
      minecraftPort: config.minecraftPort,
    },
    "EaglerCraft Bungee WebSocket proxy starting",
  );

  const wssOptions = {
    server,
    handleProtocols: (protocols: Set<string>) => {
      const first = protocols.values().next().value;
      if (first) {
        logger.info({ protocol: first }, "WS subprotocol accepted");
        return first;
      }
      return false;
    },
  };

  const wss = new WebSocketServer({ ...wssOptions, path: config.wsPath });
  wss.on("connection", (ws, req) => handleClient(ws, req, config));
  wss.on("error", (err) => logger.error({ err }, "WebSocket server error"));

  return wss;
}

export { createBungeeProxy };
export type { BungeeConfig };
