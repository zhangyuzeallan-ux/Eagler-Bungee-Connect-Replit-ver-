import * as http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { createBungeeProxy } from "./eaglercraft-bungee";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);

createBungeeProxy(server);

server.listen(port, () => {
  logger.info({ port }, "Server listening");
  logger.info(
    {
      wsPath: process.env["WS_PATH"] || "/eagler",
      mcHost: process.env["MC_HOST"] || "(not set)",
      mcPort: process.env["MC_PORT"] || "25565",
    },
    "EaglerCraft Bungee proxy active",
  );
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
