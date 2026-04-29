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
        <div class="saved-plan-timeline" role="list" aria-label="Saved plan timeline">
            <div class="saved-plan-step" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-title">Leave</p>
                    <p class="saved-plan-step-sub">${escapeHtml(driveSub)}</p>
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(leaveMs))}</p>
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
                    <p class="saved-plan-step-title">${escapeHtml(addOnsTitle)}</p>
                    <p class="saved-plan-step-sub">${escapeHtml(addOnsSub)}</p>
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(addOnsStartMs))}</p>
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
                    <p class="saved-plan-step-title">Security</p>
                    <p class="saved-plan-step-sub">${escapeHtml(secSub)}</p>
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(securityStartMs))}</p>
                    <p class="saved-plan-step-meta"><strong>${escapeHtml(String(securityMin))}</strong><span>min</span></p>
                </div>
            </div>

            <div class="saved-plan-step" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-title">Walk</p>
                    <p class="saved-plan-step-sub">To gate</p>
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(walkStartMs))}</p>
                    <p class="saved-plan-step-meta"><strong>${escapeHtml(String(walkMin))}</strong><span>min</span></p>
                </div>
            </div>

            <div class="saved-plan-step saved-plan-step--gate" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-title">At gate</p>
                    <p class="saved-plan-step-sub">&nbsp;</p>
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(gateMs))}</p>
                </div>
            </div>

            <div class="saved-plan-step saved-plan-step--boarding" role="listitem">
                <div class="saved-plan-step-top">
                    <span class="saved-plan-dot" aria-hidden="true"></span>
                </div>
                <div class="saved-plan-step-body">
                    <p class="saved-plan-step-title">Boarding</p>
                    <p class="saved-plan-step-sub">Starts</p>
                    <p class="saved-plan-step-time">${escapeHtml(formatTimeOnly(boardingMs))}</p>
                    <p class="saved-plan-step-meta saved-plan-step-meta--muted"><span>starts</span></p>
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

function renderSavedPlansList() {
    const container = document.getElementById("saved-plans-list");
    const countEl = document.getElementById("saved-plans-count");
    if (!container) return;

    const plans = getSavedPlans();
    if (countEl) countEl.textContent = `${plans.length}`;

    if (!plans.length) {
        container.innerHTML =
            `<li class="saved-empty" style="list-style:none;">
                <div class="saved-empty-inner">
                    <p class="saved-empty-title">No saved plans yet</p>
                    <p class="saved-empty-copy">Pick a flight on Plan My Trip, then Save this plan to keep it here.</p>
                    <a class="btn btn-primary" href="plan.html">Plan My Trip</a>
                </div>
             </li>`;
        return;
    }

    container.innerHTML = plans
        .map((p) => {
            const f = p.flight || {};
            const dest = f.destination_airport || f.destination_city || "—";
            const flightNo = f.flight_number || "—";
            const airline = f.airline || "—";
            const departs = formatDateTime(f.scheduled_departure);
            const planUrl = buildPlanDetailsUrlFromPlan(p);
            const id = encodeURIComponent(p.id || "");
            const planPayload = encodeURIComponent(JSON.stringify(p));

            return `
            <li class="flight-result-item-wrap">
                <details class="saved-card" data-saved-plan="${planPayload}">
                    <summary class="saved-card-summary">
                        <div class="saved-card-left">
                            <p class="saved-flight">${escapeHtml(flightNo)}</p>
                            <p class="saved-dest">${escapeHtml(dest)}</p>
                            <p class="saved-meta">${escapeHtml(airline)} · Departs ${escapeHtml(departs)}</p>
                        </div>
                        <div class="saved-card-right">
                            <span class="saved-primary"><strong>Saved plan</strong></span>
                            <span class="saved-status">Plan</span>
                        </div>
                    </summary>
                    <div class="saved-card-body saved-card-body--plan">
                        <div data-saved-plan-timeline></div>
                        <div class="saved-plan-actions">
                            <a class="btn btn-primary" href="${planUrl.replace(/"/g, "&quot;")}">Edit plan</a>
                            <button type="button" class="btn btn-ghost" data-plan-id="${id}" aria-label="Remove saved plan" title="Remove saved plan">Remove plan</button>
                        </div>
                    </div>
                </details>
            </li>`;
        })
        .join("");

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
            `<li class="saved-empty" style="list-style:none;">
                <div class="saved-empty-inner">
                    <p class="saved-empty-title">No saved flights yet</p>
                    <p class="saved-empty-copy">Go to Plan My Trip, search for a flight, and tap Save to keep it here.</p>
                    <a class="btn btn-primary" href="plan.html">Plan My Trip</a>
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
