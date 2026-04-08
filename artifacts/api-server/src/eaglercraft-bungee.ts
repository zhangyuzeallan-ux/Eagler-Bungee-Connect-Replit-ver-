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
  wsPath: process.env["WS_PATH"] || "/eagler",
};

function createBungeeProxy(
  server: http.Server,
  config: BungeeConfig = DEFAULT_CONFIG,
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: config.wsPath,
  });

  logger.info(
    {
      wsPath: config.wsPath,
      minecraftHost: config.minecraftHost,
      minecraftPort: config.minecraftPort,
    },
    "EaglerCraft Bungee WebSocket proxy starting",
  );

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const clientIp =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

    logger.info({ clientIp }, "EaglerCraft client connected");

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
          {
            clientIp,
            host: config.minecraftHost,
            port: config.minecraftPort,
          },
          "Connected to Minecraft server",
        );
      },
    );

    tcpSocket.on("data", (data: Buffer) => {
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

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!tcpSocket.destroyed) {
        if (Buffer.isBuffer(data)) {
          tcpSocket.write(data);
        } else if (data instanceof ArrayBuffer) {
          tcpSocket.write(Buffer.from(data));
        } else if (Array.isArray(data)) {
          for (const chunk of data) {
            tcpSocket.write(chunk);
          }
        }
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      logger.info(
        { clientIp, code, reason: reason.toString() },
        "EaglerCraft client disconnected",
      );
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
  });

  wss.on("error", (err: Error) => {
    logger.error({ err }, "WebSocket server error");
  });

  return wss;
}

export { createBungeeProxy };
export type { BungeeConfig };
