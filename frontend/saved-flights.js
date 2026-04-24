const SAVED_FLIGHTS_KEY = "airflow_saved_flights";

function flightStorageKey(f) {
    const fn = String(f.flight_number || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");
    const dep = String(f.scheduled_departure || "");
    const al = String(f.airline || "").trim();
    return `${fn}|${dep}|${al}`;
}

function getSavedFlights() {
    try {
        const raw = localStorage.getItem(SAVED_FLIGHTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function setSavedFlights(list) {
    localStorage.setItem(SAVED_FLIGHTS_KEY, JSON.stringify(list));
}

function isFlightSaved(f) {
    const key = flightStorageKey(f);
    return getSavedFlights().some((x) => flightStorageKey(x) === key);
}

function saveFlight(f) {
    const list = getSavedFlights();
    const key = flightStorageKey(f);
    if (list.some((x) => flightStorageKey(x) === key)) return;
    list.push({
        ...f,
        savedAt: new Date().toISOString(),
    });
    setSavedFlights(list);
}

function removeSavedFlight(f) {
    const key = flightStorageKey(f);
    setSavedFlights(getSavedFlights().filter((x) => flightStorageKey(x) !== key));
}

function toggleSavedFlight(f) {
    if (isFlightSaved(f)) {
        removeSavedFlight(f);
        return false;
    }
    saveFlight(f);
    return true;
}
