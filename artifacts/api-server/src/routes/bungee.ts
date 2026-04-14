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
    },
  });
});

export default router;
