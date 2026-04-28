const MOCK_CHECKPOINTS = [
    { terminal: "Terminal A", name: "Checkpoint A1 / A2", minutes: 12, lanes: "Standard + TSA PreCheck®" },
    { terminal: "Terminal B", name: "Checkpoint B1", minutes: 18, lanes: "Standard lanes" },
    { terminal: "Terminal C", name: "Checkpoint C1", minutes: 9, lanes: "Standard + TSA PreCheck®" },
];

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8000"
    : "https://airflow-ewr.onrender.com";

const RECENT_SEARCHES_KEY = "airflow_recent_searches";
const RECENT_SEARCHES_MAX = 8;

const AIRLINE_SUGGESTIONS = [
    "United Airlines",
    "American Airlines",
    "Delta Air Lines",
    "JetBlue Airways",
    "Spirit Airlines",
    "Frontier Airlines",
    "Alaska Airlines",
    "Southwest Airlines",
    "Air Canada",
    "British Airways",
    "Lufthansa",
    "Air France",
    "KLM Royal Dutch Airlines",
    "Virgin Atlantic",
    "TAP Air Portugal",
    "Icelandair",
    "El Al",
    "Cathay Pacific",
];

const DESTINATION_SUGGESTIONS = [
    "San Francisco",
    "Los Angeles",
    "Seattle",
    "Chicago",
    "Boston",
    "Miami",
    "Denver",
    "Atlanta",
    "Dallas",
    "Phoenix",
    "Las Vegas",
    "Orlando",
    "Tampa",
    "Fort Lauderdale",
    "San Diego",
    "Portland",
    "Minneapolis",
    "Detroit",
    "Philadelphia",
    "Charlotte",
    "London",
    "Paris",
    "Frankfurt",
    "Toronto",
    "Montreal",
    "Tel Aviv",
    "Dublin",
    "SFO",
    "LAX",
    "SEA",
    "ORD",
    "BOS",
    "MIA",
    "DEN",
    "ATL",
    "DFW",
    "PHX",
    "LAS",
    "MCO",
    "TPA",
    "FLL",
    "SAN",
    "PDX",
    "MSP",
    "DTW",
    "PHL",
    "CLT",
    "LHR",
    "CDG",
    "FRA",
    "YYZ",
];

const state = {
    terminalWaits: {},
    latestFlightResults: [],
    baseEnrichedResults: [],
    lastSearchPayload: null,
    metaIntervalId: null,
    /** Last known Maps JS config from backend (browser key + enabled flag). */
    googleMapsClient: { enabled: false, apiKey: "" },
};

/** Used before we have a traffic-aware drive, and when no starting address is set. */
const PLAN_PASS0_DRIVE_GUESS_MIN = 42;

let googleMapsScriptPromise = null;
const plannerDriveTimers = new WeakMap();

function levelForMinutes(m) {
    if (m <= 10) return { label: "Light", className: "" };
    if (m <= 15) return { label: "Moderate", className: "busy" };
    return { label: "Busy", className: "heavy" };
}

function jitterMinutes(base, spread = 4) {
    const delta = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
    return Math.max(3, base + delta);
}

function randomWalkMinutes() {
    return Math.floor(Math.random() * 10) + 5;
}

function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
}

function isPlannerDevDebugEnabled() {
    try {
        const qs = new URLSearchParams(window.location.search);
        return qs.get("debug") === "1";
    } catch {
        return false;
    }
}

