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

// WebSocket connectivity test page — open in browser to diagnose WS issues
router.get("/ws-test", (_req: Request, res: Response) => {
  const wsEchoUrl = _req.headers["x-forwarded-proto"] === "https" || _req.secure
    ? `wss://${_req.headers.host}/api/ws-echo`
    : `ws://${_req.headers.host}/api/ws-echo`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>WebSocket Test</title>
<style>
  body{font-family:monospace;padding:20px;background:#111;color:#eee}
  #log{background:#000;padding:10px;border-radius:4px;height:300px;overflow-y:auto;white-space:pre-wrap}
  button{margin:4px;padding:8px 16px;cursor:pointer}
  .ok{color:#4f4}
  .err{color:#f44}
  .info{color:#48f}
</style>
</head>
<body>
<h2>WebSocket Connectivity Test</h2>
<p>Echo URL: <code id="url">${wsEchoUrl}</code></p>
<button onclick="doTest()">▶ Run Test</button>
<button onclick="document.getElementById('log').textContent=''">Clear</button>
<div id="log"></div>
<script>
const log = document.getElementById('log');
function append(cls, msg) {
  const t = new Date().toISOString().slice(11,23);
  log.textContent += '['+t+'] ' + msg + '\\n';
  log.scrollTop = log.scrollHeight;
}
function doTest() {
  const url = document.getElementById('url').textContent.trim();
  append('info', 'Connecting to ' + url + ' ...');
  let ws;
  try { ws = new WebSocket(url); } catch(e) { append('err', 'Constructor threw: '+e); return; }
  ws.binaryType = 'arraybuffer';
  const t0 = Date.now();
  ws.onopen = () => {
    append('ok', 'OPEN ('+((Date.now()-t0))+'ms)  readyState='+ws.readyState);
    append('info', 'Sending text: hello');
    ws.send('hello');
    append('info', 'Sending binary: [0x01 0x02 0x03]');
    ws.send(new Uint8Array([1,2,3]).buffer);
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      const arr = new Uint8Array(e.data);
      append('ok', 'BINARY msg len='+arr.length+' hex='+Array.from(arr).map(x=>x.toString(16).padStart(2,'0')).join(''));
    } else {
      append('ok', 'TEXT msg: '+e.data);
    }
  };
  ws.onerror = (e) => append('err', 'ERROR event (see browser console for details)');
  ws.onclose = (e) => append(e.wasClean?'ok':'err',
    'CLOSE code='+e.code+' wasClean='+e.wasClean+' reason='+(e.reason||'(none)'));
  setTimeout(()=>{ if(ws.readyState!==3) ws.close(); }, 10000);
}
</script>
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
