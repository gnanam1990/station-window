import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api.ts";
import { fmtDual, fmtRemaining, loadFilter, rememberFocus, restoreFocus, saveFilter } from "./common.ts";

interface InboxItem {
  marketVersionId: string; marketAddress: string; question: string;
  evidenceCutoffAtUtc: string; localZone: string | null; cutoffLocal: string | null;
  remainingMs: number;
  stationExternalId: string | null; stationAuthority: string | null; stationLabel: string | null;
  bindingId: string | null; bindingStatus: string | null;
  latestObservation: { observedAtUtc: string; firstSeenAtUtc: string; value: string | null; unit: string; variable: string } | null;
  evidenceState: string; permittedAction: { kind: string; label: string; reason?: string };
}

export function Inbox({ client, onError, registerRefresh }: {
  client: ApiClient; onError: (e: unknown) => void;
  registerRefresh: (fn: () => Promise<void>) => () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [filter, setFilter] = useState(loadFilter("inbox"));
  const tableRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await client.get<{ asOf: string; items: InboxItem[] }>("/api/desk/inbox");
    setItems(res.items); setAsOf(res.asOf);
  }, [client]);

  useEffect(() => {
    load().catch(onError);
    return registerRefresh(async () => {
      await load().catch(onError);
      // if focus was lost by the re-render, return it to the originating row
      if (!tableRef.current?.contains(document.activeElement)) restoreFocus(tableRef.current ?? document);
    });
  }, [load, onError, registerRefresh]);

  const shown = items.filter((i) => !filter || i.evidenceState === filter);
  const states = [...new Set(items.map((i) => i.evidenceState))].sort();

  return (
    <section aria-labelledby="inbox-h">
      <h2 id="inbox-h">Market inbox</h2>
      <p className="muted">
        Ordered by actionable cutoff. Projection as of {asOf ? fmtDual(asOf, "UTC") : "…"}.
        {items.length === 0 && " Empty market inventory — import a market card to begin."}
      </p>
      <div className="filter-row">
        <label htmlFor="state-filter">Evidence state</label>
        <select id="state-filter" value={filter}
          onChange={(e) => { setFilter(e.target.value); saveFilter("inbox", e.target.value); }}>
          <option value="">All states</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div ref={tableRef} className="inbox-table" role="region" aria-label="markets" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Station</th>
              <th scope="col">Cutoff</th>
              <th scope="col">Latest observation</th>
              <th scope="col">Evidence state</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.marketVersionId}>
                <td data-h="Question"><a href={`#/market/${encodeURIComponent(i.bindingId ?? "")}`}>{i.question}</a></td>
                <td data-h="Station">
                  {i.stationExternalId
                    ? <><strong>{i.stationAuthority}/{i.stationExternalId}</strong>
                        {i.stationLabel ? <span className="muted"> {i.stationLabel}</span> : null}</>
                    : <span className="muted">unresolved</span>}
                </td>
                <td data-h="Cutoff">
                  <div>{fmtDual(i.evidenceCutoffAtUtc, i.localZone)}</div>
                  <div className={i.remainingMs <= 0 ? "over" : "muted"}>{fmtRemaining(i.remainingMs)}</div>
                </td>
                <td data-h="Latest observation">
                  {i.latestObservation
                    ? <span className="num">{i.latestObservation.value ?? "—"}{" "}
                        <abbr title={i.latestObservation.unit}>{i.latestObservation.unit}</abbr>
                        <span className="muted"> @ {new Date(i.latestObservation.observedAtUtc).toISOString().slice(11, 16)}Z</span>
                      </span>
                    : <span className="muted">none retained</span>}
                </td>
                <td data-h="Evidence state"><span className={`state s-${i.evidenceState}`}>{i.evidenceState.replaceAll("_", " ")}</span></td>
                <td data-h="Action">
                  <button type="button" data-focus-key={`inbox:${i.marketVersionId}`}
                    title={i.permittedAction.reason}
                    onClick={() => {
                      rememberFocus(`inbox:${i.marketVersionId}`);
                      if (i.bindingId) location.hash = `#/market/${encodeURIComponent(i.bindingId)}`;
                    }}>
                    {i.permittedAction.label}
                  </button>
                  {i.permittedAction.reason && <div className="muted small">{i.permittedAction.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