function formatDateTime(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatTimeOnly(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isoLocalDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function todayIsoLocalDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function getSelectedDepartureDate() {
    const el = document.getElementById("departure-date-input");
    const v = (el?.value || "").trim();
    return v || todayIsoLocalDate();
}

function filterFlightsForSelectedDate(rows) {
    const sel = getSelectedDepartureDate();
    if (!sel) return rows;
    return (rows || []).filter((f) => isoLocalDate(f.scheduled_departure) === sel);
}

function formatTimeToDeparture(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const ms = d.getTime() - Date.now();
    if (Number.isNaN(d.getTime())) return "—";
    if (ms < 0) return "Departed";
    const mins = Math.round(ms / 60000);
    if (mins < 1) return "< 1 min";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

function minutesAgoFromIso(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

function normalizeFlightNumber(raw) {
    return String(raw || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
}

function normalizeTerminalLabel(rawTerminal) {
    const text = String(rawTerminal || "").trim().toUpperCase();
    if (!text) return null;
    if (text.includes("A")) return "Terminal A";
    if (text.includes("B")) return "Terminal B";
    if (text.includes("C")) return "Terminal C";
    return null;
}

function rankSuggestions(query, list) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const starts = [];
    const includes = [];
    for (const s of list) {
        const sl = s.toLowerCase();
        if (sl.startsWith(q)) starts.push(s);
        else if (sl.includes(q)) includes.push(s);
    }
    return [...starts, ...includes].slice(0, 8);
}

function renderCards(checkpoints) {
    const grid = document.getElementById("wait-grid");
    if (!grid) return;
    const spark = (minutes, variant) => {
        const color = variant === "heavy" ? "#ef4444" : variant === "busy" ? "#f59e0b" : "#22c55e";
        return `
            <svg class="spark" viewBox="0 0 120 28" role="img" aria-label="Trend">
                <path d="M2 22 C 18 10, 30 24, 44 14 S 70 18, 82 9 S 104 14, 118 6" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
            </svg>
        `;
    };

    grid.innerHTML = checkpoints
        .map((c) => {
            const level = levelForMinutes(c.minutes);
            return `
        <article class="wait-row" role="listitem">
            <div class="wait-row-left">
                <p class="wait-row-terminal">${escapeHtml(c.terminal)}</p>
                <p class="wait-row-name">${escapeHtml(c.name)}</p>
            </div>
            <div class="wait-row-mid">
                <p class="wait-row-minutes">${c.minutes}<span>min</span></p>
                <p class="wait-row-lanes">${escapeHtml(c.lanes)}</p>
            </div>
            <div class="wait-row-right">
                <span class="badge ${level.className}">${escapeHtml(level.label)}</span>
                ${spark(c.minutes, level.className)}
            </div>
        </article>`;
        })
        .join("");
}

function setUpdatedTime() {
    const el = document.getElementById("last-updated");
    if (!el) return;
    const now = new Date();
    el.dateTime = now.toISOString();
    el.textContent = now.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

async function initializeWaitOverview(outlookMinutes = 0) {
    try {
        const res = await fetch(`${API_BASE}/api/security/waits?outlook_minutes=${encodeURIComponent(outlookMinutes)}`);
        if (!res.ok) throw new Error(await res.text());
        const payload = await res.json();
        const checkpoints = payload.terminals || [];

        // Map "Terminal A" ->  minutes for Plan page enrichment.
        state.terminalWaits = Object.fromEntries(checkpoints.map((c) => [c.terminal, c.minutes]));

        const avg = checkpoints.reduce((sum, c) => sum + (Number(c.minutes) || 0), 0) / Math.max(1, checkpoints.length);
        const predicted = Math.round(avg);
        renderCards(checkpoints);

        const pv = document.getElementById("prediction-value");
        if (pv) pv.textContent = `${predicted} minutes`;

        setUpdatedTime();

        const fastest = [...checkpoints].sort((a, b) => a.minutes - b.minutes)[0];
        const slowest = [...checkpoints].sort((a, b) => b.minutes - a.minutes)[0];
        const congestion = predicted <= 10 ? "Light" : predicted <= 15 ? "Moderate" : "Busy";
        const sf = document.getElementById("summary-fastest");
        const ss = document.getElementById("summary-slowest");
        const sc = document.getElementById("summary-congestion");
        if (sf) sf.textContent = fastest ? `${fastest.terminal} (${fastest.minutes}m)` : "—";
        if (ss) ss.textContent = slowest ? `${slowest.terminal} (${slowest.minutes}m)` : "—";
        if (sc) sc.textContent = congestion;
    } catch (err) {
        // Fallback to the previous in-browser mock if backend is unreachable.
        const checkpoints = MOCK_CHECKPOINTS.map((c) => ({ ...c, minutes: jitterMinutes(c.minutes) }));
        state.terminalWaits = Object.fromEntries(checkpoints.map((c) => [c.terminal, c.minutes]));
        renderCards(checkpoints);
        setUpdatedTime();
    }
}

function showTripError(message) {
    const err = document.getElementById("trip-error");
    err.textContent = message;
    err.classList.remove("is-hidden");
}

function hideTripError() {
    document.getElementById("trip-error").classList.add("is-hidden");
}

function setMode(mode) {
    const modeFlight = document.getElementById("mode-flight");
    const modeRoute = document.getElementById("mode-route");
    const formFlight = document.getElementById("lookup-form-flight");
    const formRoute = document.getElementById("lookup-form-route");
    const isFlight = mode === "flight";
    modeFlight.classList.toggle("is-active", isFlight);
    modeFlight.setAttribute("aria-selected", String(isFlight));
    modeRoute.classList.toggle("is-active", !isFlight);
    modeRoute.setAttribute("aria-selected", String(!isFlight));
    formFlight.classList.toggle("is-hidden", !isFlight);
    formRoute.classList.toggle("is-hidden", isFlight);
}

async function searchFlights(params) {
    const query = new URLSearchParams();
    if (params.airline) query.set("airline", params.airline);
    if (params.destination) query.set("destination", params.destination);
    if (params.force_refresh) query.set("force_refresh", "true");
    const url = `${API_BASE}/api/flights/search?${query.toString()}`;
    console.log("[plan route search] request url", url);
    const res = await fetch(url);
    if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || "Search failed");
    }
    const payload = await res.json();
    console.log("[plan route search] raw response", payload);
    console.log("[plan route search] parsed results count", (payload?.results || []).length);
    return payload;
}

function enrichFlight(f) {
    const terminalLabel = normalizeTerminalLabel(f.terminal);
    const security =
        terminalLabel && state.terminalWaits[terminalLabel] != null
            ? state.terminalWaits[terminalLabel]
            : null;
    const walk = randomWalkMinutes();
    const total = security != null ? security + walk : null;
    return {
        ...f,
        _terminalLabel: terminalLabel,
        _securityMinutes: security,
        _walkMinutes: walk,
        _totalToGateMinutes: total,
    };
}

function buildFlightPageUrl(f) {
    const terminalLabel = f._terminalLabel || normalizeTerminalLabel(f.terminal) || "";
    const params = new URLSearchParams({
        airline: f.airline || "",
        flight_number: f.flight_number || "",
        destination: f.destination_airport || f.destination_city || "",
        scheduled_departure: f.scheduled_departure || "",
        terminal: f.terminal || "",
        gate: f.gate || "",
        status: f.flight_status || "",
        terminal_wait: f._securityMinutes == null ? "" : String(f._securityMinutes),
        terminal_label: terminalLabel,
        walk_time: f._walkMinutes == null ? "" : String(f._walkMinutes),
        total_time_to_gate: f._totalToGateMinutes == null ? "" : String(f._totalToGateMinutes),
    });
    return `flight.html?${params.toString()}`;
}

function clearMetaInterval() {
    if (state.metaIntervalId) {
        clearInterval(state.metaIntervalId);
        state.metaIntervalId = null;
    }
}

function formatMetaLine(payload) {
    const src = payload.source || "—";
    const mins = minutesAgoFromIso(payload.cached_at);
    let updatedText = "—";
    if (mins != null) {
        if (mins === 0) updatedText = "just now";
        else updatedText = `${mins} minute${mins === 1 ? "" : "s"} ago`;
    }
    return `<p><strong>Source:</strong> ${escapeHtml(src)} · <strong>Updated</strong> ${escapeHtml(updatedText)}</p>`;
}

function setFlightSearchMeta(payload) {
    const el = document.getElementById("flight-search-meta");
    if (!el) return;
    clearMetaInterval();
    const tick = () => {
        el.innerHTML = formatMetaLine(payload);
    };
    tick();
    state.metaIntervalId = setInterval(tick, 60000);
    el.classList.remove("is-hidden");
}

function updateActiveContext(flight) {
    const el = document.getElementById("active-flight-context");
    if (!el) return;
    if (!flight) {
        el.classList.add("is-hidden");
        el.innerHTML = "";
        return;
    }
    const fn = flight.flight_number || "—";
    const term = flight._terminalLabel || normalizeTerminalLabel(flight.terminal) || flight.terminal || "—";
    const ttd = formatTimeToDeparture(flight.scheduled_departure);
    el.innerHTML = `<span class="active-context-inner">You are viewing: <strong>${escapeHtml(fn)}</strong> → ${escapeHtml(
        String(term),
    )} · departs in <strong>${escapeHtml(ttd)}</strong></span>`;
    el.classList.remove("is-hidden");
}

function resetResultFilters() {
    const sort = document.getElementById("flight-sort");
    const term = document.getElementById("flight-filter-terminal");
    const win = document.getElementById("flight-filter-window");
    const showDep = document.getElementById("flight-filter-show-departed");
    if (sort) sort.value = "dep-asc";
    if (term) term.value = "all";
    if (win) win.value = "all";
    if (showDep) showDep.checked = false;
}

function isFlightDeparted(f) {
    const t = new Date(f.scheduled_departure).getTime();
    if (Number.isNaN(t)) return false;
    return Date.now() > t;
}

/**
 * Terminal + time window filters, then departed/upcoming split and ordering.
 * @returns {{ flights: typeof base, emptyUpcomingButHasDeparted: boolean }}
 */
function applyFlightFilters(base) {
    const sort = document.getElementById("flight-sort")?.value || "dep-asc";
    const terminal = document.getElementById("flight-filter-terminal")?.value || "all";
    const windowVal = document.getElementById("flight-filter-window")?.value || "all";
    const showDeparted = Boolean(document.getElementById("flight-filter-show-departed")?.checked);

    let rows = [...base];

    if (terminal !== "all") {
        const want = `Terminal ${terminal}`;
        rows = rows.filter((f) => (f._terminalLabel || normalizeTerminalLabel(f.terminal)) === want);
    }

    if (windowVal !== "all") {
        const hours = Number(windowVal);
        const end = Date.now() + hours * 3600000;
        rows = rows.filter((f) => {
            const t = new Date(f.scheduled_departure).getTime();
            return !Number.isNaN(t) && t >= Date.now() && t <= end;
        });
    }

    const upcoming = rows.filter((f) => !isFlightDeparted(f));
    const departed = rows.filter((f) => isFlightDeparted(f));

    const depTime = (f) => new Date(f.scheduled_departure).getTime();

    upcoming.sort((a, b) => {
        const ta = depTime(a);
        const tb = depTime(b);
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
        if (sort === "dep-desc") return tb - ta;
        return ta - tb;
    });

    departed.sort((a, b) => {
        const ta = depTime(a);
        const tb = depTime(b);
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
        return tb - ta;
    });

    const emptyUpcomingButHasDeparted = !showDeparted && upcoming.length === 0 && departed.length > 0;

    if (showDeparted) {
        return { flights: [...upcoming, ...departed], emptyUpcomingButHasDeparted };
    }
    return { flights: upcoming, emptyUpcomingButHasDeparted };
}

function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(s);
    });
}

