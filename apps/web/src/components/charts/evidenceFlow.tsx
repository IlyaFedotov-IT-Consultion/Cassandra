import { useState } from "react";

import type { JudgmentRecordDetails } from "../../api";
import { humanizeProviderName, humanizeToken } from "../../format";
import { readStage } from "../trace";
import { TableView, useMeasuredWidth, useRovingFocus } from "./primitives";

type Trace = NonNullable<JudgmentRecordDetails["verdictTrace"]>;
type Opinion = Trace["judgeOpinions"][number];

export interface EvidenceFlowStage {
  key: "retrieved" | "collected" | "rated" | "kept";
  label: string;
  count: number;
}

export interface EvidenceFlowProvider {
  key: string;
  label: string;
  /** Raw results the provider returned; null when the provider is only known from citations. */
  retrieved: number | null;
  /** Distinct kept items from this provider that a judge read. */
  kept: number;
  error: string | null;
}

export interface EvidenceFlowJudge {
  key: string;
  label: string;
  read: number;
}

export interface EvidenceFlowLink {
  provider: string;
  judge: string;
  count: number;
}

export interface EvidenceFlow {
  stages: EvidenceFlowStage[];
  providers: EvidenceFlowProvider[];
  judges: EvidenceFlowJudge[];
  links: EvidenceFlowLink[];
}

const UNRECORDED = "unrecorded";

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerLabel(key: string) {
  return key === UNRECORDED ? "Source not recorded" : humanizeProviderName(key);
}

/**
 * How evidence reached the panel: the retrieval and relevance counts, and which
 * provider's kept items each judge read (an item's provider comes from its citation,
 * falling back to its source family).
 */
export function buildEvidenceFlow(trace: Trace, opinions: Opinion[] = trace.judgeOpinions): EvidenceFlow {
  const retrieval = readStage(trace, "retrieval");
  const relevance = readStage(trace, "relevance_rating");
  const retrievalProviders = Array.isArray(retrieval?.details.providers)
    ? (retrieval!.details.providers as Array<{ name: string; rawCount?: number; error?: string | null }>)
    : [];

  const stages: EvidenceFlowStage[] = [];
  const push = (key: EvidenceFlowStage["key"], label: string, count: number | null) => {
    if (count !== null) {
      stages.push({ key, label, count });
    }
  };
  push(
    "retrieved",
    "Retrieved",
    retrievalProviders.length > 0 ? retrievalProviders.reduce((sum, provider) => sum + (provider.rawCount ?? 0), 0) : null,
  );
  push("collected", "Collected", asNumber(retrieval?.details.evidenceCount));
  if (relevance?.status === "completed") {
    push("rated", "Rated", asNumber(relevance.details.rated));
    push("kept", "Kept", asNumber(relevance.details.kept));
  }

  const providerOf = new Map<string, string>();
  for (const citation of trace.citations) {
    if (citation.evidenceId) {
      providerOf.set(citation.evidenceId, citation.provider ?? citation.sourceFamily);
    }
  }

  const linkCounts = new Map<string, number>();
  const keptByProvider = new Map<string, Set<string>>();
  for (const opinion of opinions) {
    for (const evidenceId of new Set(opinion.evidenceIds)) {
      const provider = providerOf.get(evidenceId) ?? UNRECORDED;
      const key = `${provider}\u0000${opinion.judgeName}`;
      linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
      keptByProvider.set(provider, (keptByProvider.get(provider) ?? new Set()).add(evidenceId));
    }
  }

  const providerKeys = retrievalProviders.map((provider) => provider.name);
  const extra = [...keptByProvider.keys()].filter((key) => !providerKeys.includes(key));
  providerKeys.push(...extra.filter((key) => key !== UNRECORDED), ...extra.filter((key) => key === UNRECORDED));

  return {
    stages,
    providers: providerKeys.map((key) => {
      const recorded = retrievalProviders.find((provider) => provider.name === key);
      return {
        key,
        label: providerLabel(key),
        retrieved: recorded ? recorded.rawCount ?? 0 : null,
        kept: keptByProvider.get(key)?.size ?? 0,
        error: recorded?.error ?? null,
      };
    }),
    judges: opinions.map((opinion) => ({
      key: opinion.judgeName,
      label: humanizeToken(opinion.judgeName),
      read: new Set(opinion.evidenceIds).size,
    })),
    links: [...linkCounts.entries()].map(([key, count]) => {
      const [provider, judge] = key.split("\u0000") as [string, string];
      return { provider, judge, count };
    }),
  };
}

type Focus = { side: "provider" | "judge"; key: string } | null;

const NODE_WIDTH = 8;
const SLOT_MIN = 34;
const GAP = 10;
const PLOT_CAP = 380;

function items(count: number) {
  return `${count} item${count === 1 ? "" : "s"}`;
}

