import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "./api.ts";
import { fmtDual } from "./common.ts";

interface Intent { id: string; state: string; block_reason: string | null; market_address: string; created_at: string; updated_at: string; attempts: number }
interface Receipt { intent_id: string; kind: string; remote_id: string | null; remote_status: string | null; received_at: string }
interface Reward { intent_id: string; remote_status: string; verdict: string | null; bounty_amount_raw: string | null; bounty_state: string | null; zero_pay_reason: string | null; last_poll_at: string }
interface Alert { caseId: string; intentId: string; openedAt: string; action: string; detail: unknown }

export function Receipts({ client, onError, registerRefresh }: {
  client: ApiClient; onError: (e: unknown) => void;
  registerRefresh: (fn: () => Promise<void>) => () => void;
}) {
  const [d, setD] = useState<{
    asOf: string; localPreparation: Intent[]; transportUncertainty: Intent[];
    remoteJudgment: { intents: Intent[]; receipts: Receipt[]; rewards: Reward[] };
    money: Reward[]; alerts: Alert[];
  } | null>(null);
  const [reconciled, setReconciled] = useState(false);

  const load = useCallback(async () => {
    setD(await client.get("/api/desk/receipts"));
  }, [client]);
  useEffect(() => {
    load().catch(onError);
    return registerRefresh(async () => { await load().catch(onError); });
  }, [load, onError, registerRefresh]);

  if (!d) return <p aria-busy>Loading receipts…</p>;

  const reconcile = async () => {
    // reconciliation is a provider status read — never a new send by default
    await client.post("/api/outbox/poll").catch(onError);
    setReconciled(true);
    await load().catch(onError);
  };

  return (
    <section aria-labelledby="receipts-h">
      <h2 id="receipts-h">Receipts &amp; remote state</h2>
      <p className="muted">Projection as of {fmtDual(d.asOf, "UTC")}. Local prep, transport
        uncertainty, remote judgment and money are tracked separately.</p>

      {d.alerts.length > 0 && (
        <div role="alert" className="alerts">
          <strong>{d.alerts.length} unresolved external effect{d.alerts.length > 1 ? "s" : ""}.</strong>
          {d.alerts.map((a) => (
            <p key={a.caseId}>
              Intent {a.intentId.slice(0, 8)} opened {fmtDual(a.openedAt, "UTC")} —{" "}
              <button type="button" onClick={() => void reconcile()}>Reconcile (read remote state)</button>
              {" "}· a new send is not the default action.
            </p>
          ))}
        </div>
      )}
      {reconciled && <p role="status" className="ok">Remote state re-read; classification updated from the provider.</p>}

      <h3>Local preparation</h3>
      <ul className="receipt-list">
        {d.localPreparation.map((i) => (
          <li key={i.id}>intent {i.id.slice(0, 8)} · {i.state}{i.block_reason ? ` (${i.block_reason})` : ""} · {i.attempts} attempt{i.attempts === 1 ? "" : "s"} · {fmtDual(i.updated_at, "UTC")}</li>
        ))}
        {d.localPreparation.length === 0 && <li className="muted">none</li>}
      </ul>

      <h3>Transport uncertainty</h3>
      <ul className="receipt-list">
        {d.transportUncertainty.map((i) => (
          <li key={i.id}>intent {i.id.slice(0, 8)} · response lost — remote outcome uncertain · {fmtDual(i.updated_at, "UTC")}</li>
        ))}
        {d.transportUncertainty.length === 0 && <li className="muted">none</li>}
      </ul>

      <h3>Remote judgment</h3>
      <ul className="receipt-list">
        {d.remoteJudgment.rewards.map((r) => (
          <li key={r.intent_id}>
            intent {r.intent_id.slice(0, 8)} · remote status <strong>{r.remote_status}</strong>
            {r.verdict ? ` · verdict ${r.verdict}` : ""} · last poll {fmtDual(r.last_poll_at, "UTC")}
          </li>
        ))}
        {d.remoteJudgment.rewards.length === 0 && <li className="muted">none</li>}
      </ul>

      <h3>Money</h3>
      <ul className="receipt-list">
        {d.money.map((r) => (
          <li key={r.intent_id}>
            intent {r.intent_id.slice(0, 8)} · bounty <span className="num">{r.bounty_amount_raw ?? "—"}</span>
            {" "}({r.bounty_state ?? "unresolved"}){r.zero_pay_reason ? ` · ${r.zero_pay_reason}` : ""}
            {" "}· denomination unverified until the provider schema declares it
          </li>
        ))}
        {d.money.length === 0 && <li className="muted">none</li>}
      </ul>
    </section>
  );
}