function airflowSetMapsDiag(patch) {
    try {
        const cur = (globalThis.__airflow_maps_diag && typeof globalThis.__airflow_maps_diag === "object") ? globalThis.__airflow_maps_diag : {};
        globalThis.__airflow_maps_diag = { ...cur, ...patch, at: Date.now() };
    } catch {
        /* ignore */
    }
}

/**
 * Loads Maps JavaScript API (Places) using the key from the backend.
 * Returns true if `google.maps.places` is available after this call.
 */
async function ensureGoogleMapsPlaces() {
    if (globalThis.google?.maps?.places) return true;
    if (!googleMapsScriptPromise) {
        googleMapsScriptPromise = (async () => {
            airflowSetMapsDiag({ stage: "begin", ok: null, reason: "" });
            try {
                const res = await fetch(`${API_BASE}/api/config/google-maps`);
                if (!res.ok) return false;
                const cfg = await res.json();
                state.googleMapsClient = {
                    enabled: Boolean(cfg.enabled),
                    apiKey: typeof cfg.api_key === "string" ? cfg.api_key : "",
                };
                if (!cfg.enabled || !cfg.api_key) return false;

                // Google Maps JS API error path will often call this.
                globalThis.gm_authFailure = () => {
                    airflowSetMapsDiag({ stage: "gm_authFailure", ok: false, reason: "gm_authFailure (key blocked for browser JS)" });
                };

                const cbName = "__airflowMapsLoaded";
                let cbResolve;
                globalThis[cbName] = () => {
                    try { cbResolve?.(); } catch { /* ignore */ }
                };
                const cbPromise = new Promise((r) => { cbResolve = r; });

                const q = new URLSearchParams({
                    key: cfg.api_key,
                    libraries: "places",
                    // Places widgets (PlaceAutocompleteElement) require the newer JS surface.
                    // "beta" is recommended by Google for the new widgets/docs.
                    v: "beta",
                    loading: "async",
                    callback: cbName,
                });
                const src = `https://maps.googleapis.com/maps/api/js?${q.toString()}`;
                airflowSetMapsDiag({ stage: "loading_script", src });
                await loadExternalScript(src);

                // Wait briefly for callback; if it never fires, we still might have google loaded.
                await Promise.race([
                    cbPromise,
                    new Promise((r) => setTimeout(r, 6000)),
                ]);

                const ok = Boolean(globalThis.google?.maps?.places);
                airflowSetMapsDiag({ stage: "loaded", ok, reason: ok ? "" : "places_not_present_after_load" });
                return ok;
            } catch {
                airflowSetMapsDiag({ stage: "exception", ok: false, reason: "exception_loading_maps_script" });
                return false;
            }
        })();
    }
    // If loading fails (often due to key restrictions / billing / blocked script),
    // allow a later retry rather than caching a permanent "false".
    return googleMapsScriptPromise.then((ok) => {
        if (!ok) googleMapsScriptPromise = null;
        return ok;
    });
}

function getPlannerOrigin(detailsEl, panel) {
    const input = panel.querySelector('input[data-role="origin"]');
    const typed = (input?.value || "").trim();
    const placeId = (detailsEl.dataset.originPlaceId || "").trim();
    const formatted = (detailsEl.dataset.originFormattedAddress || "").trim();
    const hasOrigin = Boolean(placeId || typed);
    return { input, typed, placeId, formatted, hasOrigin };
}

/**
 * Drive shown in the breakdown + minutes used in feasibility math until a real estimate arrives.
 */
function resolvePlannerDrive(detailsEl, panel) {
    const { hasOrigin } = getPlannerOrigin(detailsEl, panel);
    const loading = detailsEl.dataset.plannerDriveLoading === "1";
    const err = (detailsEl.dataset.plannerDriveError || "").trim();
    const stored = detailsEl.dataset.plannerDriveMinutes;
    const parsed = stored != null && stored !== "" ? Number(stored) : NaN;

    if (!hasOrigin) {
        return {
            minutesForMath: PLAN_PASS0_DRIVE_GUESS_MIN,
            display: "—",
            badgeMode: "no_origin",
            error: "",
            source: "placeholder",
            debugMinutes: PLAN_PASS0_DRIVE_GUESS_MIN,
        };
    }
    if (loading) {
        return {
            minutesForMath: PLAN_PASS0_DRIVE_GUESS_MIN,
            display: "…",
            badgeMode: "loading",
            error: "",
            source: "placeholder",
            debugMinutes: PLAN_PASS0_DRIVE_GUESS_MIN,
        };
    }
    if (err) {
        return {
            minutesForMath: PLAN_PASS0_DRIVE_GUESS_MIN,
            display: "!",
            badgeMode: "error",
            error: err,
            source: "error",
            debugMinutes: PLAN_PASS0_DRIVE_GUESS_MIN,
        };
    }
    if (Number.isFinite(parsed)) {
        return {
            minutesForMath: parsed,
            display: String(parsed),
            badgeMode: "live",
            error: "",
            source: "google",
            debugMinutes: parsed,
        };
    }
    return {
        minutesForMath: PLAN_PASS0_DRIVE_GUESS_MIN,
        display: "…",
        badgeMode: "pending",
        error: "",
        source: "placeholder",
        debugMinutes: PLAN_PASS0_DRIVE_GUESS_MIN,
    };
}

function updatePlannerDriveFeedback(panel, detailsEl, driveInfo) {
    const statusEl = panel.querySelector('[data-role="driveStatus"]');
    const dbg = panel.querySelector('[data-role="driveDebug"]');
    const devDetails = panel.querySelector('[data-role="devDetails"]');
    if (dbg) dbg.textContent = `source=${driveInfo.source} · ${driveInfo.debugMinutes} min`;
    if (devDetails) devDetails.classList.toggle("is-hidden", !isPlannerDevDebugEnabled());
    if (!statusEl) return;
    const ui = detailsEl?.dataset?.plannerDriveStatus;
    if (ui === "calculating") {
        statusEl.textContent = "Calculating drive time...";
    } else if (ui === "ok") {
        const minutes = driveInfo?.source === "google" ? driveInfo.debugMinutes : null;
        statusEl.textContent =
            typeof minutes === "number" && Number.isFinite(minutes) ? `Drive time calculated: ${minutes} min` : "Drive time calculated.";
    } else if (ui === "error") {
        statusEl.textContent = "Could not calculate drive time. Using placeholder estimate.";
    } else {
        statusEl.textContent = "";
    }
}

