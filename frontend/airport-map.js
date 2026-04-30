/**
 * Newark embedded map — reads `from`, `to`, `terminal` query params and builds optional `s=` search state.
 * Does not access iframe DOM.
 */

const NEWARK_MAP_BASE = "https://maps.newarkairport.com/";
const DEFAULT_IFRAME_SRC = `${NEWARK_MAP_BASE}?lang=en`;

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

function normalizeGateSearchTerm(raw) {
    let v = String(raw || "").trim();
    if (!v) return "";
    v = v.replace(/^gate\s+/i, "").replace(/\s+/g, "").toUpperCase();
    if (/^[A-Z]\d{1,3}[A-Z]?$/.test(v)) return v;
    return "";
}

function normalizeParkingSearchTerm(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    const u = v.toUpperCase().replace(/\s+/g, "");
    if (/^P[1-6]$/.test(u)) return u;
    const m = v.match(/^Security-([ABC])$/i);
    if (m) return `Terminal ${m[1].toUpperCase()}`;
    return "";
}

function terminalSearchTerm(raw) {
    const t = String(raw || "")
        .trim()
        .toUpperCase();
    if (/^[ABC]$/.test(t)) return `Terminal ${t}`;
    return "";
}

function newarkMapStateForSearch(searchQuery) {
    const q = String(searchQuery || "").trim();
    if (!q) return null;
    return {
        "online/headerOnline": {
            id: "online/headerOnline",
            search: q,
            isSearchConfirmed: true,
        },
        "online/poiView": { id: "online/poiView" },
        "online/getDirectionsFromTo": { id: "online/getDirectionsFromTo" },
        venueDataLoader: { id: "venueDataLoader" },
        mapRenderer: {
            id: "mapRenderer",
            vp: {
                lat: 40.69245628216487,
                lng: -74.18168050000003,
                zoom: 14.393253170344416,
                bearing: 0,
                pitch: 0,
            },
            ord: 4,
        },
    };
}

