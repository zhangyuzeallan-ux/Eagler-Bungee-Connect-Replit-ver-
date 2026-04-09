import { useEffect, useState } from "react";

interface BungeeStatus {
  status: string;
  proxy: {
    wsPath: string;
    minecraftHost: string;
    minecraftPort: number;
    ready: boolean;
  };
  instructions: {
    eaglercraftServer: string;
    note: string;
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="ml-2 px-2 py-0.5 text-xs rounded bg-accent text-accent-foreground hover:opacity-80 transition-opacity font-mono"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function StatusDot({ ready }: { ready: boolean }) {
  return (
    <span className="relative flex h-3 w-3">
      {ready && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
      )}
      <span
        className={`relative inline-flex rounded-full h-3 w-3 ${ready ? "bg-primary" : "bg-destructive"}`}
      />
    </span>
  );
}

export default function App() {
  const [status, setStatus] = useState<BungeeStatus | null>(null);
  const [error, setError] = useState(false);
  const [wssUrl, setWssUrl] = useState("");

  useEffect(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, "");
    fetch(`${base}/api/bungee/status`)
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => setError(true));

    const host = window.location.host;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    setWssUrl(`${proto}://${host}/eagler`);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-6">

        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="text-3xl">⛏</span>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              EaglerCraft Bungee
            </h1>
          </div>
          <p className="text-muted-foreground text-sm">
            WebSocket proxy — connect EaglerCraft to your Aternos server
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Proxy Status</span>
            <div className="flex items-center gap-2">
              <StatusDot ready={status?.proxy.ready ?? false} />
              <span className={`text-sm font-medium ${status?.proxy.ready ? "text-primary" : "text-destructive"}`}>
                {error
                  ? "Unreachable"
                  : status === null
                  ? "Loading..."
                  : status.proxy.ready
                  ? "Ready"
                  : "MC_HOST not configured"}
              </span>
            </div>
          </div>

          <div className="border-t border-border pt-4 space-y-3">
            <Row label="Minecraft Server" value={status?.proxy.minecraftHost ?? "—"} />
            <Row label="Port" value={status ? String(status.proxy.minecraftPort) : "—"} />
            <Row label="WS Path" value={status?.proxy.wsPath ?? "—"} />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <p className="text-sm font-semibold text-foreground">Your EaglerCraft Server Address</p>
          <div className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2">
            <code className="text-sm text-primary font-mono break-all">{wssUrl || "Loading..."}</code>
            {wssUrl && <CopyButton text={wssUrl} />}
          </div>
          <p className="text-xs text-muted-foreground">
            Paste this into EaglerCraft when adding a server (use the WSS:// option).
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <p className="text-sm font-semibold text-foreground">Quick Setup Guide</p>
          <ol className="space-y-2 text-sm text-muted-foreground list-none">
            <Step n={1} text="Start your Aternos server — it must be online for the proxy to work." />
            <Step n={2} text={`Set the MC_HOST environment variable to your Aternos server address (e.g. yourserver.aternos.me).`} />
            <Step n={3} text="Open EaglerCraft, click Add Server, and paste the address above." />
            <Step n={4} text="Deploy this Replit project so the proxy stays online 24/7." />
          </ol>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Powered by Replit · EaglerCraft Bungee Proxy
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-bold">
        {n}
      </span>
      <span>{text}</span>
    </li>
  );
}