function updatePlannerBadge(panel, driveInfo) {
    const badge = panel.querySelector('[data-role="plannerBadge"]');
    const support = panel.querySelector('[data-role="plannerSupport"]');
    if (!badge) return;
    if (driveInfo.badgeMode === "no_origin") {
        badge.textContent = state.googleMapsClient.enabled
            ? "Add a starting address for drive time"
            : "Configure GOOGLE_MAPS_API_KEY for drive time";
        if (support) support.textContent = "Using placeholder drive estimate until an address is entered.";
    } else if (driveInfo.badgeMode === "loading") {
        badge.textContent = "Updating traffic-aware drive…";
        if (support) support.textContent = "Using placeholder drive estimate until an address is entered.";
    } else if (driveInfo.badgeMode === "pending") {
        badge.textContent = "Estimating traffic-aware drive…";
        if (support) support.textContent = "Using placeholder drive estimate until an address is entered.";
    } else if (driveInfo.badgeMode === "error") {
        badge.textContent = "Drive estimate unavailable";
        if (support) support.textContent = "Using placeholder drive estimate until an address is entered.";
    } else {
        badge.textContent = "Traffic-aware drive (planned departure)";
        if (support) support.textContent = "Based on Google traffic estimate, security, walk, and buffer.";
    }
}

