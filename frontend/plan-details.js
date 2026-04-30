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

/** Minutes at gate before boarding for the "Recommended" tier; other tiers shift leave time around this anchor. */
const PD_BASE_GATE_BUFFER_MIN = 15;

function pdComputeLeaveTimes({ depMs, driveMin, securityMin, walkMin, bufferMin }) {
    // Heuristic: boarding starts ~35m pre-departure. Target being at the gate `bufferMin` minutes before boarding.
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

function pdMinsAtGateBeforeBoarding(boardingMs, leaveMs, driveMin, addOnsMin, securityMin, walkMin) {
    const gateArriveMs = leaveMs + (driveMin + addOnsMin + securityMin + walkMin) * 60000;
    return (boardingMs - gateArriveMs) / 60000;
}

function pdFmtGateBeforeBoardingLine(mins) {
    const m = Math.round(Number(mins));
    if (!Number.isFinite(m)) return "\u2014";
    if (m >= 2) return `~${m} min before boarding`;
    if (m === 1) return "~1 min before boarding";
    if (m === 0) return "At boarding time";
    const abs = Math.abs(m);
    if (abs === 1) return "~1 min after boarding";
    return `~${abs} min after boarding`;
}

const PD_LEAVE_GATE_NOTE_IDS = [
    ["very_safe", "pd-leave-very-safe-gate"],
    ["safe", "pd-leave-safe-gate"],
    ["rec", "pd-leave-rec-gate"],
    ["tight", "pd-leave-tight-gate"],
    ["very_tight", "pd-leave-very-tight-gate"],
];

function pdClearLeaveGateNotes() {
    for (const [, id] of PD_LEAVE_GATE_NOTE_IDS) {
        const el = document.getElementById(id);
        if (el) el.textContent = "\u2014";
    }
}

function pdComputeAddOnsMinutes({ bags, park, parking_lot_id }) {
    const bagExtra = bags ? 15 : 0;
    const lotExtraById = {
        p1_short_term_a: 6,
        p2_short_term_b: 6,
        p3_short_term_c: 6,
        p4_daily: 12,
        p6_economy: 18,
    };
    const parkExtra = park ? (lotExtraById[String(parking_lot_id || "")] ?? 12) : 0;
    return bagExtra + parkExtra;
}

function pdDriveCalculatedLabel(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 1) return "Calculated Drive Time: — mins";
    return `Calculated Drive Time: ${Math.round(m)} mins`;
}

function pdLeaveChoiceFromEl(el) {
    if (!(el instanceof Element)) return null;
    if (el.querySelector("#pd-leave-very")) return "very";
    if (el.querySelector("#pd-leave-rec")) return "rec";
    if (el.querySelector("#pd-leave-risky")) return "risky";
    return null;
}

function pdParkingLotName(id) {
    const map = {
        p1_short_term_a: "P1 Short-Term (Terminal A)",
        p2_short_term_b: "P2 Short-Term (Terminal B)",
        p3_short_term_c: "P3 Short-Term (Terminal C)",
        p4_daily: "P4 Daily Parking Garage",
        p6_economy: "P6 Economy Lot",
    };
    return map[String(id || "")] || "Parking lot";
}

function pdSecurityLineLabel(precheck, hasClear) {
    if (precheck) return "TSA PreCheck";
    if (hasClear) return "CLEAR";
    return "Regular security";
}

function pdParkingLotShortCode(id) {
    const raw = String(id || "");
    if (raw.startsWith("p1_")) return "P1";
    if (raw.startsWith("p2_")) return "P2";
    if (raw.startsWith("p3_")) return "P3";
    if (raw.startsWith("p4_")) return "P4";
    if (raw.startsWith("p6_")) return "P6";
    return "P4";
}

/** Routes API / Maps destination keys — must stay aligned with backend `DESTINATION_BY_KEY`. */
function pdDriveDestinationKeyFromPlan(flight, park, parkingLotId) {
    if (park && String(parkingLotId || "").trim()) {
        return String(parkingLotId).trim();
    }
    const letter = pdNormalizeTerminalLetter(flight.terminal);
    if (letter === "A") return "terminal_a";
    if (letter === "B") return "terminal_b";
    if (letter === "C") return "terminal_c";
    return "ewr";
}

const PD_MAPS_DESTINATION_QUERY = {
    ewr: "Newark Liberty International Airport (EWR), Newark, NJ",
    p1_short_term_a: "P1 Short-Term Parking, Newark Liberty International Airport, Newark, NJ",
    p2_short_term_b: "P2 Short-Term Parking, Newark Liberty International Airport, Newark, NJ",
    p3_short_term_c: "P3 Short-Term Parking, Newark Liberty International Airport, Newark, NJ",
    p4_daily: "P4 Daily Parking Garage, Newark Liberty International Airport, Newark, NJ",
    p6_economy: "P6 Economy Parking, Newark Liberty International Airport, Newark, NJ",
    terminal_a: "Newark Airport Terminal A, Newark, NJ",
    terminal_b: "Newark Airport Terminal B, Newark, NJ",
    terminal_c: "Newark Airport Terminal C, Newark, NJ",
};

function pdMapsDestinationQuery(destinationKey) {
    const k = String(destinationKey || "ewr").trim().toLowerCase();
    return PD_MAPS_DESTINATION_QUERY[k] || PD_MAPS_DESTINATION_QUERY.ewr;
}

function pdDriveDestinationShortLabel(destinationKey) {
    const k = String(destinationKey || "ewr").trim().toLowerCase();
    const labels = {
        ewr: "Newark (EWR)",
        p1_short_term_a: "P1 parking",
        p2_short_term_b: "P2 parking",
        p3_short_term_c: "P3 parking",
        p4_daily: "P4 garage",
        p6_economy: "P6 parking",
        terminal_a: "Terminal A",
        terminal_b: "Terminal B",
        terminal_c: "Terminal C",
    };
    return labels[k] || labels.ewr;
}

