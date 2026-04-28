const SHEET_ID = "1w4gNnAoM-0SEopHxZLREUj83DpPNAaj0YLwYEwvYVFk";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;

let WAIT_ROWS = [];

function parseCSV(text) {
    const lines = text.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.replaceAll('"', "").trim());

    return lines.slice(1).map(line => {
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        headers.forEach((header, i) => {
            row[header] = (values[i] || "").replaceAll('"', "").trim();
        });
        return row;
    });
}

function getWait(row) {
    return Number(row["Wait Time (minute)"] || row["Wait Time"] || 0);
}

function getDate(row) {
    const dateText = row["Timestamp"] || row["Date"] || row["Source Update"] || "";
    const d = new Date(dateText);
    return isNaN(d) ? null : d;
}

function getMinutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function waitLevel(minutes) {
    if (minutes <= 10) return "Light";
    if (minutes <= 20) return "Moderate";
    return "Busy";
}

function renderCurrentWaits() {
    const grid = document.getElementById("wait-grid");

    if (!WAIT_ROWS.length) {
        grid.innerHTML = "<p>No wait time data found.</p>";
        return;
    }

    const latestRows = WAIT_ROWS.slice(-10);

    grid.innerHTML = latestRows.map(row => {
        const type = row["Type"] || "Security";
        const terminal = row["Terminal"] || "—";
        const gate = row["Gate"] || "All Gates";
        const lane = row["Lane"] || "—";
        const wait = getWait(row);
        const level = waitLevel(wait);

        return `
            <article class="wait-row" role="listitem">
                <div>
                    <p class="wait-row-terminal">Terminal ${terminal}</p>
                    <p class="wait-row-name">${type} • ${gate}</p>
                </div>

                <div>
                    <p class="wait-row-minutes">${wait}<span>min</span></p>
                    <p class="wait-row-lanes">${lane}</p>
                </div>

                <div class="wait-row-right">
                    <span class="badge">${level}</span>
                </div>
            </article>
        `;
    }).join("");

    const waits = latestRows.map(getWait);
    const fastest = latestRows.reduce((a, b) => getWait(a) < getWait(b) ? a : b);
    const slowest = latestRows.reduce((a, b) => getWait(a) > getWait(b) ? a : b);
    const avg = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);

    document.getElementById("summary-fastest").textContent =
        `Terminal ${fastest["Terminal"]}, ${fastest["Gate"]}: ${getWait(fastest)} min`;

    document.getElementById("summary-slowest").textContent =
        `Terminal ${slowest["Terminal"]}, ${slowest["Gate"]}: ${getWait(slowest)} min`;

    document.getElementById("summary-congestion").textContent = waitLevel(avg);

    document.getElementById("last-updated").textContent = new Date().toLocaleString();
}

function predictWait(event) {
    event.preventDefault();

    const date = document.getElementById("predict-date").value;
    const time = document.getElementById("predict-time").value;
    const terminal = document.getElementById("predict-terminal").value;
    const lane = document.getElementById("predict-lane").value.toLowerCase();
    const gate = document.getElementById("predict-gate").value.toLowerCase();

    const targetDate = new Date(`${date}T${time}`);
    const targetDay = targetDate.getDay();
    const targetMinutes = getMinutesOfDay(targetDate);

    let matches = WAIT_ROWS.filter(row => {
        const rowDate = getDate(row);
        if (!rowDate) return false;

        const sameDay = rowDate.getDay() === targetDay;
        const closeTime = Math.abs(getMinutesOfDay(rowDate) - targetMinutes) <= 60;

        const terminalMatch = !terminal || row["Terminal"] === terminal;
        const laneMatch = !lane || (row["Lane"] || "").toLowerCase().includes(lane);
        const gateMatch = !gate || (row["Gate"] || "").toLowerCase().includes(gate);

        return sameDay && closeTime && terminalMatch && laneMatch && gateMatch;
    });

    if (!matches.length && gate) {
        matches = WAIT_ROWS.filter(row => {
            const rowDate = getDate(row);
            if (!rowDate) return false;

            const sameDay = rowDate.getDay() === targetDay;
            const closeTime = Math.abs(getMinutesOfDay(rowDate) - targetMinutes) <= 60;
            const terminalMatch = !terminal || row["Terminal"] === terminal;
            const laneMatch = !lane || (row["Lane"] || "").toLowerCase().includes(lane);

            return sameDay && closeTime && terminalMatch && laneMatch;
        });
    }

    const result = document.getElementById("prediction-result");

    if (!matches.length) {
        result.textContent = "Not enough matching data yet. Try removing the gate or lane filter.";
        return;
    }

    const waits = matches.map(getWait);
    const average = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
    const min = Math.min(...waits);
    const max = Math.max(...waits);

    result.textContent = `Estimated wait: ${average} min. Based on ${matches.length} similar past records. Range: ${min}-${max} min.`;
}

async function loadSheet() {
    const response = await fetch(SHEET_URL);
    const text = await response.text();

    WAIT_ROWS = parseCSV(text).filter(row => getWait(row) >= 0);

    renderCurrentWaits();
}

document.addEventListener("DOMContentLoaded", () => {
    loadSheet();

    document.getElementById("refresh-btn").addEventListener("click", loadSheet);
    document.getElementById("predict-form").addEventListener("submit", predictWait);
});