async function postPlannerDriveEstimate(body) {
    const res = await fetch(`${API_BASE}/api/planner/drive-estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
    }
    return res.json();
}

/**
 * Two-pass loop: guess leave → Routes API at that departure → refine leave → call again.
 * Improves consistency when drive duration shifts the optimal departure instant.
 *
 * Evolve this into a stronger “solver” by: iterating until leave-by converges (delta < N min),
 * widening the departure window, or moving the fixed-point to the backend so the client
 * sends gate deadline + legs and receives a single consistent plan.
 */
async function runPlannerDriveEstimate(detailsEl, panel) {
    const { typed, placeId, formatted, hasOrigin } = getPlannerOrigin(detailsEl, panel);
    if (!hasOrigin) {
        delete detailsEl.dataset.plannerDriveMinutes;
        delete detailsEl.dataset.plannerDriveLoading;
        delete detailsEl.dataset.plannerDriveError;
        delete detailsEl.dataset.plannerDriveStatus;
        recomputePlanner(panel);
        return;
    }

    const gen = Number(detailsEl.dataset.plannerDriveGen || "0") + 1;
    detailsEl.dataset.plannerDriveGen = String(gen);

    detailsEl.dataset.plannerDriveLoading = "1";
    detailsEl.dataset.plannerDriveStatus = "calculating";
    delete detailsEl.dataset.plannerDriveError;
    recomputePlanner(panel);

    const depIso = detailsEl.getAttribute("data-departs-iso") || "";
    const depMs = new Date(depIso).getTime();
    if (Number.isNaN(depMs)) {
        delete detailsEl.dataset.plannerDriveLoading;
        delete detailsEl.dataset.plannerDriveStatus;
        recomputePlanner(panel);
        return;
    }

    const gateMs = depMs - 35 * 60000;
    const cushion = Number(panel.querySelector('input[data-role="cushion"]')?.value || 15);
    const precheck = Boolean(panel.querySelector('input[data-role="precheck"]')?.checked);
    const bags = Boolean(panel.querySelector('input[data-role="bags"]')?.checked);
    const baseSec = Number(panel.querySelector('[data-role="security"]')?.textContent || 18);
    const walk = Number(panel.querySelector('[data-role="walk"]')?.textContent || 12);
    const sec = precheck ? Math.max(3, Math.round(baseSec * 0.65)) : baseSec;
    const bagExtra = bags ? 15 : 0;
    const buffer = Math.max(0, cushion + bagExtra);

    const originAddressForApi = placeId ? formatted || typed : typed;

    const minDepartureMs = Date.now() + 120_000;

    try {
        let leaveMs = gateMs - (sec + walk + buffer + PLAN_PASS0_DRIVE_GUESS_MIN) * 60000;
        let driveMin = PLAN_PASS0_DRIVE_GUESS_MIN;

        for (let pass = 0; pass < 2; pass++) {
            if (Number(detailsEl.dataset.plannerDriveGen) !== gen) return;

            const whenMs = Math.max(leaveMs, minDepartureMs);
            const payload = await postPlannerDriveEstimate({
                origin_address: originAddressForApi || null,
                origin_place_id: placeId || null,
                departure_time: new Date(whenMs).toISOString(),
            });
            driveMin = Number(payload.drive_minutes);
            if (!Number.isFinite(driveMin) || driveMin < 1) driveMin = PLAN_PASS0_DRIVE_GUESS_MIN;
            leaveMs = gateMs - (sec + walk + buffer + driveMin) * 60000;
        }

        if (Number(detailsEl.dataset.plannerDriveGen) !== gen) return;

        detailsEl.dataset.plannerDriveMinutes = String(driveMin);
        detailsEl.dataset.plannerDriveStatus = "ok";
    } catch (err) {
        if (Number(detailsEl.dataset.plannerDriveGen) !== gen) return;
        detailsEl.dataset.plannerDriveError = err?.message || "Drive estimate failed";
        delete detailsEl.dataset.plannerDriveMinutes;
        detailsEl.dataset.plannerDriveStatus = "error";
    } finally {
        if (Number(detailsEl.dataset.plannerDriveGen) !== gen) return;
        delete detailsEl.dataset.plannerDriveLoading;
        recomputePlanner(panel);
    }
}

function schedulePlannerDriveEstimate(detailsEl, panel) {
    const prev = plannerDriveTimers.get(detailsEl);
    if (prev) clearTimeout(prev);
    plannerDriveTimers.set(
        detailsEl,
        setTimeout(() => {
            plannerDriveTimers.delete(detailsEl);
            void runPlannerDriveEstimate(detailsEl, panel);
        }, 450),
    );
}

async function setupPlannerOriginInput(detailsEl, panel) {
    if (detailsEl._plannerOriginBound) return;
    detailsEl._plannerOriginBound = true;

    const originInput = panel.querySelector('input[data-role="origin"]');
    if (!originInput) return;

    originInput.addEventListener("input", () => {
        const stored = (detailsEl.dataset.originFormattedAddress || "").trim();
        if (originInput.value.trim() !== stored) {
            delete detailsEl.dataset.originPlaceId;
            delete detailsEl.dataset.originFormattedAddress;
        }
        delete detailsEl.dataset.plannerDriveMinutes;
        delete detailsEl.dataset.plannerDriveError;
        delete detailsEl.dataset.plannerDriveStatus;
        recomputePlanner(panel);
        schedulePlannerDriveEstimate(detailsEl, panel);
    });

    const ok = await ensureGoogleMapsPlaces();
    if (!ok || !globalThis.google?.maps?.places?.Autocomplete || detailsEl._plannerPlacesAutocomplete) return;

    const ac = new globalThis.google.maps.places.Autocomplete(originInput, {
        fields: ["formatted_address", "place_id", "name"],
        componentRestrictions: { country: "us" },
    });
    detailsEl._plannerPlacesAutocomplete = ac;

    ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const pid = (place.place_id || "").trim();
        const addr = (place.formatted_address || place.name || originInput.value).trim();
        detailsEl.dataset.originPlaceId = pid;
        detailsEl.dataset.originFormattedAddress = addr;
        if (addr) originInput.value = addr;
        delete detailsEl.dataset.plannerDriveMinutes;
        delete detailsEl.dataset.plannerDriveError;
        delete detailsEl.dataset.plannerDriveStatus;
        recomputePlanner(panel);
        schedulePlannerDriveEstimate(detailsEl, panel);
    });
}

function renderDepartedFlightRowHtml(f) {
    const dest = f.destination_airport || f.destination_city || "—";
    const flightNo = f.flight_number || "—";
    const airline = f.airline || "—";
    const departs = formatTimeOnly(f.scheduled_departure);
    const termShort = f.terminal || "—";
    const ttd = "Departed";
    const statusText = "Departed";

    const saved = typeof isFlightSaved === "function" && isFlightSaved(f);
    const heartLabel = saved ? "Remove from saved" : "Save flight";
    const fullUrl = buildFlightPageUrl(f);
    const planUrl = buildPlanDetailsUrl(f);
    const key = encodeURIComponent(flightStorageKey(f));

    return `
            <li class="flight-result-item-wrap">
                <details class="flight-result-item" data-flight-key="${key}" data-departed="1">
                    <summary class="flight-result-summary">
                        <div class="flight-result-preview" data-role="chooseFlight" data-href="${planUrl.replace(/"/g, "&quot;")}">
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Flight</span>
                                <span class="flight-result-preview-value">${escapeHtml(flightNo)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Airline</span>
                                <span class="flight-result-preview-value">${escapeHtml(airline)}</span>
                            </div>
                            <div class="flight-result-preview-cell flight-result-preview-cell--wide">
                                <span class="flight-result-preview-label">Destination</span>
                                <span class="flight-result-preview-value">${escapeHtml(dest)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Departs</span>
                                <span class="flight-result-preview-value">${escapeHtml(departs)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Time to dep.</span>
                                <span class="flight-result-preview-value">${escapeHtml(ttd)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Terminal</span>
                                <span class="flight-result-preview-value">${escapeHtml(termShort)}</span>
                            </div>
                        </div>
                        <div class="flight-result-preview-actions">
                            <button type="button" class="btn btn-primary btn-choose-flight" data-role="chooseBtn" data-href="${planUrl.replace(/"/g, "&quot;")}">Choose flight</button>
                        </div>
                    </summary>
                    <div class="flight-result-body flight-result-body--departed">
                        <p class="planner-departed-msg" role="status">Quick Look</p>
                        <section class="planner-secondary" aria-label="Quick look details">
                            <div class="planner-details-grid">
                                <p><strong>Departure</strong><span>${escapeHtml(formatDateTime(f.scheduled_departure))}</span></p>
                                <p><strong>Terminal</strong><span>${escapeHtml(f._terminalLabel || f.terminal || "—")}</span></p>
                                <p><strong>Gate</strong><span>${escapeHtml(f.gate || "—")}</span></p>
                                <p><strong>Status</strong><span>${escapeHtml(statusText)}</span></p>
                            </div>
                        </section>
                        <div class="flight-result-actions planner-actions">
                            <button type="button" class="btn-heart ${saved ? "is-saved" : ""}" data-flight-key="${key}" aria-label="${heartLabel}" title="${heartLabel}">
                                <span aria-hidden="true">${saved ? "♥" : "♡"}</span> ${saved ? "Saved" : "Save"}
                            </button>
                            <button type="button" class="btn btn-primary btn-choose-flight" data-role="chooseBtn" data-href="${planUrl.replace(/"/g, "&quot;")}">Choose flight</button>
                        </div>
                    </div>
                </details>
            </li>`;
}

function renderFlightRowHtml(f) {
    if (isFlightDeparted(f)) return renderDepartedFlightRowHtml(f);

    const dest = f.destination_airport || f.destination_city || "—";
    const flightNo = f.flight_number || "—";
    const airline = f.airline || "—";
    const departs = formatTimeOnly(f.scheduled_departure);
    const termShort = f.terminal || "—";
    const depIsoRaw = f.scheduled_departure || "";
    const depMsForStatus = new Date(depIsoRaw).getTime();
    const isDepartedByClock = !Number.isNaN(depMsForStatus) && Date.now() > depMsForStatus;
    const ttd = isDepartedByClock ? "Departed" : formatTimeToDeparture(depIsoRaw);
    const statusText = isDepartedByClock ? "Departed" : f.flight_status || "—";
    const driveDisplay = "—";
    const cushion = 15; // default buffer (customizable in UI)
    const secBase = typeof f._securityMinutes === "number" ? f._securityMinutes : 18;
    const walkBase = typeof f._walkMinutes === "number" ? f._walkMinutes : 12;
    const totalToGate = secBase + walkBase;
    const depMs = new Date(depIsoRaw).getTime();
    const boardingMs = Number.isNaN(depMs) ? null : depMs - 35 * 60000; // target gate arrival ~ boarding start
    const initialBoarding =
        boardingMs == null ? null : new Date(boardingMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const initialRecMs =
        boardingMs == null ? null : boardingMs - (PLAN_PASS0_DRIVE_GUESS_MIN + totalToGate + cushion) * 60000;
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const initialLeaveSafe = initialRecMs == null ? null : fmtTime(initialRecMs - 10 * 60000);
    const initialLeaveRec = initialRecMs == null ? null : fmtTime(initialRecMs);
    const initialLeaveTight = initialRecMs == null ? null : fmtTime(initialRecMs + 10 * 60000);

    const saved = typeof isFlightSaved === "function" && isFlightSaved(f);
    const heartLabel = saved ? "Remove from saved" : "Save flight";
    const fullUrl = buildFlightPageUrl(f);
    const planUrl = buildPlanDetailsUrl(f);
    const key = encodeURIComponent(flightStorageKey(f));

    return `
            <li class="flight-result-item-wrap">
                <details class="flight-result-item" data-flight-key="${key}">
                    <summary class="flight-result-summary">
                        <div class="flight-result-preview" data-role="chooseFlight" data-href="${planUrl.replace(/"/g, "&quot;")}">
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Flight</span>
                                <span class="flight-result-preview-value">${escapeHtml(flightNo)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Airline</span>
                                <span class="flight-result-preview-value">${escapeHtml(airline)}</span>
                            </div>
                            <div class="flight-result-preview-cell flight-result-preview-cell--wide">
                                <span class="flight-result-preview-label">Destination</span>
                                <span class="flight-result-preview-value">${escapeHtml(dest)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Departs</span>
                                <span class="flight-result-preview-value">${escapeHtml(departs)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Time to dep.</span>
                                <span class="flight-result-preview-value">${escapeHtml(ttd)}</span>
                            </div>
                            <div class="flight-result-preview-cell">
                                <span class="flight-result-preview-label">Terminal</span>
                                <span class="flight-result-preview-value">${escapeHtml(termShort)}</span>
                            </div>
                        </div>
                        <div class="flight-result-preview-actions">
                            <button type="button" class="btn btn-primary btn-choose-flight" data-role="chooseBtn" data-href="${planUrl.replace(/"/g, "&quot;")}">Choose flight</button>
                        </div>
                    </summary>
                    <div class="flight-result-body">
                        <p class="planner-departed-msg" role="status">Quick Look</p>
                        <section class="planner-secondary" aria-label="Quick look details">
                            <div class="planner-details-grid">
                                <p><strong>Departure</strong><span>${escapeHtml(formatTimeOnly(f.scheduled_departure))}</span></p>
                                <p class="${initialBoarding ? "" : "is-hidden"}"><strong>Boarding time</strong><span>${escapeHtml(initialBoarding || "")}</span></p>
                                <p><strong>Terminal</strong><span>${escapeHtml(f._terminalLabel || f.terminal || "—")}</span></p>
                                <p><strong>Gate</strong><span>${escapeHtml(f.gate || "—")}</span></p>
                                <p><strong>Status</strong><span>${escapeHtml(statusText)}</span></p>
                            </div>
                        </section>

                        <div class="flight-result-actions planner-actions">
                            <button type="button" class="btn-heart ${saved ? "is-saved" : ""}" data-flight-key="${key}" aria-label="${heartLabel}" title="${heartLabel}">
                                <span aria-hidden="true">${saved ? "♥" : "♡"}</span> ${saved ? "Saved" : "Save"}
                            </button>
                            <button type="button" class="btn btn-primary btn-choose-flight" data-role="chooseBtn" data-href="${planUrl.replace(/"/g, "&quot;")}">Choose flight</button>
                        </div>
                    </div>
                </details>
            </li>`;
}

function buildPlanDetailsUrl(f) {
    const terminalLabel = f._terminalLabel || normalizeTerminalLabel(f.terminal) || "";
    const params = new URLSearchParams({
        airline: f.airline || "",
        flight_number: f.flight_number || "",
        destination_airport: f.destination_airport || "",
        destination_city: f.destination_city || "",
        scheduled_departure: f.scheduled_departure || "",
        terminal: f.terminal || "",
        terminal_label: terminalLabel,
        gate: f.gate || "",
        status: f.flight_status || "",
        terminal_wait: f._securityMinutes == null ? "" : String(f._securityMinutes),
    });
    return `plan-details.html?${params.toString()}`;
}

function bindFlightResultActions() {
    const list = document.getElementById("flight-results-list");
    if (!list) return;
    list.querySelectorAll('[data-role="chooseBtn"]').forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation(); // don't toggle quick look when choosing
            const href = btn.getAttribute("data-href") || "";
            if (href) window.location.href = href;
        });
    });
    list.querySelectorAll(".btn-heart").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const key = decodeURIComponent(btn.getAttribute("data-flight-key") || "");
            const flight = state.latestFlightResults.find((x) => flightStorageKey(x) === key);
            if (!flight || typeof toggleSavedFlight !== "function") return;
            const nowSaved = toggleSavedFlight(flight);
            btn.classList.toggle("is-saved", nowSaved);
            btn.setAttribute("aria-label", nowSaved ? "Remove from saved" : "Save flight");
            btn.setAttribute("title", nowSaved ? "Remove from saved" : "Save flight");
            btn.innerHTML = `<span aria-hidden="true">${nowSaved ? "♥" : "♡"}</span> ${nowSaved ? "Saved" : "Save"}`;
        });
    });
}

function recomputePlanner(panel) {
    const depText = panel.querySelector('[data-role="departsIso"]')?.textContent || "";
    // Use the flight's scheduled_departure embedded in the details dataset if present.
    const detailsEl = panel.closest("details");
    const depIso = detailsEl?.getAttribute("data-departs-iso") || "";
    const depMs = new Date(depIso || depText).getTime();

    const driveInfo = detailsEl
        ? resolvePlannerDrive(detailsEl, panel)
        : {
              minutesForMath: PLAN_PASS0_DRIVE_GUESS_MIN,
              display: "—",
              badgeMode: "no_origin",
              error: "",
              source: "placeholder",
              debugMinutes: PLAN_PASS0_DRIVE_GUESS_MIN,
          };
    const drive = driveInfo.minutesForMath;
    const baseSec = Number(panel.querySelector('[data-role="security"]')?.textContent || 18);
    const walk = Number(panel.querySelector('[data-role="walk"]')?.textContent || 12);

    const cushion = Number(panel.querySelector('input[data-role="cushion"]')?.value || 15);
    const precheck = Boolean(panel.querySelector('input[data-role="precheck"]')?.checked);
    const bags = Boolean(panel.querySelector('input[data-role="bags"]')?.checked);

    const sec = precheck ? Math.max(3, Math.round(baseSec * 0.65)) : baseSec;
    const bagExtra = bags ? 15 : 0; // placeholder bag-drop impact
    const buffer = Math.max(0, cushion + bagExtra);

    const totalToGate = sec + walk;
    const totalAll = drive + totalToGate + buffer;

    // Be at the gate when boarding begins (simple domestic heuristic).
    const boardingMs = Number.isNaN(depMs) ? NaN : depMs - 35 * 60000;
    const boardingTime = Number.isNaN(boardingMs)
        ? "—"
        : new Date(boardingMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    const recLeaveMs = Number.isNaN(boardingMs) ? NaN : boardingMs - totalAll * 60000;
    const leaveSafe = Number.isNaN(recLeaveMs)
        ? "—"
        : new Date(recLeaveMs - 10 * 60000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const leaveRec = Number.isNaN(recLeaveMs)
        ? "—"
        : new Date(recLeaveMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const leaveTight = Number.isNaN(recLeaveMs)
        ? "—"
        : new Date(recLeaveMs + 10 * 60000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    panel.querySelectorAll('[data-role="security"]').forEach((n) => (n.textContent = String(sec)));
    panel.querySelectorAll('[data-role="buffer"]').forEach((n) => (n.textContent = String(buffer)));
    panel.querySelectorAll('[data-role="total"]').forEach((n) => (n.textContent = String(totalToGate)));
    panel.querySelectorAll('[data-role="totalAll"]').forEach((n) => (n.textContent = String(totalAll)));
    panel.querySelectorAll('[data-role="leaveSafe"]').forEach((n) => (n.textContent = String(leaveSafe)));
    panel.querySelectorAll('[data-role="leaveRec"]').forEach((n) => (n.textContent = String(leaveRec)));
    panel.querySelectorAll('[data-role="leaveTight"]').forEach((n) => (n.textContent = String(leaveTight)));
    panel.querySelectorAll('[data-role="drive"]').forEach((n) => {
        n.textContent = driveInfo.display;
        if (driveInfo.error) n.setAttribute("title", driveInfo.error);
        else n.removeAttribute("title");
    });
    panel.querySelectorAll('[data-role="driveSource"]').forEach((n) => {
        n.textContent = driveInfo.source === "google" ? "Google Routes" : "";
    });
    updatePlannerBadge(panel, driveInfo);
    if (detailsEl) updatePlannerDriveFeedback(panel, detailsEl, driveInfo);

    const boardingWrap = panel.querySelector('[data-role="boardingWrap"]');
    const boardingField = panel.querySelector('[data-role="boardingField"]');
    if (boardingWrap) boardingWrap.classList.toggle("is-hidden", boardingTime === "—");
    if (boardingField) boardingField.classList.toggle("is-hidden", boardingTime === "—");
    panel.querySelectorAll('[data-role="boardingTime"]').forEach((n) => (n.textContent = boardingTime === "—" ? "" : boardingTime));

    // Status consistency: departed overrides API status.
    const statusEls = panel.querySelectorAll('[data-role="statusText"]');

    // Past / imminent / feasibility guardrails based on DEPARTURE time.
    const nowMs = Date.now();
    const isPast = !Number.isNaN(depMs) && nowMs > depMs;
    const timeToDepMin = Number.isNaN(depMs) ? null : Math.max(0, Math.floor((depMs - nowMs) / 60000));
    const isImminent = timeToDepMin != null && !isPast && timeToDepMin <= 30;

    // Near-departure feasibility: if remaining time < total time needed, hide recommendations.
    const notEnoughTime = timeToDepMin != null && !isPast && timeToDepMin < totalAll;

    // Force departed status in UI if clock says departed.
    if (statusEls?.length) {
        statusEls.forEach((el) => {
            if (isPast) el.textContent = "Departed";
        });
    }

    const alert = panel.querySelector('[data-role="flightAlert"]');
    const reco = panel.querySelector('[data-role="plannerReco"]');
    const metrics = panel.querySelector('[data-role="plannerMetrics"]');
    const custom = panel.querySelector('[data-role="plannerCustomize"]');

    if (alert) {
        alert.classList.toggle("is-hidden", !(isPast || isImminent || notEnoughTime));
        alert.classList.toggle("planner-alert--past", isPast);
        alert.classList.toggle("planner-alert--warn", (isImminent || notEnoughTime) && !isPast);
        if (isPast) {
            alert.textContent = "This flight has already departed";
        } else if (notEnoughTime) {
            alert.textContent =
                timeToDepMin != null
                    ? `You may not have enough time to make this flight. You need ~${totalAll} minutes but only have ${timeToDepMin} minutes.`
                    : "You may not have enough time to make this flight";
        } else if (isImminent) {
            alert.textContent = "You may not have enough time to make this flight";
        } else {
            alert.textContent = "";
        }
    }

    // If already departed: hide recommendation + breakdown + customization.
    // If not enough time: hide recommendation + breakdown (avoid conflicting guidance), keep details visible.
    if (reco) reco.classList.toggle("is-hidden", isPast || notEnoughTime);
    if (metrics) metrics.classList.toggle("is-hidden", isPast || notEnoughTime);
    if (custom) custom.classList.toggle("is-hidden", isPast);
}

function bindPlannerControls() {
    const list = document.getElementById("flight-results-list");
    if (!list) return;
    list.querySelectorAll("details.flight-result-item").forEach((detailsEl) => {
        if (detailsEl.getAttribute("data-departed") === "1") return;

        const key = detailsEl.getAttribute("data-flight-key") || "";
        const flight = state.latestFlightResults.find((x) => encodeURIComponent(flightStorageKey(x)) === key);
        if (flight?.scheduled_departure) detailsEl.setAttribute("data-departs-iso", flight.scheduled_departure);

        const panel = detailsEl.querySelector(".flight-result-body");
        if (!panel) return;

        const inputs = panel.querySelectorAll('input[data-role="cushion"], input[data-role="precheck"], input[data-role="bags"]');
        inputs.forEach((el) => {
            el.addEventListener("input", () => {
                recomputePlanner(panel);
                schedulePlannerDriveEstimate(detailsEl, panel);
            });
            el.addEventListener("change", () => {
                recomputePlanner(panel);
                schedulePlannerDriveEstimate(detailsEl, panel);
            });
        });

        detailsEl.addEventListener("toggle", () => {
            if (!detailsEl.open) return;
            recomputePlanner(panel);
            void setupPlannerOriginInput(detailsEl, panel);
            schedulePlannerDriveEstimate(detailsEl, panel);
        });
    });
}

function renderFlightResultsList() {
    const wrap = document.getElementById("flight-results-wrap");
    const list = document.getElementById("flight-results-list");
    const toolbar = document.getElementById("flight-results-toolbar");
    const base = state.baseEnrichedResults || [];

    if (!base.length) {
        wrap?.classList.add("is-hidden");
        toolbar?.classList.add("is-hidden");
        return;
    }

    wrap?.classList.remove("is-hidden");
    toolbar?.classList.remove("is-hidden");
    updateActiveContext(null);

    const { flights: filtered, emptyUpcomingButHasDeparted } = applyFlightFilters(base);
    state.latestFlightResults = filtered;

    if (!filtered.length) {
        if (emptyUpcomingButHasDeparted) {
            list.innerHTML = `<li class="flight-results-empty"><p>No upcoming flights found. Try another route or show departed flights.</p></li>`;
        } else {
            list.innerHTML = `<li class="flight-results-empty"><p>No flights match your filters. Try another terminal or time window.</p></li>`;
        }
        return;
    }

    list.innerHTML = filtered.map((f) => renderFlightRowHtml(f)).join("");
    bindFlightResultActions();
}

function renderFlightResults(payload, results) {
    const wrap = document.getElementById("flight-results-wrap");
    const list = document.getElementById("flight-results-list");
    if (!wrap || !list) return;

    if (!results.length) {
        wrap.classList.add("is-hidden");
        document.getElementById("flight-results-toolbar")?.classList.add("is-hidden");
        list.innerHTML = "";
        state.baseEnrichedResults = [];
        clearMetaInterval();
        document.getElementById("flight-search-meta")?.classList.add("is-hidden");
        return;
    }

    resetResultFilters();
    state.baseEnrichedResults = results.map(enrichFlight);
    setFlightSearchMeta(payload);
    renderFlightResultsList();
}

function getRecentSearches() {
    try {
        const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function setRecentSearches(entries) {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(entries));
}

function pushRecentSearch(entry) {
    const key = JSON.stringify(entry);
    let list = getRecentSearches().filter((x) => JSON.stringify(x) !== key);
    list.unshift(entry);
    list = list.slice(0, RECENT_SEARCHES_MAX);
    setRecentSearches(list);
    renderRecentSearches();
}

function renderRecentSearches() {
    const wrap = document.getElementById("recent-searches");
    const ul = document.getElementById("recent-searches-list");
    if (!wrap || !ul) return;
    const list = getRecentSearches();
    if (!list.length) {
        wrap.classList.add("is-hidden");
        ul.innerHTML = "";
        return;
    }
    wrap.classList.remove("is-hidden");
    const items = list
        .map((entry) => {
            const label =
                entry.mode === "flight"
                    ? entry.flight || "Flight"
                    : `${entry.airline || "—"} → ${entry.destination || "—"}`;
            const data = encodeURIComponent(JSON.stringify(entry));
            return `<button type="button" class="chip" data-recent="${data}">${escapeHtml(label)}</button>`;
        })
        .join("");

    // plan.html uses a div for chips; legacy pages may use a list.
    if (ul.tagName.toLowerCase() === "ul") {
        ul.innerHTML = list
            .map((entry) => {
                const label =
                    entry.mode === "flight"
                        ? entry.flight || "Flight"
                        : `${entry.airline || "—"} → ${entry.destination || "—"}`;
                const data = encodeURIComponent(JSON.stringify(entry));
                return `<li class="recent-searches-item"><button type="button" class="recent-search-chip" data-recent="${data}">${escapeHtml(
                    label,
                )}</button></li>`;
            })
            .join("");
    } else {
        ul.innerHTML = items;
    }
}

function clearFlightSearchUi() {
    clearMetaInterval();
    state.baseEnrichedResults = [];
    state.latestFlightResults = [];
    state.lastSearchPayload = null;
    document.getElementById("flight-results-wrap")?.classList.add("is-hidden");
    document.getElementById("flight-results-toolbar")?.classList.add("is-hidden");
    document.getElementById("flight-search-meta")?.classList.add("is-hidden");
    const list = document.getElementById("flight-results-list");
    if (list) list.innerHTML = "";
    const fi = document.getElementById("flight-input");
    const ai = document.getElementById("airline-input");
    const di = document.getElementById("destination-input");
    if (fi) fi.value = "";
    if (ai) ai.value = "";
    if (di) di.value = "";
    resetResultFilters();
    hideTripError();
    updateActiveContext(null);
}

function attachAutocomplete(inputId, listId, corpus) {
    const input = document.getElementById(inputId);
    const box = document.getElementById(listId);
    if (!input || !box) return;

    let blurTimer = null;

    function hideBox() {
        box.classList.add("is-hidden");
        box.setAttribute("hidden", "");
        box.innerHTML = "";
    }

    function showSuggestions() {
        const picks = rankSuggestions(input.value, corpus);
        if (!picks.length) {
            hideBox();
            return;
        }
        box.innerHTML = picks
            .map(
                (text) =>
                    `<li role="option" tabindex="-1" class="suggestions-item" data-value="${encodeURIComponent(
                        text,
                    )}">${escapeHtml(text)}</li>`,
            )
            .join("");
        box.classList.remove("is-hidden");
        box.removeAttribute("hidden");

        box.querySelectorAll(".suggestions-item").forEach((li) => {
            li.addEventListener("mousedown", (e) => {
                e.preventDefault();
                input.value = decodeURIComponent(li.getAttribute("data-value") || "");
                hideBox();
                input.focus();
            });
        });
    }

    input.addEventListener("input", () => {
        clearTimeout(blurTimer);
        showSuggestions();
    });

    input.addEventListener("focus", () => {
        showSuggestions();
    });

    input.addEventListener("blur", () => {
        blurTimer = setTimeout(hideBox, 150);
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideBox();
    });
}