function pdBuildGoogleMapsDriveUrl(originPlaceId, originAddress, destinationKey) {
    const pid = String(originPlaceId || "").trim();
    const addr = String(originAddress || "").trim();
    if (!pid && !addr) return "";
    const params = new URLSearchParams();
    params.set("api", "1");
    params.set("travelmode", "driving");
    params.set("destination", pdMapsDestinationQuery(destinationKey));
    // Prefer a readable origin address so Maps opens with that point-to-point route.
    // Using origin_place_id alone often resolves poorly or falls back to “Your location”.
    if (addr) params.set("origin", addr);
    else if (pid) params.set("origin_place_id", pid);
    return `https://www.google.com/maps/dir/?${params.toString()}`;
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

async function pdDriveEstimate({ placeId, address, departureIso, destinationKey }) {
    const payload = await postPlannerDriveEstimate({
        origin_address: placeId ? (address || null) : (address || null),
        origin_place_id: placeId || null,
        departure_time: departureIso,
        destination_key: destinationKey || "ewr",
    });
    const m = Number(payload.drive_minutes);
    if (!Number.isFinite(m) || m < 1) throw new Error("Invalid drive minutes");
    return Math.round(m);
}

function pdInit() {
    const flight = pdGetFlightFromQuery();
    const id = pdPlanId(flight);

    const backLinkEl = document.getElementById("pd-back-link");
    if (backLinkEl instanceof HTMLAnchorElement) {
        const fromCtx = String(pdGetQuery().get("from") || "")
            .trim()
            .toLowerCase();
        if (fromCtx === "saved") {
            backLinkEl.href = "saved.html";
            backLinkEl.textContent = "← Back to saved plans";
        }
    }

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
    const calcBtn = document.getElementById("pd-calc-drive");

    // Wizard UI (4-step checkout-style flow).
    const stepsTrackEl = document.getElementById("pd-steps-track");
    const stepsViewportEl = document.querySelector(".pd-steps-viewport");
    const dotEls = Array.from(document.querySelectorAll(".pd-dot"));
    const wizBackEl = document.getElementById("pd-wiz-back");
    const wizNextEl = document.getElementById("pd-wiz-next");
    const wizardBarEl = document.querySelector("nav.pd-wizard");
    const stepTimelineEl = document.getElementById("pd-step-timeline");
    const saveTimelineEl = document.getElementById("pd-save-timeline");

    const precheckEl = document.getElementById("pd-precheck");
    const clearEl = document.getElementById("pd-clear");
    const bagsEl = document.getElementById("pd-bags");
    const parkEl = document.getElementById("pd-park");
    const parkSelectedEl = document.getElementById("pd-park-selected");

    const securityEl = document.getElementById("pd-security");
    const supportEl = document.getElementById("pd-support");

    const boardingInlineEl = document.getElementById("pd-boarding-inline");
    const leaveVerySafeEl = document.getElementById("pd-leave-very-safe");
    const leaveSafeEl = document.getElementById("pd-leave-safe");
    const leaveRecEl = document.getElementById("pd-leave-rec");
    const leaveTightEl = document.getElementById("pd-leave-tight");
    const leaveVeryTightEl = document.getElementById("pd-leave-very-tight");

    const tlLeaveEl = document.getElementById("pd-tl-leave");
    const tlAddOnsEl = document.getElementById("pd-tl-addons");
    const tlSecurityEl = document.getElementById("pd-tl-security");
    const tlWalkEl = document.getElementById("pd-tl-walk");
    const tlGateEl = document.getElementById("pd-tl-gate");
    const tlBoardingEl = document.getElementById("pd-tl-boarding");
    const dirRouteEl = document.getElementById("pd-dir-route");
    const openAirportMapEl = document.getElementById("pd-open-airport-map");
    const driveDirRouteEl = document.getElementById("pd-drive-dir-route");
    const openDriveMapsEl = document.getElementById("pd-open-drive-maps");

    const addOnsWrapEl = document.getElementById("pd-addons-wrap");
    const addOnsTitleEl = document.getElementById("pd-addons-title");
    const addOnsSubEl = document.getElementById("pd-addons-sub");
    const addOnsMinEl = document.getElementById("pd-addons-min");

    // Parking lot picker modal
    const parkModalEl = document.getElementById("pd-park-modal");
    const parkListEl = document.getElementById("pd-park-list");
    const parkConfirmEl = document.getElementById("pd-park-confirm");

    const secModalEl = document.getElementById("pd-security-modal");
    const secListEl = document.getElementById("pd-security-list");
    const secConfirmEl = document.getElementById("pd-security-confirm");

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
        leaveChoice: "rec", // very_safe | safe | rec | tight | very_tight
        wizardStepIndex: 0, // 0..3
        timelineVisible: false,
        /** Minutes at gate before boarding starts for the selected leave tier (may be negative). */
        effectiveGateBufferMin: PD_BASE_GATE_BUFFER_MIN,
        parkingLotId: "",
        /** When set, successful drive Submit returns to this wizard step instead of step 2. */
        wizardReturnStepAfterAddress: null,
        /** When set, Next from Advanced options (step 2) returns to this step — skips Leave-by. */
        wizardReturnStepAfterOptionsEdit: null,
    };

    function hasAddress() {
        return Boolean((originEl?.value || "").trim() || state.origin.placeId);
    }

    function isStepComplete(idx) {
        if (idx === 0) return hasAddress() && state.driveMin != null;
        if (idx === 1) return !Boolean(parkEl?.checked) || Boolean(state.parkingLotId);
        if (idx === 2) return true; // leave option defaults to Recommended
        if (idx === 3) return state.timelineVisible;
        return false;
    }

    function maxReachableStep() {
        // Keep the flow gated like checkout: you can’t proceed until drive time is calculated.
        return isStepComplete(0) ? 3 : 0;
    }

    let persistPlanTimer = null;

    /**
     * Full persisted plan state. Timeline clock labels are not stored; they are recomputed on load
     * from these fields (address, drive, cushion/buffer, security line, bags/park/lot, leave-by tier, etc.).
     */
    function buildPlanRecord() {
        const cushion = Math.max(
            0,
            Math.round(Number(state.effectiveGateBufferMin)),
        );
        return {
            id,
            savedAt: Date.now(),
            flight,
            origin: { ...state.origin, address: (originEl?.value || "").trim() },
            driveMin: state.driveMin,
            cushion: Number.isFinite(cushion) ? cushion : PD_BASE_GATE_BUFFER_MIN,
            precheck: Boolean(precheckEl?.checked),
            clear: Boolean(clearEl?.checked),
            bags: Boolean(bagsEl?.checked),
            park: Boolean(parkEl?.checked),
            parkingLotId: state.parkingLotId,
            leaveChoice: state.leaveChoice,
            wizardStepIndex: state.wizardStepIndex,
            timelineVisible: state.timelineVisible,
        };
    }

    function schedulePersistPlan() {
        if (persistPlanTimer != null) window.clearTimeout(persistPlanTimer);
        persistPlanTimer = window.setTimeout(() => {
            persistPlanTimer = null;
            try {
                pdUpsertPlan(buildPlanRecord());
            } catch {
                /* ignore quota / private mode */
            }
        }, 200);
    }

    const saved = pdFindPlan(id);
    if (saved) {
        state.origin = saved.origin || state.origin;
        state.driveMin = typeof saved.driveMin === "number" ? saved.driveMin : state.driveMin;
        if (originEl && state.origin.address) originEl.value = state.origin.address;
        if (precheckEl) precheckEl.checked = Boolean(saved.precheck);
        if (clearEl) clearEl.checked = Boolean(saved.clear);
        if (bagsEl) bagsEl.checked = Boolean(saved.bags);
        if (parkEl) parkEl.checked = Boolean(saved.park);
        state.parkingLotId = String(saved.parkingLotId || "");
        if (typeof saved.wizardStepIndex === "number" && Number.isFinite(saved.wizardStepIndex)) {
            state.wizardStepIndex = Math.max(0, Math.min(3, Math.round(saved.wizardStepIndex)));
        }
        if (typeof saved.timelineVisible === "boolean") {
            state.timelineVisible = saved.timelineVisible;
        }
        if (saved.leaveChoice) {
            const allowed = new Set(["very_safe", "safe", "rec", "tight", "very_tight"]);
            if (allowed.has(String(saved.leaveChoice))) state.leaveChoice = saved.leaveChoice;
        }
        state.wizardStepIndex = Math.min(state.wizardStepIndex, maxReachableStep());
    }

    function setWizardStep(idx) {
        const next = Math.max(0, Math.min(3, Number(idx) || 0));
        const prev = state.wizardStepIndex;
        // Leaving step 1 without a fresh Submit cancels “return to timeline after edit”.
        if (prev === 0 && next !== 0 && state.wizardReturnStepAfterAddress != null) {
            state.wizardReturnStepAfterAddress = null;
        }
        if (prev === 1 && next !== 1 && state.wizardReturnStepAfterOptionsEdit != null) {
            state.wizardReturnStepAfterOptionsEdit = null;
        }
        const maxStep = maxReachableStep();
        state.wizardStepIndex = Math.min(next, maxStep);
        renderWizard();
        schedulePersistPlan();
    }

    function createTimeline() {
        state.timelineVisible = true;
        renderWizard();
        // Keep existing timeline values consistent with the current selection.
        recomputeUi();
    }

    function syncNextStepsChrome() {
        const wrap = document.getElementById("pd-next-steps");
        const shareBtn = document.getElementById("pd-share-plan");
        const mapDisabled =
            openAirportMapEl instanceof HTMLElement &&
            openAirportMapEl.classList.contains("is-disabled");
        const airportPrimary =
            state.wizardStepIndex >= 3 && state.timelineVisible && !mapDisabled;
        wrap?.classList.toggle("pd-next-steps--airport-primary", airportPrimary);

        if (openAirportMapEl instanceof HTMLElement) {
            openAirportMapEl.classList.toggle("btn-primary", airportPrimary);
            openAirportMapEl.classList.toggle("btn-ghost", !airportPrimary);
        }
        if (openDriveMapsEl instanceof HTMLElement) {
            openDriveMapsEl.classList.remove("btn-primary");
            openDriveMapsEl.classList.add("btn-ghost");
        }
        if (shareBtn instanceof HTMLElement) {
            shareBtn.classList.remove("btn-primary");
            shareBtn.classList.add("btn-ghost");
        }
    }

    function scrollWizardViewportToStep(stepIndex) {
        if (!(stepsViewportEl instanceof HTMLElement) || !stepsTrackEl) return;
        const panels = stepsTrackEl.querySelectorAll(":scope > .pd-step");
        const panel = panels[stepIndex];
        if (!(panel instanceof HTMLElement)) return;

        const snap = () => {
            // Align by geometry so we never land “between” steps (smooth scroll + width*index can drift).
            const vr = stepsViewportEl.getBoundingClientRect();
            const pr = panel.getBoundingClientRect();
            const dx = pr.left - vr.left;
            stepsViewportEl.scrollLeft += dx;
        };

        snap();
        requestAnimationFrame(() => {
            requestAnimationFrame(snap);
        });
    }

    function renderWizard() {
        // Step 4 timeline visibility affects layout — apply before snapping horizontal scroll.
        if (stepTimelineEl) stepTimelineEl.classList.toggle("is-hidden", !state.timelineVisible);

        // Horizontal steps: scroll viewport (no transform — keeps text crisp). Instant snap avoids halfway frames.
        if (stepsViewportEl instanceof HTMLElement && stepsTrackEl) {
            scrollWizardViewportToStep(state.wizardStepIndex);
        } else if (stepsTrackEl) {
            stepsTrackEl.style.transform = `translateX(-${state.wizardStepIndex * 100}%)`;
        }

        const maxStep = maxReachableStep();

        // Dots
        dotEls.forEach((dot, i) => {
            const isCurrent = i === state.wizardStepIndex;
            const complete = isStepComplete(i);
            const disabled = i > maxStep;
            dot.classList.toggle("is-current", isCurrent);
            dot.classList.toggle("is-complete", complete && !isCurrent);
            dot.classList.toggle("is-disabled", disabled);
            dot.disabled = disabled;
            dot.setAttribute("aria-selected", String(isCurrent));
        });

        // Buttons
        if (wizBackEl) wizBackEl.disabled = state.wizardStepIndex <= 0;

        if (wizNextEl) {
            if (state.wizardStepIndex === 2) {
                // Must clear is-hidden: it is set on step 3+, so returning here from “Edit buffer” would otherwise hide Next forever.
                wizNextEl.classList.remove("is-hidden");
                wizNextEl.textContent = state.timelineVisible ? "Next" : "Generate timeline";
                wizNextEl.disabled = false;
            } else if (state.wizardStepIndex >= 3) {
                // No bottom-right action on the last step.
                wizNextEl.classList.add("is-hidden");
            } else {
                wizNextEl.classList.remove("is-hidden");
                wizNextEl.textContent = "Next";
                wizNextEl.disabled = false;
            }
        }

        const timelineFinal = state.wizardStepIndex >= 3 && state.timelineVisible;
        wizardBarEl?.classList.toggle("pd-wizard--timeline-final", timelineFinal);
        syncNextStepsChrome();
    }

    function enforceSecurityOptionExclusivity(source) {
        if (!precheckEl || !clearEl) return;
        if (source === "precheck" && precheckEl.checked) clearEl.checked = false;
        if (source === "clear" && clearEl.checked) precheckEl.checked = false;
        // If both are ever true (e.g. via saved data), prefer the user's most recent action;
        // otherwise default to PreCheck off.
        if (precheckEl.checked && clearEl.checked) clearEl.checked = false;
    }

    function recommendedParkingLotId() {
        const t = pdNormalizeTerminalLetter(flight.terminal);
        if (t.includes("A")) return "p1_short_term_a";
        if (t.includes("B")) return "p2_short_term_b";
        if (t.includes("C")) return "p3_short_term_c";
        return "p4_daily";
    }

    function buildParkingLots() {
        const recId = recommendedParkingLotId();
        return [
            { id: "p1_short_term_a", name: "P1 Short-Term (Terminal A)", sub: "Closest for Terminal A (garage)", recommended: recId === "p1_short_term_a" },
            { id: "p2_short_term_b", name: "P2 Short-Term (Terminal B)", sub: "Closest for Terminal B (garage)", recommended: recId === "p2_short_term_b" },
            { id: "p3_short_term_c", name: "P3 Short-Term (Terminal C)", sub: "Closest for Terminal C (garage)", recommended: recId === "p3_short_term_c" },
            { id: "p4_daily", name: "P4 Daily Parking Garage", sub: "Good for multi-day trips (AirTrain/shuttle connection)", recommended: recId === "p4_daily" },
            { id: "p6_economy", name: "P6 Economy Lot", sub: "Cheapest on-airport option (free shuttle)", recommended: recId === "p6_economy" },
        ];
    }

    function closeParkModal() {
        parkModalEl?.classList.add("is-hidden");
        parkModalEl?.setAttribute("aria-hidden", "true");
    }

    function pdSecurityChoiceKeyFromDom() {
        if (!precheckEl || !clearEl) return "regular";
        if (precheckEl.checked) return "precheck";
        if (clearEl.checked) return "clear";
        return "regular";
    }

    function pdApplySecurityChoice(key) {
        if (!precheckEl || !clearEl) return;
        const k = String(key || "regular");
        if (k === "precheck") {
            precheckEl.checked = true;
            clearEl.checked = false;
            enforceSecurityOptionExclusivity("precheck");
        } else if (k === "clear") {
            clearEl.checked = true;
            precheckEl.checked = false;
            enforceSecurityOptionExclusivity("clear");
        } else {
            precheckEl.checked = false;
            clearEl.checked = false;
            enforceSecurityOptionExclusivity("none");
        }
    }

    function closeSecurityModal() {
        secModalEl?.classList.add("is-hidden");
        secModalEl?.setAttribute("aria-hidden", "true");
    }

    function openSecurityModal() {
        if (!secModalEl || !secListEl || !precheckEl || !clearEl) return;
        let pending = pdSecurityChoiceKeyFromDom();
        const opts = [
            { id: "regular", name: "Regular" },
            { id: "clear", name: "CLEAR" },
            { id: "precheck", name: "TSA PreCheck" },
        ];
        secListEl.innerHTML = opts
            .map((o) => {
                const cls = ["pd-park-item", pending === o.id ? "is-selected" : ""].filter(Boolean).join(" ");
                return `
                    <button type="button" class="${cls}" data-security-line="${encodeURIComponent(o.id)}">
                        <span class="pd-park-name">${o.name}</span>
                    </button>`;
            })
            .join("");

        secListEl.querySelectorAll("[data-security-line]").forEach((btn) => {
            btn.addEventListener("click", () => {
                pending = decodeURIComponent(btn.getAttribute("data-security-line") || "regular");
                secListEl.querySelectorAll(".pd-park-item").forEach((x) => x.classList.remove("is-selected"));
                btn.classList.add("is-selected");
            });
        });

        secModalEl.classList.remove("is-hidden");
        secModalEl.removeAttribute("aria-hidden");

        secModalEl.querySelectorAll("[data-action='close']").forEach((el) => {
            el.addEventListener("click", () => {
                closeSecurityModal();
            });
        });
        secModalEl.querySelectorAll("[data-action='cancel']").forEach((el) => {
            el.addEventListener("click", () => {
                closeSecurityModal();
            });
        });
        secConfirmEl?.addEventListener("click", () => {
            pdApplySecurityChoice(pending);
            closeSecurityModal();
            recomputeUi();
            renderWizard();
        });
    }

    function openParkModal() {
        if (!parkModalEl || !parkListEl) return;
        const lots = buildParkingLots();
        let pending = state.parkingLotId || "";
        parkConfirmEl && (parkConfirmEl.disabled = !pending);

        parkListEl.innerHTML = lots
            .map((lot) => {
                const cls = ["pd-park-item", lot.recommended ? "is-recommended" : "", pending === lot.id ? "is-selected" : ""]
                    .filter(Boolean)
                    .join(" ");
                const badge = lot.recommended ? `<span class="pd-park-badge">Recommended</span>` : "";
                return `
                    <button type="button" class="${cls}" data-lot-id="${encodeURIComponent(lot.id)}">
                        <span class="pd-park-item-main">
                            <span class="pd-park-top">
                                <span class="pd-park-name">${lot.name}</span>
                                ${badge}
                            </span>
                            <span class="pd-park-sub">${lot.sub}</span>
                        </span>
                        <span class="pd-park-selected-mark" aria-hidden="true">
                            <svg class="pd-park-check" viewBox="0 0 20 20" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4.5 10.2 8.3 14l7.2-7.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            <span class="pd-park-selected-pill">Selected</span>
                        </span>
                    </button>
                `;
            })
            .join("");

        parkListEl.querySelectorAll("[data-lot-id]").forEach((btn) => {
            btn.addEventListener("click", () => {
                pending = decodeURIComponent(btn.getAttribute("data-lot-id") || "");
                parkListEl.querySelectorAll(".pd-park-item").forEach((x) => x.classList.remove("is-selected"));
                btn.classList.add("is-selected");
                if (parkConfirmEl) parkConfirmEl.disabled = !pending;
            });
        });

        parkModalEl.classList.remove("is-hidden");
        parkModalEl.removeAttribute("aria-hidden");

        // Wire close/cancel actions
        parkModalEl.querySelectorAll("[data-action='close']").forEach((el) => {
            el.addEventListener("click", () => {
                // Closing behaves like cancel if no prior selection.
                if (!state.parkingLotId && parkEl) parkEl.checked = false;
                closeParkModal();
                recomputeUi();
                renderWizard();
            });
        });
        parkModalEl.querySelectorAll("[data-action='cancel']").forEach((el) => {
            el.addEventListener("click", () => {
                if (!state.parkingLotId && parkEl) parkEl.checked = false;
                closeParkModal();
                recomputeUi();
                renderWizard();
            });
        });
        parkConfirmEl?.addEventListener("click", () => {
            if (!pending) return;
            state.parkingLotId = pending;
            closeParkModal();
            recomputeUi();
            renderWizard();
            if (state.driveMin != null && hasAddress()) void recalcDrive();

            const returnAfterOptions = state.wizardReturnStepAfterOptionsEdit;
            if (typeof returnAfterOptions === "number" && Number.isFinite(returnAfterOptions)) {
                state.wizardReturnStepAfterOptionsEdit = null;
                recomputeUi();
                setWizardStep(returnAfterOptions);
            }
        });
    }

    function resetDriveDirectionsBubble() {
        if (driveDirRouteEl) driveDirRouteEl.textContent = "\u2014";
        if (openDriveMapsEl instanceof HTMLAnchorElement) {
            openDriveMapsEl.href = "#";
            openDriveMapsEl.classList.add("is-disabled");
            openDriveMapsEl.setAttribute("aria-disabled", "true");
            openDriveMapsEl.tabIndex = -1;
        }
    }

    function recomputeUi() {
        // Make exclusivity robust: enforce on every recompute (covers any event ordering).
        enforceSecurityOptionExclusivity("none");

        const precheck = Boolean(precheckEl?.checked);
        const hasClear = Boolean(clearEl?.checked);
        const bags = Boolean(bagsEl?.checked);
        const park = Boolean(parkEl?.checked);

        const hasGoogle = state.driveMin != null;

        // Address step: enable calculate only when it can run.
        if (calcBtn) calcBtn.disabled = !hasAddress() || !validDep;

        // "Literally cannot select both": disable the other option when one is selected.
        if (precheckEl && clearEl) {
            clearEl.disabled = precheck;
            precheckEl.disabled = hasClear;
        }

        const walkMin = 12;
        const driveMin = state.driveMin != null ? state.driveMin : 42;
        const gateBufferMin = PD_BASE_GATE_BUFFER_MIN;
        const addOnsMin = pdComputeAddOnsMinutes({ bags, park, parking_lot_id: state.parkingLotId });

        const secBase = state.securityBaseMin != null ? state.securityBaseMin : 18;
        let securityMin = secBase;
        if (precheck) securityMin = Math.max(3, Math.round(secBase * 0.65));
        else if (hasClear) securityMin = Math.max(3, Math.round(secBase * 0.8));

        if (driveEl) driveEl.textContent = state.driveMin != null ? String(state.driveMin) : "—";
        if (driveSourceEl) {
            const addrLine = (originEl?.value || "").trim() || String(state.origin.address || "").trim();
            if (addrLine) {
                driveSourceEl.textContent = addrLine;
            } else {
                driveSourceEl.textContent = state.driveMin != null ? "Starting address" : "\u2014";
            }
        }
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

        (function syncAddonsParkingTimeline() {
            const row = document.getElementById("pd-addons-park-edit-row");
            const nameEl = document.getElementById("pd-addons-parking-name");
            if (!row || !nameEl) return;
            const show = Boolean(park) && addOnsMin > 0;
            row.classList.toggle("is-hidden", !show);
            if (show) {
                nameEl.textContent = state.parkingLotId
                    ? pdParkingLotName(state.parkingLotId)
                    : "Choose a parking lot";
            }
        })();

        (function syncSecurityTimelineLabels() {
            const gateEl = document.getElementById("pd-security-gate");
            const lineEl = document.getElementById("pd-security-line");
            const termLetter = pdNormalizeTerminalLetter(flight.terminal);
            if (gateEl) gateEl.textContent = termLetter ? `Terminal ${termLetter} checkpoint` : "Checkpoint";
            if (lineEl) lineEl.textContent = pdSecurityLineLabel(precheck, hasClear);
        })();

        // Timeline layout: alternate left/right based on VISIBLE steps (add-ons can be hidden).
        // Presentation-only; does not affect any timing or calculations.
        (function applyTimelineAlternation() {
            const items = Array.from(document.querySelectorAll(".pd-timeline-item"));
            const visible = items.filter((el) => !(el instanceof HTMLElement) ? false : !el.classList.contains("is-hidden"));
            for (const el of items) {
                if (el instanceof HTMLElement) {
                    el.classList.remove("is-left", "is-right");
                }
            }
            visible.forEach((el, idx) => {
                if (!(el instanceof HTMLElement)) return;
                el.classList.add(idx % 2 === 0 ? "is-left" : "is-right");
            });
        })();

        (function updateAirportDirectionsCta() {
            const termLetter = pdNormalizeTerminalLetter(flight.terminal);
            const gateRaw = String(flight.gate || "").trim();
            const gate = gateRaw || "—";

            const parkChosen = Boolean(parkEl?.checked);
            const lotId = parkChosen ? (state.parkingLotId || recommendedParkingLotId()) : "";
            const fromLabel = parkChosen
                ? pdParkingLotName(lotId)
                : (termLetter ? `Terminal ${termLetter} security` : "Security");

            const fromParam = parkChosen
                ? pdParkingLotShortCode(lotId)
                : (termLetter ? `Security-${termLetter}` : "Security");

            const toParam = gateRaw ? gateRaw.replace(/\s+/g, "") : "";
            const terminalParam = termLetter || "";

            if (dirRouteEl) {
                const toLabel = gateRaw ? `Gate ${gate}` : "Gate —";
                dirRouteEl.textContent = `${fromLabel} \u2192 ${toLabel}`;
            }

            if (openAirportMapEl instanceof HTMLAnchorElement) {
                const canLink = Boolean(terminalParam) && Boolean(toParam);
                openAirportMapEl.classList.toggle("is-disabled", !canLink);
                openAirportMapEl.setAttribute("aria-disabled", canLink ? "false" : "true");
                openAirportMapEl.tabIndex = canLink ? 0 : -1;
                const planQs = window.location.search.replace(/^\?/, "");
                const planSuffix =
                    planQs !== "" ? `&plan_return=${encodeURIComponent(planQs)}` : "";
                openAirportMapEl.href = canLink
                    ? `airport-map.html?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}&terminal=${encodeURIComponent(terminalParam)}${planSuffix}`
                    : planQs !== ""
                      ? `airport-map.html?plan_return=${encodeURIComponent(planQs)}`
                      : "airport-map.html";
            }
        })();

        if (parkSelectedEl) {
            const show = park && Boolean(state.parkingLotId);
            parkSelectedEl.classList.toggle("is-hidden", !show);
            if (show) parkSelectedEl.textContent = `Parking lot: ${pdParkingLotName(state.parkingLotId)}`;
        }


        if (!validDep) {
            resetDriveDirectionsBubble();
            renderWizard();
            pdClearLeaveGateNotes();
            state.effectiveGateBufferMin = PD_BASE_GATE_BUFFER_MIN;
            if (leaveVerySafeEl) leaveVerySafeEl.textContent = "—";
            if (leaveSafeEl) leaveSafeEl.textContent = "—";
            if (leaveRecEl) leaveRecEl.textContent = "—";
            if (leaveTightEl) leaveTightEl.textContent = "—";
            if (leaveVeryTightEl) leaveVeryTightEl.textContent = "—";
            if (boardingInlineEl) boardingInlineEl.textContent = "";
            if (tlLeaveEl) tlLeaveEl.textContent = "—";
            if (tlAddOnsEl) tlAddOnsEl.textContent = "—";
            if (tlSecurityEl) tlSecurityEl.textContent = "—";
            if (tlWalkEl) tlWalkEl.textContent = "—";
            if (tlGateEl) tlGateEl.textContent = "—";
            if (tlBoardingEl) tlBoardingEl.textContent = "—";
            schedulePersistPlan();
            return;
        }

        // If the user hasn't calculated drive time yet, don't compute the later steps.
        // Keep the UI focused on the current step (address + calculate).
        if (!hasGoogle) {
            resetDriveDirectionsBubble();
            renderWizard();
            pdClearLeaveGateNotes();
            state.effectiveGateBufferMin = PD_BASE_GATE_BUFFER_MIN;
            if (leaveVerySafeEl) leaveVerySafeEl.textContent = "—";
            if (leaveSafeEl) leaveSafeEl.textContent = "—";
            if (leaveRecEl) leaveRecEl.textContent = "—";
            if (leaveTightEl) leaveTightEl.textContent = "—";
            if (leaveVeryTightEl) leaveVeryTightEl.textContent = "—";
            if (boardingInlineEl) boardingInlineEl.textContent = "";
            if (tlLeaveEl) tlLeaveEl.textContent = "—";
            if (tlAddOnsEl) tlAddOnsEl.textContent = "—";
            if (tlSecurityEl) tlSecurityEl.textContent = "—";
            if (tlWalkEl) tlWalkEl.textContent = "—";
            if (tlGateEl) tlGateEl.textContent = "—";
            if (tlBoardingEl) tlBoardingEl.textContent = "—";
            schedulePersistPlan();
            return;
        }

        const times = pdComputeLeaveTimes({ depMs, driveMin: driveMin + addOnsMin, securityMin, walkMin, bufferMin: gateBufferMin });
        if (boardingInlineEl) boardingInlineEl.innerHTML = `Boarding starts at <strong>${pdFmtTime(times.boardingMs)}</strong>`;

        const base = times.recMs;
        const options = {
            very_safe: base - 20 * 60000,
            safe: base - 10 * 60000,
            rec: base,
            tight: base + 10 * 60000,
            very_tight: base + 20 * 60000,
        };

        if (leaveVerySafeEl) leaveVerySafeEl.textContent = pdFmtTime(options.very_safe);
        if (leaveSafeEl) leaveSafeEl.textContent = pdFmtTime(options.safe);
        if (leaveRecEl) leaveRecEl.textContent = pdFmtTime(options.rec);
        if (leaveTightEl) leaveTightEl.textContent = pdFmtTime(options.tight);
        if (leaveVeryTightEl) leaveVeryTightEl.textContent = pdFmtTime(options.very_tight);

        const boardingMsForGate = times.boardingMs;
        for (const [key, id] of PD_LEAVE_GATE_NOTE_IDS) {
            const lm = options[key];
            const mins = pdMinsAtGateBeforeBoarding(boardingMsForGate, lm, driveMin, addOnsMin, securityMin, walkMin);
            const gel = document.getElementById(id);
            if (gel) gel.textContent = pdFmtGateBeforeBoardingLine(mins);
        }
        const selLeaveKey = options[state.leaveChoice] != null ? state.leaveChoice : "rec";
        state.effectiveGateBufferMin = pdMinsAtGateBeforeBoarding(
            boardingMsForGate,
            options[selLeaveKey],
            driveMin,
            addOnsMin,
            securityMin,
            walkMin,
        );
        const gateHintEl = document.getElementById("pd-gate-buffer-hint");
        if (gateHintEl) {
            const hm = Math.round(state.effectiveGateBufferMin);
            if (!Number.isFinite(hm)) gateHintEl.textContent = "\u2014";
            else if (hm >= 0) gateHintEl.textContent = `${hm} min before boarding starts`;
            else gateHintEl.textContent = `${Math.abs(hm)} min after boarding starts`;
        }

        const leaveMs = options[state.leaveChoice] != null ? options[state.leaveChoice] : options.rec;

        // Timeline should reflect the *selected leave time* all the way through arrival.
        // Otherwise Safe/Tight deltas “disappear” and gate arrival looks identical.
        const driveArriveMs = leaveMs + driveMin * 60000;
        const addOnsStartMs = driveArriveMs;
        const securityStartMs = addOnsStartMs + addOnsMin * 60000;
        const walkStartMs = securityStartMs + securityMin * 60000;
        const gateArriveMs = walkStartMs + walkMin * 60000;

        if (tlLeaveEl) tlLeaveEl.textContent = pdFmtTime(leaveMs);
        if (tlAddOnsEl) tlAddOnsEl.textContent = pdFmtTime(addOnsStartMs);
        if (tlSecurityEl) tlSecurityEl.textContent = pdFmtTime(securityStartMs);
        if (tlWalkEl) tlWalkEl.textContent = pdFmtTime(walkStartMs);
        if (tlGateEl) tlGateEl.textContent = pdFmtTime(gateArriveMs);
        if (tlBoardingEl) tlBoardingEl.textContent = pdFmtTime(boardingMsForGate);
        if (supportEl) {
            supportEl.textContent = hasGoogle
                ? "Pick a buffer level. You can change this later."
                : "Submit your address to continue.";
        }

        (function syncDriveDirectionsBubble() {
            const addrLine = (originEl?.value || "").trim() || String(state.origin.address || "").trim();
            const label =
                addrLine.length > 46
                    ? `${addrLine.slice(0, 44)}\u2026`
                    : addrLine || (state.origin.placeId ? "Your starting place" : "");
            const destKey = pdDriveDestinationKeyFromPlan(flight, park, state.parkingLotId);
            const destShort = pdDriveDestinationShortLabel(destKey);
            if (driveDirRouteEl) {
                driveDirRouteEl.textContent = label ? `${label} \u2192 ${destShort}` : "\u2014";
            }
            const url = pdBuildGoogleMapsDriveUrl(state.origin.placeId, addrLine, destKey);
            const canOpen = Boolean(url);
            if (openDriveMapsEl instanceof HTMLAnchorElement) {
                openDriveMapsEl.href = canOpen ? url : "#";
                openDriveMapsEl.classList.toggle("is-disabled", !canOpen);
                openDriveMapsEl.setAttribute("aria-disabled", canOpen ? "false" : "true");
                openDriveMapsEl.tabIndex = canOpen ? 0 : -1;
            }
        })();

        renderWizard();
        schedulePersistPlan();
    }

    function applyLeaveChoice(next) {
        const allowed = new Set(["very_safe", "safe", "rec", "tight", "very_tight"]);
        const choice = allowed.has(String(next)) ? String(next) : "rec";
        state.leaveChoice = choice;

        const items = document.querySelectorAll(".pd-leave-option");
        items.forEach((item) => item.classList.toggle("is-selected", item.getAttribute("data-choice") === choice));
        recomputeUi();
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
            return false;
        }
        if (!validDep) return false;

        setDriveStatus("Submitting…");
        try {
            const destinationKey = pdDriveDestinationKeyFromPlan(flight, Boolean(parkEl?.checked), state.parkingLotId);
            const m = await pdDriveEstimate({
                placeId: state.origin.placeId,
                address: addr,
                departureIso: new Date(Math.max(Date.now() + 120000, depMs - 35 * 60000)).toISOString(),
                destinationKey,
            });
            state.driveMin = m;
            state.driveSource = "google";
            // Stored in state; intentionally not shown in UI here.
            setDriveStatus("");
            return true;
        } catch {
            state.driveMin = null;
            state.driveSource = "placeholder";
            setDriveStatus("Could not submit. Try a more specific address.");
            return false;
        }
    }

    let addressStepBusy = false;

    /** Same behavior as Submit on step 1: calculate drive, then advance (or return to timeline when editing address). */
    async function advanceFromAddressStep() {
        if (addressStepBusy) return;
        addressStepBusy = true;
        try {
            const returnTo = state.wizardReturnStepAfterAddress;
            const ok = await recalcDrive();
            recomputeUi();
            if (!ok) return;
            state.wizardReturnStepAfterAddress = null;
            if (typeof returnTo === "number" && Number.isFinite(returnTo)) {
                setWizardStep(returnTo);
            } else {
                setWizardStep(1);
            }
        } finally {
            addressStepBusy = false;
        }
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
        void advanceFromAddressStep();
    });

    document.getElementById("pd-edit-origin")?.addEventListener("click", () => {
        state.wizardReturnStepAfterAddress = state.wizardStepIndex;
        setWizardStep(0);
        window.setTimeout(() => {
            originEl?.focus();
            try {
                originEl?.select?.();
            } catch {
                /* ignore */
            }
        }, 320);
    });

    document.getElementById("pd-edit-security")?.addEventListener("click", () => {
        openSecurityModal();
    });

    document.getElementById("pd-edit-parking")?.addEventListener("click", () => {
        openParkModal();
    });

    document.getElementById("pd-edit-buffer")?.addEventListener("click", () => {
        setWizardStep(2);
    });

    wizBackEl?.addEventListener("click", () => {
        setWizardStep(state.wizardStepIndex - 1);
    });

    wizNextEl?.addEventListener("click", () => {
        if (state.wizardStepIndex >= 3) return;

        if (state.wizardStepIndex === 0) {
            if (!hasAddress() || !validDep) return;
            if (isStepComplete(0)) {
                setWizardStep(1);
                return;
            }
            void advanceFromAddressStep();
            return;
        }

        const returnAfterOptions = state.wizardReturnStepAfterOptionsEdit;
        if (
            state.wizardStepIndex === 1 &&
            typeof returnAfterOptions === "number" &&
            Number.isFinite(returnAfterOptions)
        ) {
            state.wizardReturnStepAfterOptionsEdit = null;
            recomputeUi();
            setWizardStep(returnAfterOptions);
            return;
        }
        if (state.wizardStepIndex === 2 && !state.timelineVisible) {
            createTimeline();
        }
        setWizardStep(state.wizardStepIndex + 1);
    });

    dotEls.forEach((dot) => {
        dot.addEventListener("click", () => {
            const idx = Number(dot.getAttribute("data-step-index"));
            if (!Number.isFinite(idx)) return;
            setWizardStep(idx);
        });
    });

    // Block horizontal wheel / trackpad gestures — wizard moves only via Next/Back/dots (programmatic scrollLeft).
    if (stepsViewportEl instanceof HTMLElement) {
        stepsViewportEl.addEventListener(
            "wheel",
            (e) => {
                const ax = Math.abs(e.deltaX);
                const ay = Math.abs(e.deltaY);
                if (ax < 1) return;
                // Horizontal-dominant trackpad swipe — avoid stealing vertical-only scrolls.
                if (ax >= ay * 0.85) {
                    e.preventDefault();
                }
            },
            { passive: false },
        );
    }

    // Keep the current step aligned after resizes (scroll-based slider).
    window.addEventListener(
        "resize",
        () => {
            try {
                renderWizard();
            } catch {
                /* ignore */
            }
        },
        { passive: true },
    );


    // Leave time selection: stacked list buttons.
    document.querySelectorAll(".pd-leave-option").forEach((btn) => {
        btn.addEventListener("click", () => applyLeaveChoice(btn.getAttribute("data-choice") || "rec"));
    });

    precheckEl?.addEventListener("change", () => {
        enforceSecurityOptionExclusivity("precheck");
        recomputeUi();
    });
    precheckEl?.addEventListener("input", () => {
        enforceSecurityOptionExclusivity("precheck");
        recomputeUi();
    });
    clearEl?.addEventListener("change", () => {
        enforceSecurityOptionExclusivity("clear");
        recomputeUi();
    });
    clearEl?.addEventListener("input", () => {
        enforceSecurityOptionExclusivity("clear");
        recomputeUi();
    });

    [bagsEl, parkEl].forEach((el) => {
        el?.addEventListener("input", () => recomputeUi());
        el?.addEventListener("change", () => recomputeUi());
    });

    parkEl?.addEventListener("change", () => {
        if (parkEl.checked) {
            // Require lot selection when enabling parking.
            openParkModal();
        } else {
            state.parkingLotId = "";
            closeParkModal();
            recomputeUi();
            renderWizard();
            if (state.driveMin != null && hasAddress()) void recalcDrive();
        }
    });

    function savePlanNow() {
        enforceSecurityOptionExclusivity("none");
        // Cancel pending debounced autosave so this click writes one immediate snapshot of current UI + state.
        if (persistPlanTimer != null) {
            window.clearTimeout(persistPlanTimer);
            persistPlanTimer = null;
        }
        pdUpsertPlan(buildPlanRecord());
    }

    saveTimelineEl?.addEventListener("click", () => {
        savePlanNow();
    });

    const sharePlanBtn = document.getElementById("pd-share-plan");
    const sharePlanStatusEl = document.getElementById("pd-share-plan-status");

    function setSharePlanStatus(text, isError) {
        if (!sharePlanStatusEl) return;
        const show = Boolean(text);
        sharePlanStatusEl.textContent = show ? text : "";
        sharePlanStatusEl.classList.toggle("is-hidden", !show);
        sharePlanStatusEl.classList.toggle("is-error", Boolean(isError));
    }

    sharePlanBtn?.addEventListener("click", () => {
        void (async () => {
            const url = window.location.href;
            const title = `AirFlow — ${flightNo} to ${dest}`;
            const text = `EWR trip plan: ${flightNo} · Departs ${depTime}. Open in AirFlow for maps and timing.`;

            try {
                if (typeof navigator.share === "function") {
                    await navigator.share({ title, text, url });
                    setSharePlanStatus("");
                    return;
                }
            } catch (e) {
                const err = e;
                if (err && typeof err === "object" && err.name === "AbortError") return;
                // Fall through to clipboard.
            }

            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(`${text}\n\n${url}`);
                    setSharePlanStatus("Link copied — paste it into a message or email for your travel companions.");
                    return;
                }
            } catch {
                /* fall through */
            }

            try {
                window.prompt("Copy this link to share your plan:", url);
            } catch {
                setSharePlanStatus("Could not share or copy. Copy the address from your browser’s bar.", true);
            }
        })();
    });

    void refreshWaits();
    enforceSecurityOptionExclusivity("none");
    applyLeaveChoice(state.leaveChoice);
    renderWizard();
    recomputeUi();
}

document.addEventListener("DOMContentLoaded", () => {
    try {
        pdInit();
    } catch (e) {
        console.error("plan-details init failed", e);
    }
});

