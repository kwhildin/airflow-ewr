/* Plan details page: UI only (no flight search changes). */

const PLAN_DETAILS_STORAGE_KEY = "airflow_saved_plans_v1";

function pdGetQuery() {
    return new URLSearchParams(window.location.search);
}

function pdGetFlightFromQuery() {
    const q = pdGetQuery();
    return {
        airline: q.get("airline") || "",
        flight_number: q.get("flight_number") || "",
        destination_airport: q.get("destination_airport") || "",
        destination_city: q.get("destination_city") || "",
        scheduled_departure: q.get("scheduled_departure") || "",
        terminal: q.get("terminal") || "",
        gate: q.get("gate") || "",
        status: q.get("status") || "",
        terminal_wait: q.get("terminal_wait") || "",
    };
}

function pdPlanId(f) {
    return `${f.flight_number || "flight"}|${f.scheduled_departure || ""}`;
}

function pdLoadPlans() {
    try {
        const raw = localStorage.getItem(PLAN_DETAILS_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function pdSavePlans(list) {
    localStorage.setItem(PLAN_DETAILS_STORAGE_KEY, JSON.stringify(list));
}

function pdUpsertPlan(plan) {
    const id = plan.id;
    const list = pdLoadPlans().filter((p) => p?.id !== id);
    list.unshift(plan);
    pdSavePlans(list.slice(0, 25));
}

function pdFindPlan(id) {
    return pdLoadPlans().find((p) => p?.id === id) || null;
}

function pdSetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function pdFmtTime(ms) {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function pdNormalizeTerminalLetter(raw) {
    const t = String(raw || "").trim().toUpperCase();
    if (!t) return "";
    if (t.includes("A")) return "A";
    if (t.includes("B")) return "B";
    if (t.includes("C")) return "C";
    return t;
}

async function pdFetchTerminalWaits() {
    const res = await fetch(`${API_BASE}/api/security/waits?outlook_minutes=0`);
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    return payload.terminals || [];
}

function pdPickTerminalWait(terminals, termLetter) {
    const want = `Terminal ${termLetter}`;
    const hit = (terminals || []).find((t) => String(t.terminal || "") === want);
    return hit ? Number(hit.minutes) : null;
}

function pdComputeLeaveTimes({ depMs, driveMin, securityMin, walkMin, bufferMin }) {
    // Heuristic: boarding starts ~35m pre-departure. Use the user’s buffer to target being at the gate
    // `bufferMin` minutes before boarding starts (default cushion is 15).
    const boardingMs = depMs - 35 * 60000;
    const gateTargetMs = boardingMs - Math.max(0, Number(bufferMin || 0)) * 60000;
    const travelMs = (driveMin + securityMin + walkMin) * 60000;
    const recLeaveMs = gateTargetMs - travelMs;

    return {
        boardingMs,
        gateTargetMs,
        veryMs: recLeaveMs - 15 * 60000,
        recMs: recLeaveMs,
        riskyMs: recLeaveMs + 10 * 60000,
    };
}

function pdComputeAddOnsMinutes({ bags, park }) {
    const bagExtra = bags ? 15 : 0;
    const parkExtra = park ? 12 : 0;
    return bagExtra + parkExtra;
}

async function pdEnsurePlacesAutocomplete(inputEl, onPlace) {
    if (!inputEl) return;
    const statusEl = document.getElementById("pd-ac-status");
    const ok = typeof ensureGoogleMapsPlaces === "function" ? await ensureGoogleMapsPlaces() : false;
    if (!ok || !globalThis.google?.maps) {
        const origin = (() => {
            try {
                return window.location.origin;
            } catch {
                return "";
            }
        })();
        const diag = globalThis.__airflow_maps_diag || null;
        console.warn("Maps JS unavailable. Check API key restrictions / Maps JS enabled.", {
            origin,
            hasGoogle: Boolean(globalThis.google?.maps),
            hasPlaces: Boolean(globalThis.google?.maps?.places),
            diag,
        });
        if (statusEl) {
            const diagLine = diag?.reason ? ` (${diag.reason})` : "";
            statusEl.textContent =
                `Autocomplete unavailable for ${origin || "this site"}${diagLine}. ` +
                `If your key is “unrestricted” and this persists, check DevTools Console for “Google Maps JavaScript API error: …” and verify Maps JavaScript API is enabled for this exact project/key.`;
        }
        return;
    }
    const controlHost = document.getElementById("pd-origin-control");
    if (!controlHost) return;

    // Prefer the new Places Autocomplete widget for new Google projects.
    // It fires `gmp-select` with a PlacePrediction.
    if (globalThis.google?.maps?.places?.PlaceAutocompleteElement) {
        if (statusEl) statusEl.textContent = "";
        controlHost.innerHTML = "";
        const widget = new globalThis.google.maps.places.PlaceAutocompleteElement();
        widget.setAttribute("placeholder", "Start typing your address…");
        controlHost.appendChild(widget);

        // @ts-ignore - event typing differs across builds
        widget.addEventListener("gmp-select", async ({ placePrediction }) => {
            try {
                const place = placePrediction.toPlace();
                await place.fetchFields({ fields: ["formattedAddress"] });
                const pid = String(place.id || "").trim();
                const addr = String(place.formattedAddress || "").trim();
                if (addr) inputEl.value = addr;
                onPlace({ placeId: pid, formatted: addr });
            } catch (e) {
                console.warn("Autocomplete selection failed", e);
            }
        });
        return;
    }

    // Fallback: legacy Autocomplete (may be blocked for new projects).
    if (!globalThis.google?.maps?.places?.Autocomplete) {
        if (statusEl) statusEl.textContent = "Autocomplete unavailable (Places legacy not enabled for this project).";
        return;
    }

    if (statusEl) statusEl.textContent = "";
    const ac = new globalThis.google.maps.places.Autocomplete(inputEl, {
        fields: ["formatted_address", "place_id", "name"],
        componentRestrictions: { country: "us" },
    });
    ac.addListener("place_changed", () => {
        const place = ac.getPlace();
        const pid = (place.place_id || "").trim();
        const addr = (place.formatted_address || place.name || inputEl.value).trim();
        if (addr) inputEl.value = addr;
        onPlace({ placeId: pid, formatted: addr });
    });
}

async function pdDriveEstimate({ placeId, address, departureIso }) {
    const payload = await postPlannerDriveEstimate({
        origin_address: placeId ? (address || null) : (address || null),
        origin_place_id: placeId || null,
        departure_time: departureIso,
    });
    const m = Number(payload.drive_minutes);
    if (!Number.isFinite(m) || m < 1) throw new Error("Invalid drive minutes");
    return Math.round(m);
}

function pdInit() {
    const flight = pdGetFlightFromQuery();
    const id = pdPlanId(flight);

    const flightNo = flight.flight_number || "—";
    const airline = flight.airline || "—";
    const dest = flight.destination_airport || flight.destination_city || "—";
    const term = pdNormalizeTerminalLetter(flight.terminal) || "—";
    const gate = flight.gate || "—";
    const depTime = (() => {
        try {
            return typeof formatTimeOnly === "function" ? formatTimeOnly(flight.scheduled_departure) : (flight.scheduled_departure || "—");
        } catch {
            return flight.scheduled_departure || "—";
        }
    })();

    pdSetText("pd-summary-title", `${flightNo} · ${airline}`);
    pdSetText("pd-summary-route", `EWR → ${dest}`);
    pdSetText("pd-summary-meta", `Departs ${depTime} · Terminal ${term} · Gate ${gate}`);

    const originEl = document.getElementById("pd-origin");
    const driveEl = document.getElementById("pd-drive");
    const driveSourceEl = document.getElementById("pd-drive-source");
    const driveStatusEl = document.getElementById("pd-drive-status");
    const saveBtn = document.getElementById("pd-save-btn");
    const calcBtn = document.getElementById("pd-calc-drive");

    const cushionEl = document.getElementById("pd-cushion");
    const precheckEl = document.getElementById("pd-precheck");
    const bagsEl = document.getElementById("pd-bags");
    const parkEl = document.getElementById("pd-park");

    const securityEl = document.getElementById("pd-security");
    const badgeEl = document.getElementById("pd-reco-badge");
    const supportEl = document.getElementById("pd-support");

    const boardingInlineEl = document.getElementById("pd-boarding-inline");
    const leaveVeryEl = document.getElementById("pd-leave-very");
    const leaveRecEl = document.getElementById("pd-leave-rec");
    const leaveRiskyEl = document.getElementById("pd-leave-risky");

    const tlLeaveEl = document.getElementById("pd-tl-leave");
    const tlAddOnsEl = document.getElementById("pd-tl-addons");
    const tlSecurityEl = document.getElementById("pd-tl-security");
    const tlWalkEl = document.getElementById("pd-tl-walk");
    const tlGateEl = document.getElementById("pd-tl-gate");
    const tlBoardingEl = document.getElementById("pd-tl-boarding");

    const addOnsWrapEl = document.getElementById("pd-addons-wrap");
    const addOnsTitleEl = document.getElementById("pd-addons-title");
    const addOnsSubEl = document.getElementById("pd-addons-sub");
    const addOnsMinEl = document.getElementById("pd-addons-min");

    const depMs = new Date(flight.scheduled_departure).getTime();
    const validDep = !Number.isNaN(depMs);

    const state = {
        id,
        flight,
        origin: { placeId: "", address: "" },
        driveMin: null,
        driveSource: "placeholder",
        waits: [],
        securityBaseMin: null,
    };

    const saved = pdFindPlan(id);
    if (saved) {
        state.origin = saved.origin || state.origin;
        state.driveMin = typeof saved.driveMin === "number" ? saved.driveMin : state.driveMin;
        if (originEl && state.origin.address) originEl.value = state.origin.address;
        if (cushionEl && typeof saved.cushion === "number") cushionEl.value = String(saved.cushion);
        if (precheckEl) precheckEl.checked = Boolean(saved.precheck);
        if (bagsEl) bagsEl.checked = Boolean(saved.bags);
        if (parkEl) parkEl.checked = Boolean(saved.park);
        if (saveBtn) saveBtn.textContent = "Saved";
    }

    function recomputeUi() {
        const cushion = Number(cushionEl?.value || 15);
        const precheck = Boolean(precheckEl?.checked);
        const bags = Boolean(bagsEl?.checked);
        const park = Boolean(parkEl?.checked);

        const walkMin = 12;
        const driveMin = state.driveMin != null ? state.driveMin : 42;
        const gateBufferMin = Math.max(0, Number(cushion || 0));
        const addOnsMin = pdComputeAddOnsMinutes({ bags, park });

        const secBase = state.securityBaseMin != null ? state.securityBaseMin : 18;
        const securityMin = precheck ? Math.max(3, Math.round(secBase * 0.65)) : secBase;

        if (driveEl) driveEl.textContent = state.driveMin != null ? String(state.driveMin) : "—";
        if (driveSourceEl) driveSourceEl.textContent = state.driveMin != null ? "Google Routes" : "";
        if (securityEl) securityEl.textContent = String(securityMin);
        if (addOnsMinEl) addOnsMinEl.textContent = String(addOnsMin);
        if (addOnsWrapEl) {
            const show = addOnsMin > 0;
            addOnsWrapEl.classList.toggle("is-hidden", !show);
            if (addOnsTitleEl) {
                addOnsTitleEl.textContent = bags && park ? "Park + check bag" : (park ? "Park at EWR" : "Check bag");
            }
            if (addOnsSubEl) {
                addOnsSubEl.textContent = bags && park
                    ? "Allow time to park and drop bags"
                    : (park ? "Allow time to park and get to terminal" : "Allow time for bag drop");
            }
        }


        if (!validDep) {
            if (leaveVeryEl) leaveVeryEl.textContent = "—";
            if (leaveRecEl) leaveRecEl.textContent = "—";
            if (leaveRiskyEl) leaveRiskyEl.textContent = "—";
            if (boardingInlineEl) boardingInlineEl.textContent = "";
            if (tlLeaveEl) tlLeaveEl.textContent = "—";
            if (tlAddOnsEl) tlAddOnsEl.textContent = "—";
            if (tlSecurityEl) tlSecurityEl.textContent = "—";
            if (tlWalkEl) tlWalkEl.textContent = "—";
            if (tlGateEl) tlGateEl.textContent = "—";
            if (tlBoardingEl) tlBoardingEl.textContent = "—";
            return;
        }

        const times = pdComputeLeaveTimes({ depMs, driveMin: driveMin + addOnsMin, securityMin, walkMin, bufferMin: gateBufferMin });
        if (boardingInlineEl) boardingInlineEl.innerHTML = `Boarding starts at <strong>${pdFmtTime(times.boardingMs)}</strong>`;

        if (leaveVeryEl) leaveVeryEl.textContent = pdFmtTime(times.veryMs);
        if (leaveRecEl) leaveRecEl.textContent = pdFmtTime(times.recMs);
        if (leaveRiskyEl) leaveRiskyEl.textContent = pdFmtTime(times.riskyMs);

        const leaveMs = times.recMs;
        const arriveMs = leaveMs + driveMin * 60000;
        const addOnsStartMs = arriveMs;
        const securityStartMs = addOnsStartMs + addOnsMin * 60000;
        const walkStartMs = securityStartMs + securityMin * 60000;
        const gateMs = times.gateTargetMs || times.boardingMs;
        const boardingMs = times.boardingMs;

        if (tlLeaveEl) tlLeaveEl.textContent = pdFmtTime(leaveMs);
        if (tlAddOnsEl) tlAddOnsEl.textContent = pdFmtTime(addOnsStartMs);
        if (tlSecurityEl) tlSecurityEl.textContent = pdFmtTime(securityStartMs);
        if (tlWalkEl) tlWalkEl.textContent = pdFmtTime(walkStartMs);
        if (tlGateEl) tlGateEl.textContent = pdFmtTime(gateMs);
        if (tlBoardingEl) tlBoardingEl.textContent = pdFmtTime(boardingMs);
        const hasAddress = Boolean((originEl?.value || "").trim() || state.origin.placeId);
        const hasGoogle = state.driveMin != null;
        if (badgeEl) badgeEl.textContent = hasGoogle ? "Drive time calculated" : (hasAddress ? "Ready to calculate" : "Enter your address to continue");
        if (supportEl) {
            supportEl.textContent = hasGoogle
                ? "Based on Google traffic estimate, security, walk, and buffer."
                : "Enter your address to continue.";
        }
    }

    function setDriveStatus(text) {
        if (driveStatusEl) driveStatusEl.textContent = text || "";
    }

    async function refreshWaits() {
        try {
            state.waits = await pdFetchTerminalWaits();
            const termLetter = pdNormalizeTerminalLetter(flight.terminal);
            const sec = pdPickTerminalWait(state.waits, termLetter);
            if (sec != null) state.securityBaseMin = sec;
            recomputeUi();
        } catch {
            // non-fatal: keep placeholder security
            recomputeUi();
        }
    }

    async function recalcDrive() {
        const addr = (originEl?.value || "").trim();
        if (!addr && !state.origin.placeId) {
            state.driveMin = null;
            setDriveStatus("");
            recomputeUi();
            return;
        }
        if (!validDep) return;

        setDriveStatus("Calculating drive time…");
        try {
            const m = await pdDriveEstimate({
                placeId: state.origin.placeId,
                address: addr,
                departureIso: new Date(Math.max(Date.now() + 120000, depMs - 35 * 60000)).toISOString(),
            });
            state.driveMin = m;
            state.driveSource = "google";
            setDriveStatus("Drive time calculated");
        } catch {
            state.driveMin = null;
            state.driveSource = "placeholder";
            setDriveStatus("Could not calculate drive time. Try a more specific address.");
        }
        recomputeUi();
    }

    if (originEl) {
        originEl.addEventListener("input", () => {
            state.origin.placeId = "";
            state.origin.address = originEl.value.trim();
            setDriveStatus("");
            recomputeUi();
        });
        void pdEnsurePlacesAutocomplete(originEl, ({ placeId, formatted }) => {
            state.origin.placeId = placeId;
            state.origin.address = formatted;
            setDriveStatus("");
            recomputeUi();
        });
    }

    calcBtn?.addEventListener("click", () => {
        void recalcDrive();
    });

    [cushionEl, precheckEl, bagsEl, parkEl].forEach((el) => {
        el?.addEventListener("input", () => recomputeUi());
        el?.addEventListener("change", () => recomputeUi());
    });

    saveBtn?.addEventListener("click", () => {
        const cushion = Number(cushionEl?.value || 15);
        const plan = {
            id,
            savedAt: Date.now(),
            flight,
            origin: { ...state.origin, address: (originEl?.value || "").trim() },
            driveMin: state.driveMin,
            cushion,
            precheck: Boolean(precheckEl?.checked),
            bags: Boolean(bagsEl?.checked),
            park: Boolean(parkEl?.checked),
        };
        pdUpsertPlan(plan);
        if (saveBtn) saveBtn.textContent = "Saved";
    });

    void refreshWaits();
    recomputeUi();
}

document.addEventListener("DOMContentLoaded", () => {
    try {
        pdInit();
    } catch (e) {
        console.error("plan-details init failed", e);
    }
});

