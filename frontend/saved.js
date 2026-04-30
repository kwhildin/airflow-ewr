function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
}

function formatDateTime(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

function formatTimeOnly(ms) {
    if (ms == null || Number.isNaN(ms)) return "—";
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const API_BASE =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://127.0.0.1:8000"
        : "https://airflow-ewr.onrender.com";

let __savedPlansWaitsCache = null;

function normalizeTerminalLetter(raw) {
    const t = String(raw || "").trim().toUpperCase();
    if (!t) return "";
    if (t.includes("A")) return "A";
    if (t.includes("B")) return "B";
    if (t.includes("C")) return "C";
    return t;
}

function parkingLotShortCode(id) {
    const raw = String(id || "");
    if (raw.startsWith("p1_")) return "P1";
    if (raw.startsWith("p2_")) return "P2";
    if (raw.startsWith("p3_")) return "P3";
    if (raw.startsWith("p4_")) return "P4";
    if (raw.startsWith("p6_")) return "P6";
    return "P4";
}

/** Display-only route line for saved plan cards (matches plan search style). */
function formatSavedRouteLine(f) {
    const fnRaw = String(f.flight_number || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "") || "—";
    const fn = escapeHtml(fnRaw);
    const ap = String(f.destination_airport || "").trim();
    if (ap) return `${fn} → ${escapeHtml(ap.toUpperCase())}`;
    const city = String(f.destination_city || "").trim();
    if (city) return `${fn} → ${escapeHtml(city)}`;
    return fn;
}

function formatDepartureParts(iso) {
    if (!iso) return { date: "—", time: "—" };
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: "—", time: "—" };
    return {
        date: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    };
}

function departureDayBucket(iso) {
    const d = new Date(iso || "");
    if (Number.isNaN(d.getTime())) return "upcoming";
    const depDay = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const now = new Date();
    const today0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow0 = today0 + 86400000;
    if (depDay < today0) return "past";
    if (depDay === today0) return "today";
    if (depDay === tomorrow0) return "tomorrow";
    return "upcoming";
}

/** Same URL rules as plan-details airport directions (display-only link). */
function buildAirportDirectionsUrl(plan) {
    const f = plan?.flight || {};
    const termLetter = normalizeTerminalLetter(f.terminal);
    const gateRaw = String(f.gate || "").trim().replace(/\s+/g, "");
    const park = Boolean(plan?.park);
    const lotId = String(plan?.parkingLotId || "").trim();
    const fromParam =
        park && lotId ? parkingLotShortCode(lotId) : termLetter ? `Security-${termLetter}` : "Security";
    const toParam = gateRaw;
    const terminalParam = termLetter || "";
    if (!terminalParam || !toParam) return "";
    return `airport-map.html?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}&terminal=${encodeURIComponent(terminalParam)}`;
}

const SAVED_PLAN_GROUPS = ["today", "tomorrow", "upcoming", "past"];
const SAVED_PLAN_GROUP_LABEL = {
    today: "Today",
    tomorrow: "Tomorrow",
    upcoming: "Upcoming",
    past: "Earlier",
};

async function fetchTerminalWaitsOnce() {
    if (__savedPlansWaitsCache) return __savedPlansWaitsCache;
    try {
        const res = await fetch(`${API_BASE}/api/security/waits?outlook_minutes=0`);
        if (!res.ok) throw new Error(await res.text());
        const payload = await res.json();
        __savedPlansWaitsCache = payload.terminals || [];
        return __savedPlansWaitsCache;
    } catch {
        __savedPlansWaitsCache = [];
        return __savedPlansWaitsCache;
    }
}

function pickTerminalWait(terminals, termLetter) {
    const want = `Terminal ${termLetter}`;
    const hit = (terminals || []).find((t) => String(t.terminal || "") === want);
    return hit ? Number(hit.minutes) : null;
}

function computeAddOnsMinutes({ bags, park }) {
    const bagExtra = bags ? 15 : 0;
    const parkExtra = park ? 12 : 0;
    return bagExtra + parkExtra;
}

function computeLeaveTimes({ depMs, driveMin, securityMin, walkMin, bufferMin }) {
    const boardingMs = depMs - 35 * 60000;
    const gateTargetMs = boardingMs - Math.max(0, Number(bufferMin || 0)) * 60000;
    const travelMs = (driveMin + securityMin + walkMin) * 60000;
    const recLeaveMs = gateTargetMs - travelMs;
    return { boardingMs, gateTargetMs, recMs: recLeaveMs };
}

function buildSavedPlanTimelineHtml(plan, terminals) {
    const f = plan?.flight || {};
    const depMs = new Date(f.scheduled_departure || "").getTime();
    const validDep = !Number.isNaN(depMs);

    const driveMin = typeof plan?.driveMin === "number" ? plan.driveMin : 42;
    const gateBufferMin = Math.max(0, Number(plan?.cushion ?? 15));
    const bags = Boolean(plan?.bags);
    const park = Boolean(plan?.park);
    const precheck = Boolean(plan?.precheck);
    const addOnsMin = computeAddOnsMinutes({ bags, park });

    const termLetter = normalizeTerminalLetter(f.terminal);
    const secFromWait = termLetter ? pickTerminalWait(terminals, termLetter) : null;
    const secBase = secFromWait != null ? secFromWait : 18;
    const securityMin = precheck ? Math.max(3, Math.round(secBase * 0.65)) : secBase;
    const walkMin = 12;

    const times = validDep
        ? computeLeaveTimes({
              depMs,
              driveMin: driveMin + addOnsMin,
              securityMin,
              walkMin,
              bufferMin: gateBufferMin,
          })
        : null;

    const leaveMs = times ? times.recMs : NaN;
    const arriveMs = times ? leaveMs + driveMin * 60000 : NaN;
    const addOnsStartMs = times ? arriveMs : NaN;
    const securityStartMs = times ? addOnsStartMs + addOnsMin * 60000 : NaN;
    const walkStartMs = times ? securityStartMs + securityMin * 60000 : NaN;
    const gateMs = times ? times.gateTargetMs : NaN;
    const boardingMs = times ? times.boardingMs : NaN;

    const addOnsTitle = bags && park ? "Park + check bag" : park ? "Park at EWR" : "Check bag";
    const addOnsSub =
        bags && park
            ? "Parking + bag drop"
            : park
              ? "Parking time"
              : "Bag drop";

    const driveSub = typeof plan?.driveMin === "number" ? "Routes" : "Estimate";
    const secSub = secFromWait != null ? "Live wait" : "Estimate";

    const showAddOns = addOnsMin > 0;

    return `
        <div class="saved-plan-timeline-outer">
            <div class="saved-plan-timeline-scroll">
            <div class="saved-plan-timeline" role="list" aria-label="Saved plan itinerary">
            <div class="saved-plan-step" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(leaveMs))}</p>
                    <p class="saved-plan-step-title">Leave</p>
                    <p class="saved-plan-step-sub">${escapeHtml(driveSub)}</p>
                    <p class="saved-plan-step-meta"><strong>${escapeHtml(String(typeof plan?.driveMin === "number" ? plan.driveMin : "—"))}</strong><span>min</span></p>
                </div>
            </div>

            ${
                showAddOns
                    ? `
            <div class="saved-plan-step" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(addOnsStartMs))}</p>
                    <p class="saved-plan-step-title">${escapeHtml(addOnsTitle)}</p>
                    <p class="saved-plan-step-sub">${escapeHtml(addOnsSub)}</p>
                    <p class="saved-plan-step-meta"><strong>${escapeHtml(String(addOnsMin))}</strong><span>min</span></p>
                </div>
            </div>`
                    : ""
            }

            <div class="saved-plan-step" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(securityStartMs))}</p>
                    <p class="saved-plan-step-title">Security</p>
                    <p class="saved-plan-step-sub">${escapeHtml(secSub)}</p>
                    <p class="saved-plan-step-meta"><strong>${escapeHtml(String(securityMin))}</strong><span>min</span></p>
                </div>
            </div>

            <div class="saved-plan-step" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(walkStartMs))}</p>
                    <p class="saved-plan-step-title">Walk</p>
                    <p class="saved-plan-step-sub">To gate</p>
                    <p class="saved-plan-step-meta"><strong>${escapeHtml(String(walkMin))}</strong><span>min</span></p>
                </div>
            </div>

            <div class="saved-plan-step saved-plan-step--gate" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(gateMs))}</p>
                    <p class="saved-plan-step-title">At gate</p>
                    <p class="saved-plan-step-sub">Arrive by</p>
                </div>
            </div>

            <div class="saved-plan-step saved-plan-step--boarding" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(boardingMs))}</p>
                    <p class="saved-plan-step-title">Boarding</p>
                    <p class="saved-plan-step-sub">Starts</p>
                    <p class="saved-plan-step-meta saved-plan-step-meta--muted"><span>boarding</span></p>
                </div>
            </div>
            </div>
            </div>
        </div>
    `;
}

