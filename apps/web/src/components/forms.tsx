import { WATCHLIST_CADENCES } from "@cassandra/shared";
import {
  type FormEvent,
  useId,
} from "react";
import {
  type CandidateEventRecord,
  createEvent,
  createWatchlist,
  splitCommaSeparated,
  toIsoStringFromLocalDateTime,
} from "../api";
import {
  InlineError,
} from "../components/ui";
import { humanizeToken } from "../format";

export const referenceClassValues = [
  "regulatory_approval",
  "election",
  "product_launch",
  "court_decision",
  "macro_release",
  "policy_decision",
  "geopolitical_event",
] as const;

export type EventReferenceClass = (typeof referenceClassValues)[number];

export function parseReferenceClass(value: FormDataEntryValue | null): EventReferenceClass | null {
  const nextValue = String(value ?? "");

  if (referenceClassValues.includes(nextValue as EventReferenceClass)) {
    return nextValue as EventReferenceClass;
  }

  return null;
}

export function buildEventSeedDefaults(candidate: CandidateEventRecord) {
  return {
    question: candidate.title,
    resolutionCriteria: candidate.description,
    deadline: "",
    entities: "",
    referenceClass: "",
    marketSymbols: "",
    polymarketMarketId: "",
  };
}

export function EventComposerForm({
  defaults,
  errorMessage,
  onSubmit,
  submitLabel,
}: {
  defaults?: {
    question?: string;
    resolutionCriteria?: string;
    deadline?: string;
    entities?: string;
    referenceClass?: string;
    marketSymbols?: string;
    polymarketMarketId?: string;
  };
  errorMessage?: string | null;
  onSubmit: (payload: Parameters<typeof createEvent>[0]) => void;
  submitLabel: string;
}) {
  const formId = useId();

  return (
    <form
      key={formId}
      className="form-grid"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        onSubmit({
          question: String(form.get("question") ?? ""),
          resolutionCriteria: String(form.get("resolutionCriteria") ?? ""),
          deadline: toIsoStringFromLocalDateTime(String(form.get("deadline") ?? "")),
          entities: splitCommaSeparated(String(form.get("entities") ?? "")),
          referenceClass: parseReferenceClass(form.get("referenceClass")),
          marketSymbols: splitCommaSeparated(String(form.get("marketSymbols") ?? "")),
          ...(String(form.get("polymarketMarketId") ?? "")
            ? { polymarketMarketId: String(form.get("polymarketMarketId")) }
            : {}),
        });
      }}
    >
      {errorMessage ? <InlineError message={errorMessage} /> : null}
      <div className="form-field">
        <label htmlFor={`${formId}-question`}>
          <span>Question</span>
          <input id={`${formId}-question`} aria-describedby={`${formId}-question-hint`} defaultValue={defaults?.question ?? ""} name="question" required />
        </label>
        <p className="field-hint" id={`${formId}-question-hint`}>Ask one Yes or No question with an observable outcome.</p>
      </div>
      <div className="form-field">
        <label htmlFor={`${formId}-deadline`}>
          <span>Deadline</span>
          <input id={`${formId}-deadline`} aria-describedby={`${formId}-deadline-hint`} defaultValue={defaults?.deadline ?? ""} name="deadline" required type="datetime-local" />
        </label>
        <p className="field-hint" id={`${formId}-deadline-hint`}>Enter your local time. Saved deadlines are displayed in UTC.</p>
      </div>
      <div className="form-field form-grid__full">
        <label>
          <span>Resolution Criteria</span>
          <textarea
            defaultValue={defaults?.resolutionCriteria ?? ""}
            name="resolutionCriteria"
            aria-describedby={`${formId}-criteria-hint`}
            required
            rows={4}
          />
        </label>
        <p className="field-hint" id={`${formId}-criteria-hint`}>State what counts as Yes, what counts as No, and which source will settle the outcome.</p>
      </div>
      <div className="form-field">
        <label>
          <span>Entities</span>
          <input aria-describedby={`${formId}-entities-hint`} defaultValue={defaults?.entities ?? ""} name="entities" placeholder="Comma-separated" required />
        </label>
        <p className="field-hint" id={`${formId}-entities-hint`}>People, organizations or places to search for, separated by commas.</p>
      </div>
      <div className="form-field">
        <label>
          <span>Reference Class</span>
          <select aria-describedby={`${formId}-class-hint`} defaultValue={defaults?.referenceClass ?? ""} name="referenceClass">
            <option value="">None</option>
            <option value="regulatory_approval">Regulatory approval</option>
            <option value="election">Election</option>
            <option value="product_launch">Product launch</option>
            <option value="court_decision">Court decision</option>
            <option value="macro_release">Macro release</option>
            <option value="policy_decision">Policy decision</option>
            <option value="geopolitical_event">Geopolitical event</option>
          </select>
        </label>
        <p className="field-hint" id={`${formId}-class-hint`}>Optional group of similar events used for the base rate. Choose None if none fits.</p>
      </div>
      <div className="form-field">
        <label>
          <span>Market Symbols</span>
          <input aria-describedby={`${formId}-symbols-hint`} defaultValue={defaults?.marketSymbols ?? ""} name="marketSymbols" placeholder="Comma-separated" />
        </label>
        <p className="field-hint" id={`${formId}-symbols-hint`}>Optional market tickers for evidence lookup; these do not bind a Polymarket prior.</p>
      </div>
      <div className="form-field">
        <label>
          <span>Polymarket Market ID</span>
          <input aria-describedby={`${formId}-market-hint`} defaultValue={defaults?.polymarketMarketId ?? ""} name="polymarketMarketId" />
        </label>
        <p className="field-hint" id={`${formId}-market-hint`}>Optional ID of the exact binary market, not its URL or event slug. Match its resolution rules to this question.</p>
      </div>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}

