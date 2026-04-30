const JS_VERSION = "214-waits-comparison-ui";
console.log("Loaded waits-sheet.js", JS_VERSION);

const SHEET_ID = "1w4gNnAoM-0SEopHxZLREUj83DpPNAaj0YLwYEwvYVFk";
const SHEET_GID = "0";
const SHEET_URL =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${SHEET_GID}&tqx=responseHandler:handleSheetData`;

let WAIT_ROWS = [];

/* ---------- HELPERS ---------- */

const EXPECTED_HEADERS = [
    "Date",
    "Time",
    "Type",
    "Terminal",
    "Gate",
    "Lane",
    "Wait Time",
    "Status",
    "Source Update Time",
    "Source URL"
];

function cellValue(cell) {
    if (!cell) return "";
    if (cell.f !== undefined && cell.f !== null) return String(cell.f);
    if (cell.v !== undefined && cell.v !== null) return String(cell.v);
    return "";
}

function rowsFromGoogleTable(table) {
    return table.rows
        .map(row => {
            const obj = {};

            EXPECTED_HEADERS.forEach((header, i) => {
                obj[header] = cellValue(row.c[i]).trim();
            });

            return obj;
        })
        .filter(row => {
            // Removes the header row if Google reads it as data
            return row["Date"] !== "Date" && row["Time"] !== "Time";
        });
}

function parseGoogleDateParts(text) {
    const match = String(text).match(/Date\((\d+),(\d+),(\d+),?(\d+)?,?(\d+)?,?(\d+)?\)/);
    if (!match) return null;

    return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4] || 0),
        minute: Number(match[5] || 0),
        second: Number(match[6] || 0)
    };
}

function parseTimeParts(text) {
    if (!text) return { hour: 0, minute: 0, second: 0 };

    const googleTime = parseGoogleDateParts(text);
    if (googleTime) {
        return {
            hour: googleTime.hour,
            minute: googleTime.minute,
            second: googleTime.second
        };
    }

    const timeText = String(text).trim();

    const match = timeText.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return { hour: 0, minute: 0, second: 0 };

    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    const ampm = match[4];

    if (ampm) {
        if (ampm.toUpperCase() === "PM" && hour < 12) hour += 12;
        if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
    }

    return { hour, minute, second };
}

function getDate(row) {
    const dateRaw = row["Date"] || "";
    const timeRaw = row["Time"] || "";

    const googleDate = parseGoogleDateParts(dateRaw);
    const timeParts = parseTimeParts(timeRaw);

    if (googleDate) {
        return new Date(
            googleDate.year,
            googleDate.month,
            googleDate.day,
            timeParts.hour,
            timeParts.minute,
            timeParts.second
        );
    }

    if (dateRaw && timeRaw) {
        const combined = new Date(`${dateRaw} ${timeRaw}`);
        if (!Number.isNaN(combined.getTime())) return combined;
    }

    return null;
}

function getWait(row) {
    const raw = row["Wait Time"] || "";
    const n = Number(String(raw).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function getTerminal(row) {
    return String(row["Terminal"] || "").replace("Terminal", "").trim().toUpperCase();
}

function getGate(row) {
    return String(row["Gate"] || "All Gates").trim();
}

function getLane(row) {
    return String(row["Lane"] || "Unknown Lane").trim();
}

function getType(row) {
    return String(row["Type"] || "Security").trim();
}

function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function displayKey(row) {
    return [
        getType(row).toLowerCase(),
        getTerminal(row),
        getGate(row).toLowerCase(),
        getLane(row).toLowerCase()
    ].join("|");
}

function minuteKey(date) {
    return [
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes()
    ].join("-");
}

function historicalKey(row) {
    const d = getDate(row);
    return [
        d ? minuteKey(d) : "",
        displayKey(row)
    ].join("|");
}

function dedupeHistoricalRows(rows) {
    const map = new Map();

    rows.forEach(row => {
        map.set(historicalKey(row), row);
    });

    return Array.from(map.values());
}

function latestRowsForEachCheckpoint(rows) {
    const map = new Map();

    rows.forEach(row => {
        const key = displayKey(row);
        const rowDate = getDate(row);
        const existing = map.get(key);

        if (!existing) {
            map.set(key, row);
            return;
        }

        const existingDate = getDate(existing);

        if (rowDate && existingDate && rowDate >= existingDate) {
            map.set(key, row);
        }
    });

    return Array.from(map.values());
}

function waitLevel(minutes) {
    if (minutes <= 10) return "Light";
    if (minutes <= 20) return "Moderate";
    return "Busy";
}

function badgeClassForLevel(level) {
    const l = String(level || "").trim().toLowerCase();
    if (l === "light") return "badge--light";
    if (l === "moderate") return "badge--moderate";
    if (l === "busy") return "badge--busy";
    if (l === "heavy") return "badge--heavy";
    return "";
}

/** Dashboard copy: same thresholds as {@link waitLevel}, different labels. */
function waitDisplayLevel(minutes) {
    if (minutes == null || !Number.isFinite(Number(minutes))) return "—";
    const n = Number(minutes);
    if (n <= 10) return "Low";
    if (n <= 20) return "Moderate";
    return "Busy";
}

function waitToneClass(level) {
    const l = String(level || "").trim().toLowerCase();
    if (l === "low") return "wait-tone--low";
    if (l === "moderate") return "wait-tone--moderate";
    if (l === "busy") return "wait-tone--busy";
    return "";
}

function badgeClassForDisplayLevel(level) {
    const l = String(level || "").trim().toLowerCase();
    if (l === "low") return "badge--light";
    if (l === "moderate") return "badge--moderate";
    if (l === "busy") return "badge--busy-waits";
    return "";
}

function hideWaitsSummary() {
    const el = document.getElementById("waits-summary");
    if (!el) return;
    el.innerHTML = "";
    el.classList.add("is-hidden");
}

function showWaitsSummary(html) {
    const el = document.getElementById("waits-summary");
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove("is-hidden");
}

function escapeHTML(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

function sortTerminals(a, b) {
    const order = { A: 1, B: 2, C: 3 };
    return (order[a] || 99) - (order[b] || 99);
}

function sortGates(a, b) {
    if (a === "All Gates") return -1;
    if (b === "All Gates") return 1;
    if (a === "Customs") return 1;
    if (b === "Customs") return -1;

    const aNum = Number(String(a).match(/\d+/)?.[0] || 999);
    const bNum = Number(String(b).match(/\d+/)?.[0] || 999);

    return aNum - bNum;
}

function laneSortRank(row) {
    const lane = getLane(row).toLowerCase();
    if (lane.includes("precheck")) return 1;
    if (lane.includes("clear")) return 2;
    if (lane.includes("regular")) return 3;
    if (lane.includes("us passports")) return 4;
    if (lane.includes("visitors")) return 5;
    return 50;
}

function sortLanes(a, b) {
    const ar = laneSortRank(a);
    const br = laneSortRank(b);
    if (ar !== br) return ar - br;
    return getLane(a).localeCompare(getLane(b));
}

/** Latest row per lane label (case-insensitive) for a terminal, for compact comparison rows. */
function flattenLanesDeduped(terminal, grouped) {
    const gates = grouped[terminal];
    if (!gates) return [];
    const byLane = new Map();
    Object.keys(gates).forEach(gate => {
        gates[gate].forEach(row => {
            const key = getLane(row).toLowerCase();
            const prev = byLane.get(key);
            const d = getDate(row);
            const prevD = prev ? getDate(prev) : null;
            if (!prev || (d && prevD && d >= prevD)) byLane.set(key, row);
        });
    });
    return Array.from(byLane.values()).sort(sortLanes);
}

/* ---------- CURRENT WAIT TIMES ---------- */

function renderCurrentWaits() {
    const grid = document.getElementById("wait-grid");
    if (!grid) return;

    grid.classList.remove("is-loading");
    grid.removeAttribute("aria-busy");

    const usableRows = WAIT_ROWS.filter(row => getWait(row) !== null && getDate(row));

    if (!usableRows.length) {
        hideWaitsSummary();
        grid.innerHTML = `
            <div class="waits-empty-state" role="status">
                <div class="waits-empty-visual" aria-hidden="true">
                    <svg viewBox="0 0 48 48" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="8" y="10" width="32" height="28" rx="3" stroke="currentColor" stroke-width="1.75"/>
                        <path d="M16 18h16M16 24h10M16 30h14" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
                    </svg>
                </div>
                <h2 class="waits-empty-title">No wait times to show</h2>
                <p class="waits-empty-copy">We couldn’t find rows with both a valid timestamp and a numeric wait in the latest sheet pull.</p>
                <p class="waits-empty-hint">Try <strong>Refresh</strong> in a moment, or check that the source sheet still matches the expected columns.</p>
            </div>
        `;
        updateLastUpdated(null);
        return;
    }

    usableRows.sort((a, b) => getDate(a) - getDate(b));

    const newestDate = getDate(usableRows[usableRows.length - 1]);

    const currentRows = latestRowsForEachCheckpoint(usableRows);

    const grouped = {};

    currentRows.forEach(row => {
        const terminal = getTerminal(row) || "Other";
        const gate = getGate(row) || "All Gates";

        if (!grouped[terminal]) grouped[terminal] = {};
        if (!grouped[terminal][gate]) grouped[terminal][gate] = [];

        grouped[terminal][gate].push(row);
    });

    const terminalsSorted = Object.keys(grouped).sort(sortTerminals);
    const summaries = terminalsSorted
        .map(terminal => {
            const gates = grouped[terminal];
            let maxWait = null;
            let latest = null;
            Object.keys(gates).forEach(gate => {
                gates[gate].forEach(row => {
                    const w = getWait(row);
                    const d = getDate(row);
                    if (w != null) maxWait = maxWait == null ? w : Math.max(maxWait, w);
                    if (d && (!latest || d > latest)) latest = d;
                });
            });
            const level = maxWait == null ? "—" : waitDisplayLevel(maxWait);
            return { terminal, maxWait, latest, level };
        })
        .filter(s => s.maxWait != null);

    if (summaries.length) {
        const fastest = summaries.reduce((a, b) => (a.maxWait <= b.maxWait ? a : b));
        const slowest = summaries.reduce((a, b) => (a.maxWait >= b.maxWait ? a : b));
        const avgPeak = Math.round(
            summaries.reduce((acc, s) => acc + s.maxWait, 0) / summaries.length
        );
        const congLevel = waitDisplayLevel(avgPeak);
        const congTone = waitToneClass(congLevel);

        showWaitsSummary(`
            <article class="waits-summary-card" aria-label="Best terminal right now">
                <p class="waits-summary-label">Best right now</p>
                <p class="waits-summary-value">Terminal ${escapeHTML(fastest.terminal)}</p>
                <p class="waits-summary-metric"><strong>${escapeHTML(String(fastest.maxWait))}</strong> min <span class="waits-summary-hint">lowest peak across terminals</span></p>
            </article>
            <article class="waits-summary-card" aria-label="Busiest terminal right now">
                <p class="waits-summary-label">Busiest right now</p>
                <p class="waits-summary-value">Terminal ${escapeHTML(slowest.terminal)}</p>
                <p class="waits-summary-metric"><strong>${escapeHTML(String(slowest.maxWait))}</strong> min <span class="waits-summary-hint">highest peak across terminals</span></p>
            </article>
            <article class="waits-summary-card ${escapeHTML(congTone)}" aria-label="Overall congestion">
                <p class="waits-summary-label">Overall congestion</p>
                <p class="waits-summary-value waits-summary-value--status">${escapeHTML(congLevel)}</p>
                <p class="waits-summary-metric"><span class="waits-summary-hint">From average peak (~${escapeHTML(String(avgPeak))} min) across ${escapeHTML(String(summaries.length))} terminal${summaries.length === 1 ? "" : "s"}</span></p>
            </article>
        `);
    } else {
        hideWaitsSummary();
    }

    const terminalHTML = terminalsSorted
        .map(terminal => {
            const sum = summaries.find(s => s.terminal === terminal);
            const maxWait = sum?.maxWait ?? "—";
            const level = sum?.level ?? "—";
            const latest = sum?.latest;
            const tone = waitToneClass(level);
            const statusBadgeClass = badgeClassForDisplayLevel(level);
            const latestIso = latest ? latest.toISOString() : "";
            const latestTxt = latest
                ? latest.toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      timeZoneName: "short"
                  })
                : "Not available";

            const flatLanes = flattenLanesDeduped(terminal, grouped);
            const laneRowsHtml =
                flatLanes.length > 0
                    ? flatLanes
                          .map(row => {
                              const type = getType(row);
                              const lane = getLane(row);
                              const wait = getWait(row);
                              const laneLevel = waitDisplayLevel(wait);
                              const badgeClass = badgeClassForDisplayLevel(laneLevel);
                              return `
                            <div class="waits-lane-row" role="listitem">
                                <div class="waits-lane-row__left">
                                    <span class="waits-lane-row__lane">${escapeHTML(lane)}</span>
                                    <span class="waits-lane-row__type">${escapeHTML(type)}</span>
                                </div>
                                <div class="waits-lane-row__mid">
                                    <strong class="waits-lane-row__num">${escapeHTML(String(wait))}</strong>
                                    <span class="waits-lane-row__unit">min</span>
                                </div>
                                <div class="waits-lane-row__right">
                                    <span class="badge ${badgeClass}">${escapeHTML(laneLevel)}</span>
                                </div>
                            </div>`;
                          })
                          .join("")
                    : `<p class="waits-term-cmp__empty">No lanes in the latest update for this terminal.</p>`;

            return `
                <article class="waits-term-cmp ${escapeHTML(tone)}" role="listitem">
                    <div class="waits-term-cmp__inner">
                        <header class="waits-term-cmp__head">
                            <div class="waits-term-cmp__head-main">
                                <h2 class="waits-term-cmp__title">Terminal ${escapeHTML(terminal)}</h2>
                                <p class="waits-term-cmp__security">
                                    Security wait:
                                    <strong class="waits-term-cmp__wait-num">${escapeHTML(String(maxWait))}</strong>
                                    <span class="waits-term-cmp__wait-unit">min</span>
                                </p>
                                <p class="waits-term-cmp__updated">
                                    Last updated
                                    <time ${latestIso ? `datetime="${escapeHTML(latestIso)}"` : ""}>${escapeHTML(latestTxt)}</time>
                                </p>
                            </div>
                            <span class="waits-term-cmp__pill badge ${escapeHTML(statusBadgeClass)}">${escapeHTML(level)}</span>
                        </header>
                        <div class="waits-lane-rows" role="list" aria-label="Lanes and checkpoints">
                            ${laneRowsHtml}
                        </div>
                    </div>
                </article>
            `;
        })
        .join("");

    grid.innerHTML = terminalHTML;

    updateLastUpdated(newestDate);
}

function updateLastUpdated(dateToShow) {
    const updated = document.getElementById("last-updated");
    const line = document.getElementById("waits-updated-line");
    if (!updated) return;

    if (!dateToShow) {
        updated.textContent = "No timestamp in viewable rows";
        updated.removeAttribute("datetime");
        line?.classList.add("is-stale");
        return;
    }

    line?.classList.remove("is-stale");
    updated.setAttribute("datetime", dateToShow.toISOString());
    updated.textContent = dateToShow.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
    });
}

/* ---------- PREDICTION ---------- */

function predictWait(event) {
    event.preventDefault();

    const result = document.getElementById("prediction-result");
    if (result) result.innerHTML = "";

    const dateValue = document.getElementById("predict-date").value;
    const timeValue = document.getElementById("predict-time").value;
    const terminalValue = document.getElementById("predict-terminal").value.trim().toUpperCase();
    const laneValue = document.getElementById("predict-lane").value.trim().toLowerCase();
    const gateValue = document.getElementById("predict-gate").value.trim().toLowerCase();

    const targetDate = new Date(`${dateValue}T${timeValue}`);
    const targetDay = targetDate.getDay();
    const targetMinute = minutesOfDay(targetDate);

    let candidates = WAIT_ROWS.filter(row => {
        const rowDate = getDate(row);
        const wait = getWait(row);

        if (!rowDate || wait === null) return false;

        const rowTerminal = getTerminal(row);
        const rowLane = getLane(row).toLowerCase();
        const rowGate = getGate(row).toLowerCase();

        const terminalMatch = !terminalValue || rowTerminal === terminalValue;
        const laneMatch = !laneValue || rowLane.includes(laneValue);
        const gateMatch = !gateValue || rowGate.includes(gateValue);

        return terminalMatch && laneMatch && gateMatch;
    });

    if (!candidates.length && gateValue) {
        candidates = WAIT_ROWS.filter(row => {
            const rowDate = getDate(row);
            const wait = getWait(row);

            if (!rowDate || wait === null) return false;

            const rowTerminal = getTerminal(row);
            const rowLane = getLane(row).toLowerCase();

            const terminalMatch = !terminalValue || rowTerminal === terminalValue;
            const laneMatch = !laneValue || rowLane.includes(laneValue);

            return terminalMatch && laneMatch;
        });
    }

    candidates = dedupeHistoricalRows(candidates);

    if (!result) return;

    if (!candidates.length) {
        result.innerHTML = `<div class="waits-predict-msg waits-predict-msg--error" role="status">
            No historical rows matched those filters yet. Try any terminal or any lane, or widen the date range.
        </div>`;
        return;
    }

    let weightedSum = 0;
    let totalWeight = 0;
    const waits = [];

    candidates.forEach(row => {
        const rowDate = getDate(row);
        const wait = getWait(row);

        const sameDay = rowDate.getDay() === targetDay;
        const timeDiff = Math.abs(minutesOfDay(rowDate) - targetMinute);

        let weight = 1;

        if (sameDay) weight += 4;
        if (timeDiff <= 30) weight += 5;
        else if (timeDiff <= 60) weight += 4;
        else if (timeDiff <= 120) weight += 3;
        else if (timeDiff <= 180) weight += 2;
        else if (timeDiff <= 240) weight += 1;

        weightedSum += wait * weight;
        totalWeight += weight;
        waits.push(wait);
    });

    const estimate = Math.round(weightedSum / totalWeight);
    const min = Math.min(...waits);
    const max = Math.max(...waits);
    const estLevel = waitDisplayLevel(estimate);
    const estTone = waitToneClass(estLevel);
    const estBadge = badgeClassForDisplayLevel(estLevel);

    result.innerHTML = `
        <div class="waits-predict-card ${escapeHTML(estTone)}" role="article">
            <p class="waits-predict-card__kicker">Estimated wait</p>
            <div class="waits-predict-card__row">
                <p class="waits-predict-card__value" aria-label="Estimated minutes">
                    <strong>${escapeHTML(String(estimate))}</strong><span class="waits-predict-card__suffix">min</span>
                </p>
                <span class="badge ${escapeHTML(estBadge)}">${escapeHTML(estLevel)}</span>
            </div>
            <p class="waits-predict-card__note">Based on historical patterns for this terminal and time.</p>
            <p class="waits-predict-card__meta">${escapeHTML(String(candidates.length))} past records · historical range ${escapeHTML(String(min))}–${escapeHTML(String(max))} min</p>
        </div>
    `;
}

/* ---------- WAIT TIMES DATA LOAD ---------- */

function showWaitGridLoading() {
    const grid = document.getElementById("wait-grid");
    if (!grid) return;

    const predHost = document.getElementById("prediction-result");
    if (predHost) predHost.innerHTML = "";

    hideWaitsSummary();
    grid.classList.add("is-loading");
    grid.setAttribute("aria-busy", "true");
    grid.innerHTML = `
        <div class="wait-grid-loading" role="status" aria-live="polite" aria-label="Loading wait times">
            <span class="wait-grid-loading-spinner" aria-hidden="true"></span>
            <span class="wait-grid-loading-copy">Pulling the latest rows from the sheet…</span>
        </div>
    `;
}

function showWaitGridError(detail) {
    const grid = document.getElementById("wait-grid");
    if (!grid) return;

    const predHost = document.getElementById("prediction-result");
    if (predHost) predHost.innerHTML = "";

    hideWaitsSummary();
    grid.classList.remove("is-loading");
    grid.removeAttribute("aria-busy");
    grid.innerHTML = `
        <div class="waits-empty-state waits-empty-state--error" role="alert">
            <div class="waits-empty-visual" aria-hidden="true">
                <svg viewBox="0 0 48 48" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="1.75"/>
                    <path d="M24 14v12M24 32h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </div>
            <h2 class="waits-empty-title">Couldn’t load wait times</h2>
            <p class="waits-empty-copy">${escapeHTML(detail)}</p>
            <p class="waits-empty-hint">Tap <strong>Refresh</strong> to retry.</p>
        </div>
    `;
    updateLastUpdated(null);
}

function loadSheet() {
    showWaitGridLoading();

    const oldScript = document.getElementById("google-sheet-loader");
    if (oldScript) oldScript.remove();

    const script = document.createElement("script");
    script.id = "google-sheet-loader";
    script.src = `${SHEET_URL}&cache=${Date.now()}`;
    script.onerror = () => {
        showWaitGridError("Check your connection and tap Refresh to try again.");
    };

    document.body.appendChild(script);
}

window.handleSheetData = function(response) {
    if (!response || response.status !== "ok") {
        console.error("Google Sheets response error:", response);
        showWaitGridError("Something went wrong while loading. Try Refresh.");
        return;
    }

    WAIT_ROWS = rowsFromGoogleTable(response.table).filter(row => getWait(row) !== null);

    console.log("Loaded rows:", WAIT_ROWS.length);
    console.log("Newest readable date:", WAIT_ROWS.map(getDate).filter(Boolean).sort((a, b) => b - a)[0]);
    console.log("First row:", WAIT_ROWS[0]);

    renderCurrentWaits();
};

document.addEventListener("DOMContentLoaded", () => {
    loadSheet();

    const refreshButton = document.getElementById("refresh-btn");
    if (refreshButton) {
        refreshButton.addEventListener("click", loadSheet);
    }

    const predictForm = document.getElementById("predict-form");
    if (predictForm) {
        predictForm.addEventListener("submit", predictWait);
    }
});
