import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

// EaglerCraft browser client sends HTTP GET to the WebSocket path before attempting
// the WebSocket upgrade, to verify the server is reachable. Without a 200 response
// it shows a red X and never tries WebSocket. Return an EaglerXBungee-compatible page.
router.get("/eagler", (_req: Request, res: Response) => {
  const wsPath = process.env["WS_PATH"] || "/api/eagler";
  const serverName = process.env["SERVER_NAME"] || "EaglerCraft Bungee Proxy";
  const domain = (process.env["REPLIT_DOMAINS"] || "").split(",")[0]?.trim() || "localhost";
  const wsUrl = `wss://${domain}${wsPath}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-EaglerCraft-Server", wsUrl);
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${serverName}</title>
</head>
<body>
<h2>${serverName}</h2>
<p>This is an EaglerCraft WebSocket proxy server.</p>
<p>Connect using EaglerCraft 1.8.8 with server address: <code>${wsUrl}</code></p>
</body>
</html>`);
});

router.get("/bungee/status", (_req: Request, res: Response) => {
  const mcHost = process.env["MC_HOST"] || "";
  const mcPort = Number(process.env["MC_PORT"] || "25565");
  const wsPath = process.env["WS_PATH"] || "/api/eagler";

  res.json({
    status: "running",
    proxy: {
      wsPath,
      minecraftHost: mcHost || "(not configured)",
      minecraftPort: mcPort,
      ready: !!mcHost,
    },
    instructions: {
      eaglercraftServer: `wss://<your-domain>${wsPath}`,
      note: mcHost
        ? `Proxy is connected to ${mcHost}:${mcPort}`
        : "Set MC_HOST environment variable to your Aternos server hostname",
      requirements: [
        "Aternos server must be ONLINE (started) before connecting",
        "Aternos server must run Minecraft 1.8.x (vanilla protocol 47)",
        "Aternos server MUST have online-mode set to false (Server Settings → Online Mode → off)",
        "Without offline-mode, EaglerCraft players will be kicked with 'Failed to verify username'",
      ],
    },
  });
});

export default router;