async function hydrateSavedPlansTimelines(rootEl) {
    if (!rootEl) return;
    const terminals = await fetchTerminalWaitsOnce();
    rootEl.querySelectorAll("details.saved-card[data-saved-plan]").forEach((details) => {
        let plan = null;
        try {
            plan = JSON.parse(decodeURIComponent(details.getAttribute("data-saved-plan") || ""));
        } catch {
            plan = null;
        }
        if (!plan) return;
        const host = details.querySelector("[data-saved-plan-timeline]");
        if (!host) return;
        host.innerHTML = buildSavedPlanTimelineHtml(plan, terminals);
    });
}

function seedSavedPlanTimelines(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll("details.saved-card[data-saved-plan]").forEach((details) => {
        let plan = null;
        try {
            plan = JSON.parse(decodeURIComponent(details.getAttribute("data-saved-plan") || ""));
        } catch {
            plan = null;
        }
        if (!plan) return;
        const host = details.querySelector("[data-saved-plan-timeline]");
        if (!host) return;
        // Fast first paint (terminal waits refresh async).
        host.innerHTML = buildSavedPlanTimelineHtml(plan, []);
    });
}

function urgencyForLeaveIn(leaveInMin) {
    if (leaveInMin == null) return { level: "neutral", label: "—", warn: "" };
    if (leaveInMin < 0) return { level: "danger", label: "Past leave time", warn: "Past recommended leave time" };
    if (leaveInMin < 45) return { level: "warn", label: "Leaving soon", warn: "Leaving window is tight" };
    return { level: "neutral", label: "On track", warn: "" };
}

