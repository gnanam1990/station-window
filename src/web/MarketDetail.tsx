import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "./api.ts";
import { ApiError2 } from "./api.ts";
import { fmtDual, wordDiff } from "./common.ts";

interface Detail {
  asOf: string;
  market: { marketVersionId: string; address: string; competitionId: string; isCompetitionEntry: boolean; evidenceCutoffAtUtc: string };
  rule: {
    verbatim: string; status: string;
    structured: { variable: string; operator: string; threshold: string; unit: string; localZone: string; localDate: string; dayDefinition: unknown; aggregatePolicy: unknown };
  };
  station: { externalId: string | null; authority: string | null; cityLabel: string | null };
  series: {
    cadenceMinutes: number | null;
    points: {
      observationId: string; observedAtUtc: string; firstSeenAtUtc: string;
      value: string | null; unit: string; bindingValue: string | null; bindingUnit: string;
      quality: string; lineLocator: string | null; gapBefore: boolean;
    }[];
  };
  latestEvaluation: { id: string; verdict: string; result: unknown; created_at: string } | null;
  candidates: {
    id: string; version: number; status: string; block_reason: string | null;
    note_text: string; citation_set: { url: string; locator?: string }[];
    approval_id: string | null; approval_status: string | null;
  }[];
  currentCandidate: { id: string; version: number; status: string; note_text: string } | null;
  editorPreview: {
    note: string; candidateVersion: number; authorityUrls: string[];
    marketAddress: string; evidenceCutoffAtUtc: string; slotConsequence: string; canSubmit: boolean;
  } | null;
  sourcePolicies: { endpoint_url: string; can_submit: boolean }[];
}

