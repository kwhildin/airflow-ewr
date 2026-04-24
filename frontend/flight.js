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

function renderFlightDetails() {
    const params = new URLSearchParams(window.location.search);
    const card = document.getElementById("flight-detail-card");

    const airline = params.get("airline") || "—";
    const flightNumber = params.get("flight_number") || "—";
    const destination = params.get("destination") || "—";
    const sched = params.get("scheduled_departure");
    const departure = formatDateTime(sched);
    const ttd = formatTimeToDeparture(sched);
    const terminal = params.get("terminal_label") || params.get("terminal") || "Unknown terminal";
    const gate = params.get("gate") || "—";
    const status = params.get("status") || "—";
    const wait = params.get("terminal_wait");
    const walk = params.get("walk_time");
    const total = params.get("total_time_to_gate");

    const waitText = wait ? String(wait) : "";
    const hasWait = Boolean(waitText);
    const waitNumber = hasWait ? waitText : "—";
    const waitLabel = hasWait ? "Estimated TSA wait" : "TSA wait unavailable";

    const walkNum = walk ? String(walk) : null;
    const totalNum = total ? String(total) : null;

    const totalSection =
        totalNum && waitText && walkNum
            ? `<div class="total-gate-hero" role="region" aria-label="Total time to gate">
                <p class="total-gate-label">Total time to gate</p>
                <p class="total-gate-value">${escapeHtml(totalNum)}<span>min</span></p>
                <p class="total-gate-breakdown">Security ~${escapeHtml(waitText)} min + walk ~${escapeHtml(walkNum)} min</p>
               </div>`
            : totalNum
              ? `<div class="total-gate-hero" role="region" aria-label="Total time to gate">
                <p class="total-gate-label">Total time to gate</p>
                <p class="total-gate-value">${escapeHtml(totalNum)}<span>min</span></p>
               </div>`
              : "";

    card.innerHTML = `
        <div class="flight-detail-top">
            <div>
                <p class="flight-detail-title"><strong>${escapeHtml(flightNumber)}</strong> <span>${escapeHtml(airline)}</span></p>
                <p class="flight-detail-sub">${escapeHtml(terminal)} · Gate ${escapeHtml(gate)} · Departs ${escapeHtml(departure)}</p>
            </div>
            <div class="flight-detail-pill">${escapeHtml(status)}</div>
        </div>

        <div class="flight-detail-panels">
            <div class="metric card card--padded">
                <p class="metric-label">Total time to gate</p>
                <p class="metric-value">${escapeHtml(totalNum || "—")}<span>min</span></p>
                <p class="metric-sub">${hasWait ? `Security ${escapeHtml(waitText)} min` : "Security —"} · Walk ${walkNum ? `${escapeHtml(walkNum)} min` : "—"}</p>
            </div>
            <div class="metric card card--padded">
                <p class="metric-label">Leave for airport by</p>
                <p class="metric-value">—</p>
                <p class="metric-sub">Placeholder until leave-by planner is connected.</p>
            </div>
        </div>

        <div class="card card--padded">
            <h2 class="section-title">Details</h2>
            <div class="summary-grid">
                <p class="summary-item"><strong>Destination:</strong> ${escapeHtml(destination)}</p>
                <p class="summary-item"><strong>Time to departure:</strong> ${escapeHtml(ttd)}</p>
                <p class="summary-item"><strong>Estimated TSA wait:</strong> ${escapeHtml(waitNumber)} min</p>
                <p class="summary-item"><strong>Estimated walk:</strong> ${escapeHtml(walkNum || "—")} min</p>
            </div>
        </div>
    `;
}

renderFlightDetails();

