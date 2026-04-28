const JS_VERSION = "204-latest-each-gate";
console.log("Loaded waits-sheet.js", JS_VERSION);

const SHEET_ID = "1w4gNnAoM-0SEopHxZLREUj83DpPNAaj0YLwYEwvYVFk";
const SHEET_GID = "0";
const SHEET_URL =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${SHEET_GID}&tqx=responseHandler:handleSheetData`;

let WAIT_ROWS = [];

/* ---------- HELPERS ---------- */

function cellValue(cell, header) {
    if (!cell) return "";

    const isDateColumn = ["Date Time", "Timestamp", "Date", "Source Update Time"].includes(header);

    if (isDateColumn && cell.v !== undefined && cell.v !== null) return String(cell.v);
    if (cell.f !== undefined && cell.f !== null) return String(cell.f);
    if (cell.v !== undefined && cell.v !== null) return String(cell.v);

    return "";
}

function rowsFromGoogleTable(table) {
    const headers = table.cols.map(col => col.label || col.id);

    return table.rows.map(row => {
        const obj = {};
        headers.forEach((header, i) => {
            obj[header] = cellValue(row.c[i], header).trim();
        });
        return obj;
    });
}

function getWait(row) {
    const raw = row["Wait Time (minute)"] || row["Wait Time"] || "";
    const n = Number(String(raw).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function getDate(row) {
    const raw =
        row["Date Time"] ||
        row["Timestamp"] ||
        row["Source Update Time"] ||
        row["Date"] ||
        "";

    if (!raw) return null;

    const text = String(raw).trim();

    const googleDate = text.match(/Date\((\d+),(\d+),(\d+),?(\d+)?,?(\d+)?,?(\d+)?\)/);
    if (googleDate) {
        const year = Number(googleDate[1]);
        const month = Number(googleDate[2]);
        const day = Number(googleDate[3]);
        const hour = Number(googleDate[4] || 0);
        const minute = Number(googleDate[5] || 0);
        const second = Number(googleDate[6] || 0);
        return new Date(year, month, day, hour, minute, second);
    }

    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
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

function minuteKey(date) {
    return [
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes()
    ].join("-");
}

function displayKey(row) {
    return [
        getType(row).toLowerCase(),
        getTerminal(row),
        getGate(row).toLowerCase(),
        getLane(row).toLowerCase()
    ].join("|");
}

function waitLevel(minutes) {
    if (minutes <= 10) return "Light";
    if (minutes <= 20) return "Moderate";
    return "Busy";
}

function escapeHTML(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
}

function dedupeRows(rows) {
    const map = new Map();

    rows.forEach(row => {
        const date = getDate(row);

        const key = [
            date ? minuteKey(date) : "",
            displayKey(row)
        ].join("|");

        map.set(key, row);
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

        if (rowDate && existingDate && rowDate > existingDate) {
            map.set(key, row);
        }
    });

    return Array.from(map.values());
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

function sortLanes(a, b) {
    const laneOrder = {
        precheck: 1,
        regular: 2,
        "us passports": 3,
        visitors: 4
    };

    const aLane = getLane(a).toLowerCase();
    const bLane = getLane(b).toLowerCase();

    const aScore = Object.keys(laneOrder).find(k => aLane.includes(k));
    const bScore = Object.keys(laneOrder).find(k => bLane.includes(k));

    return (laneOrder[aScore] || 99) - (laneOrder[bScore] || 99);
}

/* ---------- CURRENT WAIT TIMES ---------- */

function renderCurrentWaits() {
    const grid = document.getElementById("wait-grid");
    if (!grid) return;

    const usableRows = WAIT_ROWS.filter(row => getWait(row) !== null && getDate(row));

    if (!usableRows.length) {
        grid.innerHTML = `
            <article class="wait-row">
                <div>
                    <p class="wait-row-terminal">No usable wait-time rows found</p>
                    <p class="wait-row-name">The sheet loaded, but the data could not be read.</p>
                </div>
            </article>
        `;
        return;
    }

    usableRows.sort((a, b) => getDate(a) - getDate(b));

    const newestDate = getDate(usableRows[usableRows.length - 1]);

    let currentRows = latestRowsForEachCheckpoint(usableRows);
    currentRows = dedupeRows(currentRows);

    const grouped = {};

    currentRows.forEach(row => {
        const terminal = getTerminal(row) || "Other";
        const gate = getGate(row) || "All Gates";

        if (!grouped[terminal]) grouped[terminal] = {};
        if (!grouped[terminal][gate]) grouped[terminal][gate] = [];

        grouped[terminal][gate].push(row);
    });

    const terminalHTML = Object.keys(grouped)
        .sort(sortTerminals)
        .map(terminal => {
            const gates = grouped[terminal];

            const gateHTML = Object.keys(gates)
                .sort(sortGates)
                .map(gate => {
                    const rows = gates[gate].sort(sortLanes);

                    const laneHTML = rows.map(row => {
                        const type = getType(row);
                        const lane = getLane(row);
                        const wait = getWait(row);
                        const level = waitLevel(wait);

                        return `
                            <article class="wait-row" role="listitem" style="margin-top: 10px;">
                                <div>
                                    <p class="wait-row-terminal">${escapeHTML(lane)}</p>
                                    <p class="wait-row-name">${escapeHTML(type)}</p>
                                </div>

                                <div>
                                    <p class="wait-row-minutes">${escapeHTML(wait)}<span>min</span></p>
                                    <p class="wait-row-lanes">${escapeHTML(level)} wait</p>
                                </div>

                                <div class="wait-row-right">
                                    <span class="badge">${escapeHTML(level)}</span>
                                </div>
                            </article>
                        `;
                    }).join("");

                    return `
                        <div style="margin-top: 18px;">
                            <p style="
                                font-size: 18px;
                                font-weight: 700;
                                color: #64748b;
                                margin: 0 0 8px 0;
                            ">
                                Gate / Checkpoint: ${escapeHTML(gate)}
                            </p>
                            ${laneHTML}
                        </div>
                    `;
                }).join("");

            return `
                <section style="
                    background: rgba(255,255,255,0.78);
                    border: 1px solid rgba(148,163,184,0.25);
                    border-radius: 28px;
                    padding: 24px;
                    margin-bottom: 26px;
                    box-shadow: 0 12px 28px rgba(15,23,42,0.06);
                ">
                    <h2 style="
                        font-size: 34px;
                        line-height: 1.1;
                        margin: 0 0 18px 0;
                        color: #0f172a;
                    ">
                        Terminal ${escapeHTML(terminal)}
                    </h2>
                    ${gateHTML}
                </section>
            `;
        }).join("");

    grid.innerHTML = terminalHTML;

    updateSummary(currentRows, newestDate);
}

function updateSummary(rows, newestDate) {
    if (!rows.length) return;

    const fastest = rows.reduce((a, b) => getWait(a) <= getWait(b) ? a : b);
    const slowest = rows.reduce((a, b) => getWait(a) >= getWait(b) ? a : b);

    const waits = rows.map(getWait).filter(n => n !== null);
    const avg = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);

    document.getElementById("summary-fastest").textContent =
        `Terminal ${getTerminal(fastest)}, ${getGate(fastest)}: ${getWait(fastest)} min`;

    document.getElementById("summary-slowest").textContent =
        `Terminal ${getTerminal(slowest)}, ${getGate(slowest)}: ${getWait(slowest)} min`;

    document.getElementById("summary-congestion").textContent = waitLevel(avg);

    const updated = document.getElementById("last-updated");
    if (updated) {
        updated.textContent = newestDate.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short"
        });
    }
}

/* ---------- PREDICTION ---------- */

function predictWait(event) {
    event.preventDefault();

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

    candidates = dedupeRows(candidates);

    const result = document.getElementById("prediction-result");

    if (!candidates.length) {
        result.textContent = "No historical records found for that terminal/lane yet. Try Any Terminal or Any Lane.";
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

    result.textContent =
        `Estimated wait: ${estimate} min. Based on ${candidates.length} past records. Historical range: ${min}-${max} min.`;
}

/* ---------- GOOGLE SHEET LOAD ---------- */

function showSheetError(message) {
    const grid = document.getElementById("wait-grid");
    if (!grid) return;

    grid.innerHTML = `
        <article class="wait-row">
            <div>
                <p class="wait-row-terminal">Could not load Google Sheet data</p>
                <p class="wait-row-name">${escapeHTML(message)}</p>
            </div>
        </article>
    `;
}

function loadSheet() {
    showSheetError("Loading wait-time data...");

    const oldScript = document.getElementById("google-sheet-loader");
    if (oldScript) oldScript.remove();

    const script = document.createElement("script");
    script.id = "google-sheet-loader";
    script.src = `${SHEET_URL}&cache=${Date.now()}`;
    script.onerror = () => {
        showSheetError("The Google Sheet script could not load.");
    };

    document.body.appendChild(script);
}

window.handleSheetData = function(response) {
    if (!response || response.status !== "ok") {
        console.error("Google Sheets response error:", response);
        showSheetError("Google returned an error while loading the sheet.");
        return;
    }

    WAIT_ROWS = rowsFromGoogleTable(response.table).filter(row => getWait(row) !== null);
    WAIT_ROWS = dedupeRows(WAIT_ROWS);

    console.log("Loaded rows:", WAIT_ROWS.length);
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