function initTripPlanner() {
    const modeFlight = document.getElementById("mode-flight");
    const modeRoute = document.getElementById("mode-route");
    const formFlight = document.getElementById("lookup-form-flight");
    const formRoute = document.getElementById("lookup-form-route");

    if (!modeFlight || !modeRoute || !formFlight || !formRoute) return;

    modeFlight.addEventListener("click", () => setMode("flight"));
    modeRoute.addEventListener("click", () => setMode("route"));
    setMode("flight");

    attachAutocomplete("flight-input", "flight-input-suggestions", AIRLINE_SUGGESTIONS);
    attachAutocomplete("airline-input", "airline-suggestions", AIRLINE_SUGGESTIONS);
    attachAutocomplete("destination-input", "destination-suggestions", DESTINATION_SUGGESTIONS);

    const dateInput = document.getElementById("departure-date-input");
    if (dateInput && !dateInput.value) dateInput.value = todayIsoLocalDate();

    renderRecentSearches();

    document.getElementById("recent-searches-list")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-recent]");
        if (!btn) return;
        let entry;
        try {
            entry = JSON.parse(decodeURIComponent(btn.getAttribute("data-recent") || ""));
        } catch {
            return;
        }
        if (entry.mode === "flight") {
            setMode("flight");
            document.getElementById("flight-input").value = entry.flight || "";
            if (typeof formFlight.requestSubmit === "function") formFlight.requestSubmit();
            else formFlight.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        } else if (entry.mode === "route") {
            setMode("route");
            document.getElementById("airline-input").value = entry.airline || "";
            document.getElementById("destination-input").value = entry.destination || "";
            const di = document.getElementById("departure-date-input");
            if (di) di.value = entry.date || di.value || todayIsoLocalDate();
            if (typeof formRoute.requestSubmit === "function") formRoute.requestSubmit();
            else formRoute.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        }
    });

    formFlight.addEventListener("submit", (e) => {
        e.preventDefault();
        hideTripError();
        const flightInput = normalizeFlightNumber(document.getElementById("flight-input").value);
        if (!flightInput) {
            showTripError("Enter a flight number, for example UA1234.");
            return;
        }

        searchFlights({})
            .then((payload) => {
                const filtered = (payload.results || []).filter(
                    (f) => normalizeFlightNumber(f.flight_number || "") === flightInput,
                );
                if (!filtered.length) {
                    showTripError("No matching EWR departure found.");
                    document.getElementById("flight-results-wrap")?.classList.add("is-hidden");
                    document.getElementById("flight-results-toolbar")?.classList.add("is-hidden");
                    return;
                }
                pushRecentSearch({ mode: "flight", flight: flightInput });
                renderFlightResults(payload, filtered);
            })
            .catch((err) => {
                showTripError(`Flight search failed: ${err.message}`);
            });
    });

    formRoute.addEventListener("submit", (e) => {
        e.preventDefault();
        hideTripError();
        const airline = document.getElementById("airline-input").value.trim();
        const destination = document.getElementById("destination-input").value.trim();
        const date = getSelectedDepartureDate();
        searchFlights({ airline, destination })
            .then((payload) => {
                const rows = filterFlightsForSelectedDate(payload.results || []);
                if (!rows.length) {
                    showTripError("No matching EWR departures found.");
                    document.getElementById("flight-results-wrap")?.classList.add("is-hidden");
                    document.getElementById("flight-results-toolbar")?.classList.add("is-hidden");
                    return;
                }
                pushRecentSearch({ mode: "route", airline, destination, date });
                renderFlightResults(payload, rows);
            })
            .catch((err) => {
                showTripError(`Flight search failed: ${err.message}`);
            });
    });

    ["flight-sort", "flight-filter-terminal", "flight-filter-window", "flight-filter-show-departed"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", () => {
            if (state.baseEnrichedResults?.length) renderFlightResultsList();
        });
    });

    document.getElementById("clear-flight-search")?.addEventListener("click", () => {
        clearFlightSearchUi();
    });

    // Keep active-context behavior only when the element exists (plan.html doesn't use it yet).
    const list = document.getElementById("flight-results-list");
    if (list && document.getElementById("active-flight-context")) {
        list.addEventListener("toggle", (e) => {
            const details = e.target;
            if (!details.classList.contains("flight-result-item")) return;
            if (details.open) {
                list.querySelectorAll(".flight-result-item").forEach((d) => {
                    if (d !== details) d.open = false;
                });
            }
            const open = list.querySelector(".flight-result-item[open]");
            if (!open) {
                updateActiveContext(null);
                return;
            }
            const key = decodeURIComponent(open.getAttribute("data-flight-key") || "");
            const f = state.latestFlightResults.find((x) => flightStorageKey(x) === key);
            updateActiveContext(f || null);
        });
    }

    const refreshLive = document.getElementById("refresh-live-btn");
    if (refreshLive) {
        refreshLive.addEventListener("click", () => {
            hideTripError();
            const airline = document.getElementById("airline-input")?.value?.trim() || "";
            const destination = document.getElementById("destination-input")?.value?.trim() || "";
            const date = getSelectedDepartureDate();
            if (!airline && !destination) {
                showTripError("Enter an airline and/or destination before refreshing live data.");
                return;
            }
            searchFlights({ airline, destination, force_refresh: true })
                .then((payload) => {
                    const rows = filterFlightsForSelectedDate(payload.results || []);
                    if (!rows.length) {
                        showTripError("No matching EWR departures found.");
                        document.getElementById("flight-results-wrap")?.classList.add("is-hidden");
                        document.getElementById("flight-results-toolbar")?.classList.add("is-hidden");
                        return;
                    }
                    pushRecentSearch({ mode: "route", airline, destination, date });
                    renderFlightResults(payload, rows);
                })
                .catch((err) => {
                    showTripError(`Live refresh failed: ${err.message}`);
                });
        });
    }

    if (document.getElementById("flight-results-list")) {
        void (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/config/google-maps`);
                if (res.ok) {
                    const cfg = await res.json();
                    state.googleMapsClient = {
                        enabled: Boolean(cfg.enabled),
                        apiKey: typeof cfg.api_key === "string" ? cfg.api_key : "",
                    };
                }
            } catch {
                /* non-fatal */
            }
            void ensureGoogleMapsPlaces();
        })();
    }
}

const refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
        initializeWaitOverview();
    });
}

initTripPlanner();
// Needed for security estimates on Plan page and for rendering on Wait Times page.
initializeWaitOverview();