function providerName(provider: EvidenceFlowProvider) {
  const retrieved = provider.retrieved === null ? "" : `${provider.retrieved} retrieved, `;
  return `${provider.label}: ${retrieved}${provider.kept} kept${provider.error ? `, failed: ${provider.error}` : ""}`;
}

function listCounts(entries: Array<{ label: string; count: number }>) {
  return entries.map((entry) => `${entry.label} (${entry.count})`).join(", ");
}

/** Retrieval funnel, then a flow from each provider to the judges that read its kept evidence. */
export function EvidenceFlowDiagram({ flow }: { flow: EvidenceFlow }) {
  const [focus, setFocus] = useState<Focus>(null);
  const [figureRef, width] = useMeasuredWidth<HTMLElement>(640);
  const roving = useRovingFocus<SVGGElement>(flow.providers.length + flow.judges.length);
  const maxStage = Math.max(...flow.stages.map((stage) => stage.count), 1);

  const total = flow.links.reduce((sum, link) => sum + link.count, 0);
  const sideCount = Math.max(flow.providers.length, flow.judges.length);
  const unit = total === 0 ? 0 : Math.min(12, Math.max((PLOT_CAP - sideCount * (SLOT_MIN + GAP)) / total, 3));
  const flowOf = (side: "provider" | "judge", key: string) =>
    flow.links.filter((link) => link[side] === key).reduce((sum, link) => sum + link.count, 0);

  const layout = <T extends { key: string }>(nodes: T[], side: "provider" | "judge") => {
    let top = 6;
    return nodes.map((node) => {
      const size = flowOf(side, node.key) * unit;
      const slot = Math.max(size, SLOT_MIN);
      const placed = { node, top: top + (slot - size) / 2, size, slot, slotTop: top };
      top += slot + GAP;
      return placed;
    });
  };
  const left = layout(flow.providers, "provider");
  const right = layout(flow.judges, "judge");
  const height = Math.max(left.at(-1) ? left.at(-1)!.slotTop + left.at(-1)!.slot : 0, right.at(-1) ? right.at(-1)!.slotTop + right.at(-1)!.slot : 0) + 6;
  const labelWidth = Math.min(Math.max(width * 0.3, 108), 190);
  const leftX = labelWidth;
  const rightX = width - labelWidth - NODE_WIDTH;

  const providerCursor = new Map(left.map((entry) => [entry.node.key, entry.top]));
  const judgeCursor = new Map(right.map((entry) => [entry.node.key, entry.top]));
  const judgeOrder = flow.judges.map((judge) => judge.key);
  const providerOrder = flow.providers.map((provider) => provider.key);
  const ribbons = [...flow.links]
    .sort(
      (a, b) =>
        providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider) || judgeOrder.indexOf(a.judge) - judgeOrder.indexOf(b.judge),
    )
    .map((link) => {
      const size = link.count * unit;
      const y0 = providerCursor.get(link.provider) ?? 0;
      providerCursor.set(link.provider, y0 + size);
      return { link, size, y0 };
    })
    .sort((a, b) => judgeOrder.indexOf(a.link.judge) - judgeOrder.indexOf(b.link.judge) || providerOrder.indexOf(a.link.provider) - providerOrder.indexOf(b.link.provider))
    .map((ribbon) => {
      const y1 = judgeCursor.get(ribbon.link.judge) ?? 0;
      judgeCursor.set(ribbon.link.judge, y1 + ribbon.size);
      return { ...ribbon, y1 };
    });

  const labelOf = (side: "provider" | "judge", key: string) =>
    (side === "provider" ? flow.providers : flow.judges).find((node) => node.key === key)?.label ?? key;
  const linkState = (link: EvidenceFlowLink) =>
    focus === null ? "idle" : link[focus.side] === focus.key ? "active" : "muted";

  const readout = () => {
    if (focus === null) {
      return "Hover or focus a provider or a judge to trace its evidence.";
    }
    if (focus.side === "provider") {
      const provider = flow.providers.find((entry) => entry.key === focus.key)!;
      const readers = flow.links
        .filter((link) => link.provider === focus.key)
        .map((link) => ({ label: labelOf("judge", link.judge), count: link.count }));
      const head = providerName(provider);
      return readers.length > 0 ? `${head}. Read by ${listCounts(readers)}.` : `${head}. None of its evidence reached the judges.`;
    }
    const judge = flow.judges.find((entry) => entry.key === focus.key)!;
    const sources = flow.links
      .filter((link) => link.judge === focus.key)
      .map((link) => ({ label: labelOf("provider", link.provider), count: link.count }));
    return sources.length > 0
      ? `${judge.label} read ${items(judge.read)}: ${listCounts(sources)}.`
      : `${judge.label} read no evidence.`;
  };

  const node = (side: "provider" | "judge", placed: (typeof left)[number] | (typeof right)[number], index: number) => {
    const isProvider = side === "provider";
    const entry = placed.node as EvidenceFlowProvider & EvidenceFlowJudge;
    const name = isProvider ? providerName(entry) : `${entry.label}: read ${items(entry.read)}`;
    // Short on purpose: the full wording is in the node's accessible name and the table.
    const detail = isProvider
      ? `${entry.retrieved === null ? `${entry.kept}` : `${entry.kept} of ${entry.retrieved}`} kept${entry.error ? ", failed" : ""}`
      : `read ${items(entry.read)}`;
    const x = isProvider ? leftX : rightX;
    const textX = isProvider ? leftX - 8 : rightX + NODE_WIDTH + 8;
    const anchor = isProvider ? "end" : "start";
    const centre = placed.slotTop + placed.slot / 2;
    const active = focus?.side === side && focus.key === entry.key;
    const select = () => setFocus({ side, key: entry.key });
    return (
      <g
        key={`${side}-${entry.key}`}
        role="button"
        className="flow-node"
        data-state={focus === null ? "idle" : active ? "active" : "muted"}
        data-failed={entry.error ? "true" : undefined}
        aria-label={name}
        {...roving.itemProps(index)}
        onFocus={select}
        onMouseEnter={select}
        onClick={select}
      >
        <rect className="flow-node__hit" x={isProvider ? 0 : rightX - 4} y={placed.slotTop} width={labelWidth + NODE_WIDTH + 4} height={placed.slot} />
        <rect className="flow-node__bar" x={x} y={placed.top} width={NODE_WIDTH} height={Math.max(placed.size, 2)} rx={2} />
        <text className="flow-node__label" x={textX} y={centre - 3} textAnchor={anchor}>
          {entry.label}
        </text>
        <text className="flow-node__count" x={textX} y={centre + 11} textAnchor={anchor}>
          {detail}
        </text>
      </g>
    );
  };

  const midX = (leftX + NODE_WIDTH + rightX) / 2;

  return (
    <figure ref={figureRef} className="flow-diagram">
      <ol className="flow-funnel" aria-label="Evidence funnel">
        {flow.stages.map((stage) => (
          <li key={stage.key} className="flow-funnel__stage">
            <span className="flow-funnel__label">{stage.label}</span>
            <strong className="flow-funnel__count">{stage.count}</strong>
            <span className="flow-funnel__bar" aria-hidden="true">
              <span style={{ width: `${(stage.count / maxStage) * 100}%` }} />
            </span>
          </li>
        ))}
      </ol>
      <p className="helper-text flow-funnel__note">
        Retrieved counts the providers' raw results, collected the usable items after merging them, rated the items the
        relevance model scored, and kept those scored relevant enough for the judges to read.
      </p>
      {flow.links.length === 0 ? (
        <p className="helper-text">No judge read any evidence in this run.</p>
      ) : (
        <svg
          className="flow-diagram__plot"
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label="Evidence flow from providers to judges"
          onMouseLeave={() => setFocus(null)}
        >
          {ribbons.map(({ link, size, y0, y1 }) => (
            <path
              key={`${link.provider}-${link.judge}`}
              data-testid="flow-link"
              className="flow-link"
              data-state={linkState(link)}
              aria-label={`${items(link.count)} from ${labelOf("provider", link.provider)} read by ${labelOf("judge", link.judge)}`}
              d={`M${leftX + NODE_WIDTH},${y0} C${midX},${y0} ${midX},${y1} ${rightX},${y1} L${rightX},${y1 + size} C${midX},${y1 + size} ${midX},${y0 + size} ${leftX + NODE_WIDTH},${y0 + size} Z`}
            />
          ))}
          {left.map((placed, index) => node("provider", placed, index))}
          {right.map((placed, index) => node("judge", placed, flow.providers.length + index))}
        </svg>
      )}
      <p className="chart-readout" role="status">
        {readout()}
      </p>
      <TableView caption="Evidence by provider">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col" className="data-table__number">
              Retrieved
            </th>
            <th scope="col" className="data-table__number">
              Kept items
            </th>
            <th scope="col">Read by</th>
          </tr>
        </thead>
        <tbody>
          {flow.providers.map((provider) => {
            const readers = flow.links
              .filter((link) => link.provider === provider.key)
              .map((link) => ({ label: labelOf("judge", link.judge), count: link.count }));
            return (
              <tr key={provider.key}>
                <th scope="row">{provider.label}</th>
                <td className="data-table__number">{provider.retrieved ?? "n/a"}</td>
                <td className="data-table__number">{provider.kept}</td>
                <td>{provider.error ? `Failed: ${provider.error}` : readers.length > 0 ? listCounts(readers) : "None"}</td>
              </tr>
            );
          })}
        </tbody>
      </TableView>
    </figure>
  );
}
