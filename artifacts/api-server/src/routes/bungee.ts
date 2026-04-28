import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/bungee/status", (_req, res) => {
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
