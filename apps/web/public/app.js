const config = window.__CASSANDRA_CONFIG__ ?? { apiBaseUrl: "http://localhost:3000" };
const apiBaseUrl = String(config.apiBaseUrl ?? "http://localhost:3000").replace(/\/$/, "");

const statusElements = {
  apiBaseUrl: document.getElementById("api-base-url"),
  health: document.getElementById("api-health"),
  ready: document.getElementById("api-ready"),
};

const eventsList = document.getElementById("events-list");
const eventsEmpty = document.getElementById("events-empty");
const watchlistsList = document.getElementById("watchlists-list");
const watchlistsEmpty = document.getElementById("watchlists-empty");
const eventFeedback = document.getElementById("event-form-feedback");
const watchlistFeedback = document.getElementById("watchlist-form-feedback");
const judgmentOutput = document.getElementById("judgment-output");

statusElements.apiBaseUrl.textContent = apiBaseUrl;

function splitCommaSeparated(input) {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function toIsoStringFromLocalDateTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : `Request failed with ${response.status}`;
    throw new Error(String(message));
  }

  return payload;
}

function setStatus(target, value, tone = "default") {
  target.textContent = value;
  target.style.color =
    tone === "ok" ? "#245b41" : tone === "error" ? "#8c2f1c" : "var(--ink)";
}

async function refreshServiceStatus() {
  try {
    const health = await requestJson("/health");
    setStatus(statusElements.health, health.status ?? "ok", "ok");
  } catch (error) {
    setStatus(statusElements.health, error instanceof Error ? error.message : "Unavailable", "error");
  }

  try {
    const ready = await requestJson("/ready");
    setStatus(statusElements.ready, ready.status ?? "ready", "ok");
  } catch (error) {
    setStatus(statusElements.ready, error instanceof Error ? error.message : "Unavailable", "error");
  }
}

function renderEvents(events) {
  eventsList.innerHTML = "";

  if (!Array.isArray(events) || events.length === 0) {
    eventsEmpty.textContent = "No events yet. Create one above to seed the system.";
    return;
  }

  eventsEmpty.textContent = "";

  for (const event of events) {
    const card = document.createElement("article");
    card.className = "data-card";
    card.innerHTML = `
      <h3>${event.question}</h3>
      <p>${event.resolutionCriteria}</p>
      <div class="meta-row">
        <span class="pill">Deadline: ${new Date(event.deadline).toLocaleString()}</span>
        <span class="pill">Reference: ${event.referenceClass ?? "none"}</span>
        <span class="pill">Entities: ${(event.entities ?? []).join(", ")}</span>
      </div>
      <div class="meta-row">
        <span class="pill">ID: ${event.id}</span>
      </div>
      <button type="button" data-run-judgment="${event.id}">Run fixture judgment</button>
    `;

    const button = card.querySelector("button");
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Running…";

      try {
        const judgment = await requestJson("/judgments", {
          method: "POST",
          body: JSON.stringify({
            eventId: event.id,
          }),
        });

        judgmentOutput.textContent = JSON.stringify(judgment, null, 2);
        button.textContent = "Run fixture judgment";
      } catch (error) {
        judgmentOutput.textContent = String(error instanceof Error ? error.message : error);
        button.textContent = "Retry judgment";
      } finally {
        button.disabled = false;
      }
    });

    eventsList.appendChild(card);
  }
}

async function refreshEvents() {
  try {
    const events = await requestJson("/events");
    renderEvents(events);
  } catch (error) {
    eventsEmpty.textContent = `Unable to load events: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

async function loadCandidates(watchlistId) {
  try {
    return await requestJson(`/watchlists/${watchlistId}/candidates`);
  } catch {
    return [];
  }
}

async function renderWatchlists(watchlists) {
  watchlistsList.innerHTML = "";

  if (!Array.isArray(watchlists) || watchlists.length === 0) {
    watchlistsEmpty.textContent = "No watchlists yet. Create one above to start discovery.";
    return;
  }

  watchlistsEmpty.textContent = "";

  for (const watchlist of watchlists) {
    const candidates = await loadCandidates(watchlist.id);
    const card = document.createElement("article");
    card.className = "data-card";
    card.innerHTML = `
      <h3>${watchlist.name}</h3>
      <p>Cadence: ${watchlist.cadence}</p>
      <div class="meta-row">
        <span class="pill">Keywords: ${(watchlist.keywords ?? []).join(", ") || "none"}</span>
        <span class="pill">Jurisdictions: ${(watchlist.jurisdictions ?? []).join(", ") || "none"}</span>
      </div>
      <div class="meta-row">
        <span class="pill">Candidates: ${candidates.length}</span>
        <span class="pill">ID: ${watchlist.id}</span>
      </div>
    `;
    watchlistsList.appendChild(card);
  }
}

async function refreshWatchlists() {
  try {
    const watchlists = await requestJson("/watchlists");
    await renderWatchlists(watchlists);
  } catch (error) {
    watchlistsEmpty.textContent = `Unable to load watchlists: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

document.getElementById("event-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  eventFeedback.textContent = "Submitting…";

  const form = new FormData(event.currentTarget);
  const payload = {
    question: String(form.get("question") ?? ""),
    resolutionCriteria: String(form.get("resolutionCriteria") ?? ""),
    deadline: toIsoStringFromLocalDateTime(String(form.get("deadline") ?? "")),
    entities: splitCommaSeparated(String(form.get("entities") ?? "")),
    referenceClass: String(form.get("referenceClass") ?? "") || null,
    marketSymbols: splitCommaSeparated(String(form.get("marketSymbols") ?? "")),
    ...(String(form.get("polymarketMarketId") ?? "")
      ? { polymarketMarketId: String(form.get("polymarketMarketId")) }
      : {}),
  };

  try {
    await requestJson("/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    event.currentTarget.reset();
    eventFeedback.textContent = "Event created.";
    await refreshEvents();
  } catch (error) {
    eventFeedback.textContent = error instanceof Error ? error.message : "Unable to create event";
  }
});

document.getElementById("watchlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  watchlistFeedback.textContent = "Submitting…";

  const form = new FormData(event.currentTarget);
  const payload = {
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
  };

  try {
    await requestJson("/watchlists", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    event.currentTarget.reset();
    watchlistFeedback.textContent = "Watchlist created.";
    await refreshWatchlists();
  } catch (error) {
    watchlistFeedback.textContent =
      error instanceof Error ? error.message : "Unable to create watchlist";
  }
});

document.getElementById("judgment-lookup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const judgmentId = String(form.get("judgmentId") ?? "").trim();

  if (!judgmentId) {
    judgmentOutput.textContent = "Enter a judgment id first.";
    return;
  }

  judgmentOutput.textContent = "Loading…";

  try {
    const judgment = await requestJson(`/judgments/${encodeURIComponent(judgmentId)}`);
    judgmentOutput.textContent = JSON.stringify(judgment, null, 2);
  } catch (error) {
    judgmentOutput.textContent = error instanceof Error ? error.message : "Unable to fetch judgment";
  }
});

await Promise.all([
  refreshServiceStatus(),
  refreshEvents(),
  refreshWatchlists(),
]);