function encodeNewarkMapState(state) {
    const json = JSON.stringify(state);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildEmbeddedSrcWithSearch(searchQuery) {
    const state = newarkMapStateForSearch(searchQuery);
    if (!state) return DEFAULT_IFRAME_SRC;
    const s = encodeNewarkMapState(state);
    return `${NEWARK_MAP_BASE}?lang=en&s=${encodeURIComponent(s)}`;
}

function pickPrimaryIframeSearch(from, to, terminal) {
    const gate = normalizeGateSearchTerm(to);
    if (gate) return gate;
    const park = normalizeParkingSearchTerm(from);
    if (park) return park;
    const t = terminalSearchTerm(terminal);
    if (t) return t;
    return "";
}

function syncFullMapLink(iframe, anchor) {
    if (!(iframe instanceof HTMLIFrameElement) || !(anchor instanceof HTMLAnchorElement)) return;
    try {
        const u = iframe.src || "";
        if (u) anchor.href = u;
    } catch {
        /* ignore */
    }
}

function setToolActive(btns, mode) {
    btns.forEach(({ el, key }) => {
        if (!(el instanceof HTMLElement)) return;
        el.classList.toggle("is-active", key === mode);
    });
}

(function initAirportMapPage() {
    const qAll = new URLSearchParams(window.location.search || "");
    const planReturnRaw = qAll.get("plan_return") || "";

    const from = decodeParam("from");
    const to = decodeParam("to");
    const terminal = decodeParam("terminal");

    const backToPlanEl = document.getElementById("am-back-to-plan");
    if (backToPlanEl instanceof HTMLAnchorElement) {
        if (planReturnRaw.trim()) {
            backToPlanEl.href = `plan-details.html?${planReturnRaw}`;
            backToPlanEl.removeAttribute("hidden");
            backToPlanEl.setAttribute("aria-hidden", "false");
        } else {
            backToPlanEl.setAttribute("hidden", "");
            backToPlanEl.setAttribute("aria-hidden", "true");
        }
    }

    const subtitleEl = document.getElementById("am-route-subtitle");
    const statusEl = document.getElementById("am-status-pill");
    const helperEl = document.getElementById("am-helper");
    const chipFromEl = document.getElementById("am-chip-from");
    const chipToEl = document.getElementById("am-chip-to");
    const chipTermEl = document.getElementById("am-chip-terminal");
    const bottomRouteEl = document.getElementById("am-bottom-route");
    const routePanel = document.getElementById("am-route-panel");
    const iframe = document.getElementById("ewr-map-iframe");
    const openFullEl = document.querySelector(".am-open-full-map");
    const quickWrap = document.getElementById("map-quick-actions");
    const btnGate = document.getElementById("map-btn-search-gate");
    const btnPark = document.getElementById("map-btn-search-parking");
    const btnTerminal = document.getElementById("map-btn-show-terminal");

    const fromPretty = prettyFrom(from);
    const toGate = prettyToGate(to);
    const gateSearch = normalizeGateSearchTerm(to);
    const parkSearch = normalizeParkingSearchTerm(from);
    const terminalSearch = terminalSearchTerm(terminal);

    const hasAny = Boolean(fromPretty || toGate || terminal);

    const leftLabel = fromPretty || "EWR";
    const gateLabel = toGate ? `Gate ${toGate}` : "Gate —";
    const routeLine = `${leftLabel} → ${gateLabel}`;

    if (bottomRouteEl) bottomRouteEl.textContent = hasAny ? routeLine : "Newark (EWR)";
    if (chipFromEl) chipFromEl.textContent = fromPretty || "—";
    if (chipToEl) chipToEl.textContent = gateLabel;
    if (chipTermEl) {
        const tl = String(terminal || "")
            .trim()
            .toUpperCase();
        chipTermEl.textContent = /^[ABC]$/.test(tl) ? `Terminal ${tl}` : "Terminal —";
    }

    if (helperEl) {
        helperEl.textContent = "Select the result in the map, then tap Get directions.";
    }

    routePanel?.classList.toggle("am-route-panel--empty", !hasAny);

    const primary = pickPrimaryIframeSearch(from, to, terminal);

    if (subtitleEl) {
        subtitleEl.textContent = hasAny ? routeLine : "Your indoor airport route is ready";
    }

    if (statusEl) {
        if (hasAny && primary) {
            statusEl.textContent = "Search loaded";
            statusEl.classList.remove("am-status-pill--accent");
        } else if (hasAny) {
            statusEl.textContent = "Ready";
            statusEl.classList.add("am-status-pill--accent");
        } else {
            statusEl.textContent = "Explore map";
            statusEl.classList.add("am-status-pill--accent");
        }
    }

    if (iframe instanceof HTMLIFrameElement && primary) {
        iframe.src = buildEmbeddedSrcWithSearch(primary);
    }
    syncFullMapLink(iframe, openFullEl);

    let activeMode = "gate";
    if (gateSearch && primary === gateSearch) activeMode = "gate";
    else if (parkSearch && primary === parkSearch) activeMode = "parking";
    else if (terminalSearch && primary === terminalSearch) activeMode = "terminal";
    else if (parkSearch) activeMode = "parking";
    else if (terminalSearch) activeMode = "terminal";
    else if (gateSearch) activeMode = "gate";

    const toolBtns = [
        { el: btnGate, key: "gate" },
        { el: btnPark, key: "parking" },
        { el: btnTerminal, key: "terminal" },
    ];

    function applySearch(query, mode) {
        if (!(iframe instanceof HTMLIFrameElement) || !query) return;
        iframe.src = buildEmbeddedSrcWithSearch(query);
        syncFullMapLink(iframe, openFullEl);
        activeMode = mode;
        setToolActive(toolBtns, mode);
    }

    if (quickWrap instanceof HTMLElement) {
        quickWrap.classList.toggle("is-hidden", !hasAny);
    }

    if (btnGate instanceof HTMLButtonElement) {
        btnGate.disabled = !gateSearch;
        btnGate.addEventListener("click", () => {
            if (!gateSearch) return;
            applySearch(gateSearch, "gate");
        });
    }
    if (btnPark instanceof HTMLButtonElement) {
        btnPark.disabled = !parkSearch;
        btnPark.addEventListener("click", () => {
            if (!parkSearch) return;
            applySearch(parkSearch, "parking");
        });
    }
    if (btnTerminal instanceof HTMLButtonElement) {
        btnTerminal.disabled = !terminalSearch;
        btnTerminal.addEventListener("click", () => {
            if (!terminalSearch) return;
            applySearch(terminalSearch, "terminal");
        });
    }

    setToolActive(toolBtns, activeMode);
})();
