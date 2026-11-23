import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "./api.ts";
import { ApiError2 } from "./api.ts";
import { fmtDual, rememberFocus, restoreFocus, wordDiff } from "./common.ts";

interface QueueItem {
  id: string; version: number; status: string; block_reason: string | null;
  note_text: string; citation_set: { url: string; locator?: string }[];
  rule_binding_id: string; question: string; market_address: string;
  cutoff_at: string; station_external_id: string | null;
}

export function Queue({ client, onError, registerRefresh }: {
  client: ApiClient; onError: (e: unknown) => void;
  registerRefresh: (fn: () => Promise<void>) => () => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, { staleNote: string; by: { version: number; note_text: string } }>>({});

  const load = useCallback(async () => {
    const res = await client.get<{ asOf: string; items: QueueItem[] }>("/api/desk/queue");
    setItems(res.items); setAsOf(res.asOf);
  }, [client]);

  useEffect(() => {
    load().catch(onError);
    return registerRefresh(async () => {
      await load().catch(onError);
      restoreFocus();
    });
  }, [load, onError, registerRefresh]);

  const [pendingRestore, setPendingRestore] = useState(false);
  useEffect(() => {
    if (pendingRestore) { restoreFocus(); setPendingRestore(false); }
  }, [items, pendingRestore]);

  const act = async (item: QueueItem, action: "approve" | "reject") => {
    rememberFocus(`queue:${item.id}`);
    try {
      if (action === "approve") await client.post(`/api/candidates/${item.id}/approve`);
      else await client.post(`/api/candidates/${item.id}/reject`);
      setPendingRestore(true);
      await load();
    } catch (e) {
      if (e instanceof ApiError2 && e.status === 409 && e.detail?.supersededBy) {
        const s = e.detail as { staleNote: string; supersededBy: { version: number; note_text: string } };
        setConflicts((c) => ({ ...c, [item.id]: { staleNote: s.staleNote, by: s.supersededBy } }));
        await load();
      } else onError(e);
    }
  };

  return (
    <section aria-labelledby="queue-h">
      <h2 id="queue-h">Review queue</h2>
      <p className="muted">Projection as of {asOf ? fmtDual(asOf, "UTC") : "…"}.
        {items.length === 0 && " Nothing awaiting review."}</p>
      {items.map((i) => (
        <article key={i.id} className="queue-item" tabIndex={-1}
          data-focus-key={`queue:${i.id}`} aria-label={`draft for ${i.question}`}>
          <header>
            <a href={`#/market/${encodeURIComponent(i.rule_binding_id)}`}>{i.question}</a>
            <span className="muted"> · station {i.station_external_id ?? "unresolved"} · v{i.version} · {i.status.replaceAll("_", " ")}</span>
          </header>
          <p className="note">{i.note_text}</p>
          <p className="muted small">cutoff {fmtDual(i.cutoff_at, "UTC")}</p>
          <ul className="citations">
            {i.citation_set.map((c, k) => (
              <li key={k}><a href={c.url} target="_blank" rel="noreferrer">{c.url}</a>
                {c.locator && <span className="mono small"> {c.locator}</span>}</li>
            ))}
          </ul>
          {i.block_reason && <p className="blocked">Blocked: {i.block_reason} — cannot be approved or sent.</p>}
          <div className="actions">
            {i.status === "pending_review" && (
              <>
                <button type="button"
                  aria-label={`approve draft ${i.id.slice(0, 8)} version ${i.version}`}
                  onClick={() => void act(i, "approve")}>Approve</button>
                <button type="button" onClick={() => void act(i, "reject")}>Reject</button>
              </>
            )}
            {i.status === "approved" && <span className="ok">Approved — see receipts for dispatch state.</span>}
          </div>
          {conflicts[i.id] && (() => { const cf = conflicts[i.id]!; return (
            <div role="alert" className="conflict">
              <strong>Conflict: superseded while you reviewed.</strong>
              <p className="note diff">
                {wordDiff(cf.staleNote, cf.by.note_text).map((w, k) => (
                  <span key={k} className={w.type === "ins" ? "ins" : w.type === "del" ? "del" : undefined}>{w.text}</span>
                ))}
              </p>
              <p>New version is v{cf.by.version} — reload the market and review that draft.</p>
            </div>
          ); })()}
        </article>
      ))}
    </section>
  );
}
