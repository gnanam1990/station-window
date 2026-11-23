import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClient, ApiError2 } from "./api.ts";
import { Inbox } from "./Inbox.tsx";
import { MarketDetail } from "./MarketDetail.tsx";
import { Queue } from "./Queue.tsx";
import { Receipts } from "./Receipts.tsx";

type Route = { name: "inbox" } | { name: "detail"; bindingId: string }
  | { name: "queue" } | { name: "receipts" };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const m = h.match(/^market\/(.+)$/);
  if (m?.[1]) return { name: "detail", bindingId: decodeURIComponent(m[1]) };
  if (h === "queue") return { name: "queue" };
  if (h === "receipts") return { name: "receipts" };
  return { name: "inbox" };
}

export function App({ client }: { client: ApiClient }) {
  const [route, setRoute] = useState<Route>(parseHash());
  // 'unknown' until the refresh-resume probe answers — session cookie restores
  // the login without re-entering the API key
  const [loggedIn, setLoggedIn] = useState<"unknown" | boolean>("unknown");
  const [apiKey, setApiKey] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const liveRef = useRef<HTMLSpanElement>(null);
  const refreshFns = useRef(new Set<() => Promise<void>>());

  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => { void client.resume().then(setLoggedIn); }, [client]);

  const reportError = useCallback((e: unknown) => {
    const msg = e instanceof ApiError2 ? `${e.code}: ${e.message}` : String(e);
    setErrors((es) => [...es.slice(-4), msg]);
  }, []);

  const registerRefresh = useCallback((fn: () => Promise<void>) => {
    refreshFns.current.add(fn);
    return () => { refreshFns.current.delete(fn); };
  }, []);

  const refreshAll = useCallback(async () => {
    for (const fn of [...refreshFns.current]) await fn().catch(reportError);
    setLastRefresh(new Date().toISOString());
  }, [reportError]);

  useEffect(() => {
    if (paused || loggedIn !== true) return;
    const t = setInterval(() => void refreshAll(), 30_000);
    return () => clearInterval(t);
  }, [paused, loggedIn, refreshAll]);

  if (loggedIn === "unknown") return <main className="login" aria-busy />;

  if (!loggedIn) {
    return (
      <main className="login">
        <h1>Station Window</h1>
        <form onSubmit={async (e) => {
          e.preventDefault();
          try { await client.login(apiKey); setLoggedIn(true); }
          catch (err) { reportError(err); }
        }}>
          <label htmlFor="apikey">Desk API key</label>
          <input id="apikey" type="password" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
          <button type="submit">Sign in</button>
          {errors.length > 0 && (
            <div role="alert" className="error-summary">
              {errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
        </form>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <h1>Station Window</h1>
        <nav aria-label="Primary">
          <a href="#/inbox" aria-current={route.name === "inbox" ? "page" : undefined}>Market inbox</a>
          <a href="#/queue" aria-current={route.name === "queue" ? "page" : undefined}>Review queue</a>
          <a href="#/receipts" aria-current={route.name === "receipts" ? "page" : undefined}>Receipts</a>
        </nav>
        <div className="refresh-bar">
          <span aria-live="polite" ref={liveRef}>
            {lastRefresh ? `Last refreshed ${new Date(lastRefresh).toLocaleTimeString()}` : "Not yet refreshed"}
          </span>
          <button type="button" onClick={() => void refreshAll()}>Refresh</button>
          <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? "Resume updates" : "Pause updates"}
          </button>
        </div>
      </header>
      {errors.length > 0 && (
        <div role="alert" aria-label="errors" className="error-summary">
          <strong>Something needs attention</strong>
          <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          <button type="button" onClick={() => setErrors([])}>Dismiss</button>
        </div>
      )}
      {route.name === "inbox" && <Inbox client={client} onError={reportError} registerRefresh={registerRefresh} />}
      {route.name === "detail" && <MarketDetail client={client} bindingId={route.bindingId} onError={reportError} />}
      {route.name === "queue" && <Queue client={client} onError={reportError} registerRefresh={registerRefresh} />}
      {route.name === "receipts" && <Receipts client={client} onError={reportError} registerRefresh={registerRefresh} />}
    </main>
  );
}