export function WatchlistComposerForm({
  errorMessage,
  onSubmit,
  submitLabel,
}: {
  errorMessage?: string | null;
  onSubmit: (payload: Parameters<typeof createWatchlist>[0]) => void;
  submitLabel: string;
}) {
  return (
    <form
      className="form-grid"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        onSubmit({
          name: String(form.get("name") ?? ""),
          cadence: String(form.get("cadence") ?? ""),
          keywords: splitCommaSeparated(String(form.get("keywords") ?? "")),
          jurisdictions: splitCommaSeparated(String(form.get("jurisdictions") ?? "")),
          sourceToggles: {
            official: form.get("official") === "on",
            government: form.get("government") === "on",
            community: form.get("community") === "on",
            markets: form.get("markets") === "on",
            predictionMarkets: form.get("predictionMarkets") === "on",
          },
        });
      }}
    >
      {errorMessage ? <InlineError message={errorMessage} /> : null}
      <label>
        <span>Name</span>
        <input name="name" required />
      </label>
      <label>
        <span>Cadence</span>
        <select defaultValue="daily" name="cadence">
          {WATCHLIST_CADENCES.map((cadence) => (
            <option key={cadence} value={cadence}>
              {humanizeToken(cadence)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Keywords</span>
        <input name="keywords" placeholder="Comma-separated" required />
      </label>
      <label>
        <span>Jurisdictions</span>
        <input name="jurisdictions" placeholder="Comma-separated" />
      </label>
      <label className="checkbox-row">
        <input defaultChecked name="official" type="checkbox" />
        <span>Official sources</span>
      </label>
      <label className="checkbox-row">
        <input defaultChecked name="government" type="checkbox" />
        <span>Government sources</span>
      </label>
      <label className="checkbox-row">
        <input name="community" type="checkbox" />
        <span>Community sources</span>
      </label>
      <label className="checkbox-row">
        <input name="markets" type="checkbox" />
        <span>Market sources</span>
      </label>
      <label className="checkbox-row">
        <input name="predictionMarkets" type="checkbox" />
        <span>Prediction markets</span>
      </label>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}