export function MarketDetail({ client, bindingId, onError }: {
  client: ApiClient; bindingId: string; onError: (e: unknown) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [conflict, setConflict] = useState<{ staleNote: string; staleVersion: number; by: { version: number; note_text: string; id: string } } | null>(null);
  const [approved, setApproved] = useState(false);

  const load = useCallback(async () => {
    setD(await client.get<Detail>(`/api/desk/bindings/${encodeURIComponent(bindingId)}`));
  }, [client, bindingId]);
  useEffect(() => { void load().catch(onError); }, [load, onError]);

  if (!d) return <p aria-busy>Loading market detail…</p>;

  const zone = d.rule.structured.localZone;
  const pts = d.series.points;
  // null bindingValue is missing — Number(null) would wrongly plot it as 0;
  // only an actual zero value may land on the baseline
  const nums = pts
    .filter((p) => p.bindingValue != null)
    .map((p) => Number(p.bindingValue));
  const threshold = Number(d.rule.structured.threshold);
  const domain = Number.isFinite(threshold) ? [...nums, threshold] : nums;
  const min = domain.length ? Math.min(...domain) : 0;
  const max = domain.length ? Math.max(...domain) : 1;
  const span = max - min || 1;
  const gapCount = pts.filter((p) => p.gapBefore).length;
  const missingCount = pts.filter((p) => p.bindingValue == null).length;

  const approve = async (candidateId: string) => {
    try {
      await client.post(`/api/candidates/${candidateId}/approve`);
      setApproved(true); setConflict(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError2 && e.status === 409 && e.detail?.supersededBy) {
        const s = e.detail as { staleNote: string; staleVersion: number; supersededBy: { id: string; version: number; note_text: string } };
        setConflict({ staleNote: s.staleNote, staleVersion: s.staleVersion, by: s.supersededBy });
      } else onError(e);
    }
  };

  return (
    <section aria-labelledby="detail-h">
      <p><a href="#/inbox">← Market inbox</a></p>
      <h2 id="detail-h">{d.rule.verbatim}</h2>
      <dl className="rule-reading">
        <dt>Structured reading</dt>
        <dd className="num">
          {d.rule.structured.variable} {d.rule.structured.operator} {d.rule.structured.threshold}{" "}
          <abbr title={d.rule.structured.unit}>{d.rule.structured.unit}</abbr>{" "}
          on {d.rule.structured.localDate} ({d.rule.structured.localZone})
        </dd>
        <dt>Station</dt>
        <dd>
          <strong>{d.station.authority ?? "?"}/{d.station.externalId ?? "unresolved"}</strong>
          {d.station.cityLabel && <span className="muted"> {d.station.cityLabel}</span>}
        </dd>
        <dt>Evidence cutoff</dt>
        <dd>{fmtDual(d.market.evidenceCutoffAtUtc, zone)}</dd>
        <dt>Binding status</dt>
        <dd>{d.rule.status}</dd>
      </dl>

      <h3>Observed series</h3>
      <p className="muted">
        Interval {d.series.cadenceMinutes ?? "unknown"} min · {pts.length} readings ·{" "}
        {gapCount === 0 ? "no gaps" : `${gapCount} gap${gapCount > 1 ? "s" : ""} marked below`}
        {missingCount > 0 ? ` · ${missingCount} missing value${missingCount > 1 ? "s" : ""}` : ""}
        {" "}· units shown in {d.rule.structured.unit} (binding unit) and source unit.
      </p>
      {gapCount > 0 && (
        <p className="gap-note" role="note">
          {gapCount} gap{gapCount > 1 ? "s" : ""} in the series: no retained observation within{" "}
          {d.series.cadenceMinutes ?? "the expected"}-minute cadence. Gap rows below are marked
          “gap before” with the interval in local and UTC time.
        </p>
      )}
      <figure aria-label="observed series chart">
        <svg viewBox="0 0 600 160" role="img" aria-hidden={pts.length === 0}
          aria-label={`series chart, ${pts.length} points, range ${min} to ${max} ${d.rule.structured.unit}`}>
          {Number.isFinite(threshold) && (
            <>
              <line className="thr-line" x1={20} x2={580}
                y1={140 - ((threshold - min) / span) * 120}
                y2={140 - ((threshold - min) / span) * 120} />
              <text className="axis thr-label" x={584}
                y={140 - ((threshold - min) / span) * 120 + 4}>thr</text>
            </>
          )}
          {pts.map((p, i) => {
            const x = 20 + (i / Math.max(pts.length - 1, 1)) * 560;
            if (p.bindingValue == null) {
              // missing reading: mark below the axis, never as a zero point
              return (
                <text key={p.observationId} className="pt miss" x={x - 4} y={156}
                  aria-hidden>×</text>
              );
            }
            const v = Number(p.bindingValue);
            if (!Number.isFinite(v)) return null;
            const y = 140 - ((v - min) / span) * 120;
            return <circle key={p.observationId} cx={x} cy={y} r={3} className={p.gapBefore ? "pt gap" : "pt"} />;
          })}
          <text x={8} y={150} className="axis">{min}</text>
          <text x={8} y={20} className="axis">{max}</text>
        </svg>
        <figcaption className="muted">Dashed line: threshold {d.rule.structured.operator} {d.rule.structured.threshold} {d.rule.structured.unit}. × markers: missing readings. Table below is the accessible equivalent.</figcaption>
      </figure>
      <div role="region" aria-label="observation table" tabIndex={0} className="table-scroll">
        <table data-testid="series-table">
          <thead>
            <tr>
              <th scope="col">Observed</th><th scope="col">First seen</th>
              <th scope="col">Value ({d.rule.structured.unit})</th><th scope="col">Source value</th>
              <th scope="col">Quality</th><th scope="col">Source</th><th scope="col">Gap</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.observationId} className={p.gapBefore ? "gap-row" : undefined}>
                <td>{fmtDual(p.observedAtUtc, zone)}</td>
                <td>{fmtDual(p.firstSeenAtUtc, "UTC")}</td>
                <td className="num">{p.bindingValue ?? "—"} {d.rule.structured.unit}</td>
                <td className="num">{p.value ?? "missing"} {p.unit}</td>
                <td>{p.quality}</td>
                <td className="mono small">{p.lineLocator ?? "—"}</td>
                <td>{p.gapBefore ? "gap before this row" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Draft versions</h3>
      {d.candidates.length === 0 && <p className="muted">No research draft yet.</p>}
      <div className="versions">
        {d.candidates.map((c) => (
          <article key={c.id} className={`version-card ${c.status}`} aria-label={`draft version ${c.version}`}>
            <header>
              <strong>v{c.version}</strong> <span className="muted">{c.status.replaceAll("_", " ")}</span>
            </header>
            <p className="note">{c.note_text}</p>
            <ul className="citations">
              {c.citation_set.map((cit, i) => (
                <li key={i}>
                  <a href={cit.url} target="_blank" rel="noreferrer">{cit.url}</a>
                  {cit.locator && <span className="mono small"> {cit.locator}</span>}
                </li>
              ))}
            </ul>
            {c.block_reason && <p className="blocked">Blocked: {c.block_reason} — this draft cannot be approved or sent until a corrected version exists.</p>}
            {c.status === "pending_review" && (
              <button type="button" onClick={() => void approve(c.id)}
                aria-label={`approve draft version ${c.version}`}>
                Approve v{c.version}
              </button>
            )}
            {c.status === "superseded" && (
              <button type="button" onClick={() => void approve(c.id)}
                aria-label={`approve superseded draft version ${c.version}`}>
                Approve v{c.version} (stale)
              </button>
            )}
          </article>
        ))}
      </div>

      {conflict && (
        <div role="alert" className="conflict">
          <strong>Conflict: this draft was superseded.</strong>
          <p>A newer version (v{conflict.by.version}) exists. Diff against your stale v{conflict.staleVersion}:</p>
          <p className="note diff" aria-label="note diff">
            {wordDiff(conflict.staleNote, conflict.by.note_text).map((w, i) => (
              <span key={i} className={w.type === "ins" ? "ins" : w.type === "del" ? "del" : undefined}>{w.text}</span>
            ))}
          </p>
          <p>Review v{conflict.by.version} above and approve that version instead.</p>
        </div>
      )}
      {approved && <p role="status" className="ok">Approval recorded.</p>}

      {d.editorPreview && (
        <section aria-label="editor preview" className="preview">
          <h3>Editor preview</h3>
          <dl>
            <dt>Note</dt><dd className="note">{d.editorPreview.note}</dd>
            <dt>Authority</dt><dd>{d.editorPreview.authorityUrls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer">{u}</a>)}</dd>
            <dt>Market</dt><dd className="mono">{d.editorPreview.marketAddress}</dd>
            <dt>Cutoff</dt><dd>{fmtDual(d.editorPreview.evidenceCutoffAtUtc, zone)}</dd>
            <dt>Candidate version</dt><dd className="num">v{d.editorPreview.candidateVersion}</dd>
            <dt>Dispatch consequence</dt><dd>{d.editorPreview.slotConsequence}</dd>
            {!d.editorPreview.canSubmit && <dt className="blocked">Submission restricted by source policy — view only.</dt>}
          </dl>
        </section>
      )}

      {d.latestEvaluation && (
        <details>
          <summary>Latest evaluation ({d.latestEvaluation.verdict})</summary>
          <pre className="json">{JSON.stringify(d.latestEvaluation.result, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
