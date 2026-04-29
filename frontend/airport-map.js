function decodeParam(name) {
    const q = new URLSearchParams(window.location.search || "");
    const v = q.get(name);
    return v == null ? "" : String(v);
}

function prettyFrom(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    if (v === "P1") return "P1 Short-Term";
    if (v === "P2") return "P2 Short-Term";
    if (v === "P3") return "P3 Short-Term";
    if (v === "P4") return "P4 Daily Parking";
    if (v === "P6") return "P6 Economy";
    const m = v.match(/^Security-([ABC])$/i);
    if (m) return `Terminal ${m[1].toUpperCase()} security`;
    return v;
}

function prettyToGate(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    return v.toUpperCase();
}

(function initAirportMapDirectionsOverlay() {
    const from = decodeParam("from");
    const to = decodeParam("to");
    const terminal = decodeParam("terminal");

    const overlay = document.getElementById("map-directions-overlay");
    const routeEl = document.getElementById("map-overlay-route");
    const subEl = document.getElementById("map-overlay-sub");
    if (!(overlay instanceof HTMLElement)) return;

    const fromPretty = prettyFrom(from);
    const toGate = prettyToGate(to);

    const hasAny = Boolean(fromPretty || toGate || terminal);
    overlay.classList.toggle("is-hidden", !hasAny);
    overlay.setAttribute("aria-hidden", hasAny ? "false" : "true");

    if (routeEl) {
        const left = fromPretty || "—";
        const right = toGate ? `Gate ${toGate}` : "Gate —";
        routeEl.textContent = `${left} \u2192 ${right}`;
    }

    if (subEl) {
        subEl.textContent =
            "Use the airport map search to start navigation. Automatic routing may not be supported in the embedded map — if needed, open the full map and search your gate.";
    }
})();