function buildPlanDetailsUrlFromPlan(plan) {
    const f = plan?.flight || {};
    const params = new URLSearchParams({
        airline: f.airline || "",
        flight_number: f.flight_number || "",
        destination_airport: f.destination_airport || "",
        destination_city: f.destination_city || "",
        scheduled_departure: f.scheduled_departure || "",
        terminal: f.terminal || "",
        gate: f.gate || "",
        status: f.status || f.flight_status || "",
        terminal_wait: f.terminal_wait == null ? "" : String(f.terminal_wait),
        from: "saved",
    });
    return `plan-details.html?${params.toString()}`;
}

function getSavedPlans() {
    try {
        const raw = localStorage.getItem("airflow_saved_plans_v1");
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function setSavedPlans(list) {
    localStorage.setItem("airflow_saved_plans_v1", JSON.stringify(list));
}

function removeSavedPlan(id) {
    const next = getSavedPlans().filter((p) => p?.id !== id);
    setSavedPlans(next);
}

function renderSavedPlanCardHtml(p) {
    const f = p.flight || {};
    const flightNo = f.flight_number || "—";
    const airline = f.airline || "—";
    const routeLine = formatSavedRouteLine(f);
    const depParts = formatDepartureParts(f.scheduled_departure);
    const planUrl = buildPlanDetailsUrlFromPlan(p);
    const safePlanUrl = planUrl.replace(/"/g, "&quot;");
    const id = encodeURIComponent(p.id || "");
    const planPayload = encodeURIComponent(JSON.stringify(p));
    const mapUrl = buildAirportDirectionsUrl(p);
    const mapHref = mapUrl ? mapUrl.replace(/"/g, "&quot;") : "";
    const mapBtn =
        mapUrl && mapHref
            ? `<a class="btn btn-ghost saved-plan-action-map" href="${mapHref}">Airport directions</a>`
            : `<button type="button" class="btn btn-ghost saved-plan-action-map" disabled title="Gate and terminal required for directions">Airport directions</button>`;

    const chips = [];
    const termRaw = String(f.terminal || "").trim();
    if (termRaw && termRaw !== "—") {
        const tl = termRaw.toUpperCase().replace(/TERMINAL\s*/i, "").trim();
        if (/^[ABC]$/.test(tl)) {
            chips.push(`<span class="saved-chip saved-chip--term">Terminal ${tl}</span>`);
        } else {
            chips.push(`<span class="saved-chip saved-chip--term">${escapeHtml(termRaw)}</span>`);
        }
    }
    const gateRaw = String(f.gate || "").trim();
    if (gateRaw && gateRaw !== "—") {
        chips.push(`<span class="saved-chip saved-chip--gate">Gate ${escapeHtml(gateRaw)}</span>`);
    }
    const chipsHtml = chips.length ? `<div class="saved-itin-chips">${chips.join("")}</div>` : "";

    return `
            <li class="flight-result-item-wrap">
                <details class="saved-card saved-card--plan" data-saved-plan="${planPayload}">
                    <summary class="saved-card-summary saved-card-summary--plan">
                        <div class="saved-itin-col saved-itin-col--flight">
                            <span class="saved-itin-flight-no">${escapeHtml(flightNo)}</span>
                            <span class="saved-itin-airline">${escapeHtml(airline)}</span>
                        </div>
                        <div class="saved-itin-col saved-itin-col--route">
                            <span class="saved-itin-route">${routeLine}</span>
                            ${chipsHtml}
                        </div>
                        <div class="saved-itin-col saved-itin-col--when">
                            <span class="saved-itin-dep-date">${escapeHtml(depParts.date)}</span>
                            <span class="saved-itin-dep-time">${escapeHtml(depParts.time)}</span>
                            <span class="saved-plan-pill">Saved plan</span>
                        </div>
                    </summary>
                    <div class="saved-card-body saved-card-body--plan">
                        <div data-saved-plan-timeline></div>
                        <div class="saved-plan-actions saved-plan-actions--trips">
                            <div class="saved-plan-actions-primary">
                                <a class="btn btn-primary" href="${safePlanUrl}">Open timeline</a>
                                ${mapBtn}
                            </div>
                            <div class="saved-plan-actions-end">
                                <a class="btn btn-ghost" href="${safePlanUrl}">Edit plan</a>
                                <button type="button" class="btn btn-saved-remove" data-plan-id="${id}" aria-label="Remove saved plan" title="Remove saved plan">Remove</button>
                            </div>
                        </div>
                    </div>
                </details>
            </li>`;
}

function renderSavedPlansList() {
    const container = document.getElementById("saved-plans-list");
    const countEl = document.getElementById("saved-plans-count");
    if (!container) return;

    const plans = getSavedPlans();
    if (countEl) countEl.textContent = `${plans.length}`;

    if (!plans.length) {
        container.innerHTML =
            `<li class="saved-empty saved-empty--plans" style="list-style:none;">
                <div class="saved-empty-visual" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none"><rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 3.5V7M16 3.5V7M3.5 10.5h17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 14h4M8 17h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </div>
                <div class="saved-empty-inner">
                    <p class="saved-empty-title">No saved plans yet</p>
                    <p class="saved-empty-copy">Build a plan on Plan My Trip, then save it to see your timeline here.</p>
                    <a class="btn btn-primary saved-empty-cta" href="plan.html">Plan My Trip</a>
                </div>
             </li>`;
        return;
    }

    const sorted = [...plans].sort((a, b) => {
        const ta = new Date(a?.flight?.scheduled_departure || 0).getTime();
        const tb = new Date(b?.flight?.scheduled_departure || 0).getTime();
        return ta - tb;
    });

    const buckets = { today: [], tomorrow: [], upcoming: [], past: [] };
    for (const p of sorted) {
        const bucket = departureDayBucket(p?.flight?.scheduled_departure);
        buckets[bucket].push(p);
    }

    const parts = [];
    for (const key of SAVED_PLAN_GROUPS) {
        const group = buckets[key];
        if (!group.length) continue;
        parts.push(
            `<li class="saved-group-heading" role="presentation"><span class="saved-group-heading-text">${SAVED_PLAN_GROUP_LABEL[key]}</span></li>`,
        );
        for (const p of group) {
            parts.push(renderSavedPlanCardHtml(p));
        }
    }

    container.innerHTML = parts.join("");

    container.querySelectorAll("[data-plan-id]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = decodeURIComponent(btn.getAttribute("data-plan-id") || "");
            if (id) {
                removeSavedPlan(id);
                renderSavedPlansList();
            }
        });
    });

    seedSavedPlanTimelines(container);
    void hydrateSavedPlansTimelines(container);
}

function renderSavedList() {
    const container = document.getElementById("saved-list");
    const countEl = document.getElementById("saved-count");
    const flights = getSavedFlights();

    if (countEl) countEl.textContent = `${flights.length}`;

    if (!flights.length) {
        container.innerHTML =
            `<li class="saved-empty saved-empty--flights" style="list-style:none;">
                <div class="saved-empty-visual" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V6l8-4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </div>
                <div class="saved-empty-inner">
                    <p class="saved-empty-title">No saved flights yet</p>
                    <p class="saved-empty-copy">Search for a flight and save it to keep it here.</p>
                    <a class="btn btn-primary saved-empty-cta" href="plan.html">Plan My Trip</a>
                </div>
             </li>`;
        return;
    }

    container.innerHTML = flights
        .map((f) => {
            const dest = f.destination_airport || f.destination_city || "—";
            const flightNo = f.flight_number || "—";
            const airline = f.airline || "—";
            const departs = formatDateTime(f.scheduled_departure);
            const termShort = f.terminal || "—";
            const sec = f._securityMinutes;
            const walk = f._walkMinutes;
            const total = f._totalToGateMinutes;
            const drive = 42;
            const cushion = 15;
            const secMin = typeof sec === "number" ? sec : 18;
            const walkMin = typeof walk === "number" ? walk : 12;
            const depMs = new Date(f.scheduled_departure || "").getTime();
            const departed = !Number.isNaN(depMs) && Date.now() > depMs;

            // Boarding heuristic + leave time (same style as Plan page).
            const boardingMs = Number.isNaN(depMs) ? NaN : depMs - 35 * 60000;
            const totalAll = drive + secMin + walkMin + cushion;
            const leaveByMs = Number.isNaN(boardingMs) ? NaN : boardingMs - totalAll * 60000;
            const leaveInMin = Number.isNaN(leaveByMs) ? null : Math.round((leaveByMs - Date.now()) / 60000);
            const leaveByLabel = formatTimeOnly(leaveByMs);
            const urgency = urgencyForLeaveIn(leaveInMin);

            const primaryLeave =
                departed
                    ? `<span class="saved-primary saved-primary--muted">Departed</span>`
                    : leaveInMin != null && leaveInMin >= 0
                      ? `<span class="saved-primary">Leave in <strong>${leaveInMin}</strong> min</span>`
                      : `<span class="saved-primary">Leave by <strong>${escapeHtml(leaveByLabel)}</strong></span>`;

            const warning =
                departed
                    ? ""
                    : urgency.warn
                      ? `<p class="saved-warn saved-warn--${urgency.level}">${escapeHtml(urgency.warn)}</p>`
                      : "";

            return `
            <li class="flight-result-item-wrap">
                <details class="saved-card saved-card--${urgency.level}">
                    <summary class="saved-card-summary">
                        <div class="saved-card-left">
                            <p class="saved-flight">${escapeHtml(flightNo)}</p>
                            <p class="saved-dest">${escapeHtml(dest)}</p>
                            <p class="saved-meta">${escapeHtml(airline)} · Departs ${escapeHtml(departs)} · ${escapeHtml(termShort)}</p>
                        </div>
                        <div class="saved-card-right">
                            ${primaryLeave}
                            <span class="saved-status saved-status--${urgency.level}">${escapeHtml(urgency.label)}</span>
                        </div>
                    </summary>
                    <div class="saved-card-body">
                        ${warning}
                        <div class="saved-mini-metrics">
                            <div class="saved-mini"><span>Drive</span><strong>${drive}</strong><em>m</em></div>
                            <div class="saved-mini"><span>Security</span><strong>${secMin}</strong><em>m</em></div>
                            <div class="saved-mini"><span>Walk</span><strong>${walkMin}</strong><em>m</em></div>
                            <div class="saved-mini"><span>Buffer</span><strong>${cushion}</strong><em>m</em></div>
                            <div class="saved-mini saved-mini--total"><span>Total</span><strong>${totalAll}</strong><em>m</em></div>
                        </div>
                        <div class="saved-custom">
                            <p class="saved-custom-title">Assumptions</p>
                            <div class="saved-custom-grid">
                                <label class="field saved-field saved-field--full">
                                    <span class="field-label">Starting address</span>
                                    <input class="field-input" type="text" placeholder="Placeholder only (no maps yet)" disabled />
                                </label>
                                <label class="field saved-field">
                                    <span class="field-label">Arrival cushion (min)</span>
                                    <input class="field-input" type="number" value="${cushion}" disabled />
                                </label>
                                <label class="saved-toggle">
                                    <input type="checkbox" disabled />
                                    <span>TSA PreCheck</span>
                                </label>
                                <label class="saved-toggle">
                                    <input type="checkbox" disabled />
                                    <span>Checked bag</span>
                                </label>
                            </div>
                        </div>
                        <div class="saved-actions">
                            <a class="btn btn-primary" href="plan.html">Open Plan</a>
                            <button type="button" class="btn btn-ghost" data-flight-key="${encodeURIComponent(flightStorageKey(f))}" aria-label="Remove saved flight" title="Remove saved flight">Remove</button>
                        </div>
                    </div>
                </details>
            </li>`;
        })
        .join("");

    container.querySelectorAll("[data-flight-key]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const key = decodeURIComponent(btn.getAttribute("data-flight-key") || "");
            const f = getSavedFlights().find((x) => flightStorageKey(x) === key);
            if (f) {
                removeSavedFlight(f);
                renderSavedList();
            }
        });
    });
}

renderSavedList();
renderSavedPlansList();
