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

function pdParkingLotShortCode(id) {
    const raw = String(id || "");
    if (raw.startsWith("p1_")) return "P1";
    if (raw.startsWith("p2_")) return "P2";
    if (raw.startsWith("p3_")) return "P3";
    if (raw.startsWith("p4_")) return "P4";
    if (raw.startsWith("p6_")) return "P6";
    return "P4";
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
    const calcBtn = document.getElementById("pd-calc-drive");

    // Wizard UI (4-step checkout-style flow).
    const stepsTrackEl = document.getElementById("pd-steps-track");
    const stepsViewportEl = document.querySelector(".pd-steps-viewport");
    const dotEls = Array.from(document.querySelectorAll(".pd-dot"));
    const wizBackEl = document.getElementById("pd-wiz-back");
    const wizNextEl = document.getElementById("pd-wiz-next");
    const stepTimelineEl = document.getElementById("pd-step-timeline");
    const saveTimelineEl = document.getElementById("pd-save-timeline");

    const cushionEl = document.getElementById("pd-cushion");
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

    const addOnsWrapEl = document.getElementById("pd-addons-wrap");
    const addOnsTitleEl = document.getElementById("pd-addons-title");
    const addOnsSubEl = document.getElementById("pd-addons-sub");
    const addOnsMinEl = document.getElementById("pd-addons-min");

    // Parking lot picker modal
    const parkModalEl = document.getElementById("pd-park-modal");
    const parkListEl = document.getElementById("pd-park-list");
    const parkConfirmEl = document.getElementById("pd-park-confirm");

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
        parkingLotId: "",
    };

    const saved = pdFindPlan(id);
    if (saved) {
        state.origin = saved.origin || state.origin;
        state.driveMin = typeof saved.driveMin === "number" ? saved.driveMin : state.driveMin;
        if (originEl && state.origin.address) originEl.value = state.origin.address;
        if (cushionEl && typeof saved.cushion === "number") cushionEl.value = String(saved.cushion);
        if (precheckEl) precheckEl.checked = Boolean(saved.precheck);
        if (clearEl) clearEl.checked = Boolean(saved.clear);
        if (bagsEl) bagsEl.checked = Boolean(saved.bags);
        if (parkEl) parkEl.checked = Boolean(saved.park);
        state.parkingLotId = String(saved.parkingLotId || "");
    }

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

    function setWizardStep(idx) {
        const next = Math.max(0, Math.min(3, Number(idx) || 0));
        const maxStep = maxReachableStep();
        state.wizardStepIndex = Math.min(next, maxStep);
        renderWizard();
    }

    function createTimeline() {
        state.timelineVisible = true;
        renderWizard();
        // Keep existing timeline values consistent with the current selection.
        recomputeUi();
    }

    function renderWizard() {
        // Track swipe: prefer scroll-snap scrolling to avoid transform text blurriness.
        if (stepsViewportEl instanceof HTMLElement) {
            const w = stepsViewportEl.clientWidth || 0;
            if (w > 0) {
                stepsViewportEl.scrollTo({ left: state.wizardStepIndex * w, behavior: "smooth" });
            }
        } else if (stepsTrackEl) {
            // Fallback: old transform method.
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
                wizNextEl.textContent = "Generate timeline";
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

        // Step 4 inner content: show/hide timeline.
        if (stepTimelineEl) stepTimelineEl.classList.toggle("is-hidden", !state.timelineVisible);
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
                        <div class="pd-park-top">
                            <span class="pd-park-name">${lot.name}</span>
                            ${badge}
                        </div>
                        <div class="pd-park-sub">${lot.sub}</div>
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
        });
    }

    function recomputeUi() {
        // Make exclusivity robust: enforce on every recompute (covers any event ordering).
        enforceSecurityOptionExclusivity("none");

        const cushion = Number(cushionEl?.value || 15);
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
        const gateBufferMin = Math.max(0, Number(cushion || 0));
        const addOnsMin = pdComputeAddOnsMinutes({ bags, park, parking_lot_id: state.parkingLotId });

        const secBase = state.securityBaseMin != null ? state.securityBaseMin : 18;
        let securityMin = secBase;
        if (precheck) securityMin = Math.max(3, Math.round(secBase * 0.65));
        else if (hasClear) securityMin = Math.max(3, Math.round(secBase * 0.8));

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
                openAirportMapEl.href = canLink
                    ? `airport-map.html?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}&terminal=${encodeURIComponent(terminalParam)}`
                    : "airport-map.html";
            }
        })();

        if (parkSelectedEl) {
            const show = park && Boolean(state.parkingLotId);
            parkSelectedEl.classList.toggle("is-hidden", !show);
            if (show) parkSelectedEl.textContent = `Parking lot: ${pdParkingLotName(state.parkingLotId)}`;
        }


        if (!validDep) {
            renderWizard();
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
            return;
        }

        // If the user hasn't calculated drive time yet, don't compute the later steps.
        // Keep the UI focused on the current step (address + calculate).
        if (!hasGoogle) {
            renderWizard();
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

        const leaveMs = options[state.leaveChoice] != null ? options[state.leaveChoice] : options.rec;

        // Timeline should reflect the *selected leave time* all the way through arrival.
        // Otherwise Safe/Tight deltas “disappear” and gate arrival looks identical.
        const driveArriveMs = leaveMs + driveMin * 60000;
        const addOnsStartMs = driveArriveMs;
        const securityStartMs = addOnsStartMs + addOnsMin * 60000;
        const walkStartMs = securityStartMs + securityMin * 60000;
        const gateArriveMs = walkStartMs + walkMin * 60000;
        const boardingMs = times.boardingMs;

        if (tlLeaveEl) tlLeaveEl.textContent = pdFmtTime(leaveMs);
        if (tlAddOnsEl) tlAddOnsEl.textContent = pdFmtTime(addOnsStartMs);
        if (tlSecurityEl) tlSecurityEl.textContent = pdFmtTime(securityStartMs);
        if (tlWalkEl) tlWalkEl.textContent = pdFmtTime(walkStartMs);
        if (tlGateEl) tlGateEl.textContent = pdFmtTime(gateArriveMs);
        if (tlBoardingEl) tlBoardingEl.textContent = pdFmtTime(boardingMs);
        if (supportEl) {
            supportEl.textContent = hasGoogle
                ? "Pick a buffer level. You can change this later."
                : "Submit your address to continue.";
        }

        renderWizard();
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
            const m = await pdDriveEstimate({
                placeId: state.origin.placeId,
                address: addr,
                departureIso: new Date(Math.max(Date.now() + 120000, depMs - 35 * 60000)).toISOString(),
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
        void (async () => {
            const ok = await recalcDrive();
            recomputeUi();
            if (ok) setWizardStep(1);
        })();
    });

    wizBackEl?.addEventListener("click", () => {
        setWizardStep(state.wizardStepIndex - 1);
    });

    wizNextEl?.addEventListener("click", () => {
        if (state.wizardStepIndex >= 3) return;
        // Enforce gating: only allow moving beyond Step 1 after drive is calculated.
        if (state.wizardStepIndex === 0 && !isStepComplete(0)) return;
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

    [cushionEl, bagsEl, parkEl].forEach((el) => {
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
        }
    });

    function savePlanNow() {
        const cushion = Number(cushionEl?.value || 15);
        enforceSecurityOptionExclusivity("none");
        const plan = {
            id,
            savedAt: Date.now(),
            flight,
            origin: { ...state.origin, address: (originEl?.value || "").trim() },
            driveMin: state.driveMin,
            cushion,
            precheck: Boolean(precheckEl?.checked),
            clear: Boolean(clearEl?.checked),
            bags: Boolean(bagsEl?.checked),
            park: Boolean(parkEl?.checked),
            parkingLotId: state.parkingLotId,
        };
        pdUpsertPlan(plan);
    }

    saveTimelineEl?.addEventListener("click", () => {
        savePlanNow();
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

