import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from google_routes import compute_drive_route
from wait_time_model import predictor

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
CACHE_FILE = DATA_DIR / "flights_cache.json"
CACHE_TTL_MINUTES = 30
AVIATIONSTACK_URL = "http://api.aviationstack.com/v1/flights"
EWR_IATA = "EWR"
ENV_FILE = PROJECT_ROOT / ".env"

# Always load project root .env, even if uvicorn starts elsewhere.
load_dotenv(dotenv_path=ENV_FILE, override=True)


def _read_api_key_from_env_file() -> str | None:
    """Fallback parser for .env in case process env loading fails."""
    if not ENV_FILE.exists():
        return None
    try:
        text = ENV_FILE.read_text(encoding="utf-8-sig")
    except OSError:
        return None

    match = re.search(r"^\s*AVIATIONSTACK_API_KEY\s*=\s*(.+?)\s*$", text, flags=re.MULTILINE)
    if not match:
        return None

    raw_value = match.group(1).strip()
    if raw_value.startswith(("'", '"')) and raw_value.endswith(("'", '"')) and len(raw_value) >= 2:
        raw_value = raw_value[1:-1].strip()
    return raw_value or None


@app.get("/")
def home():
    return {"message": "EWR Wait Time API running"}


@app.get("/current-wait")
def get_current_wait():
    try:
        df = pd.read_csv(DATA_DIR / "ewr_wait_times.csv")
        latest = df.iloc[-1]
        return {
            "wait_minutes": int(latest["wait_minutes"]),
            "timestamp": latest["timestamp"],
        }
    except Exception:
        return {"error": "No data yet"}


@app.get("/api/security/current")
def get_current_security_wait():
    return get_current_wait()


@app.get("/api/security/waits")
def get_terminal_waits(outlook_minutes: int = Query(default=0, ge=0, le=180)):
    """
    Returns terminal-level predicted security waits.

    Frontend expects a list of cards with:
    - terminal (e.g. "Terminal A")
    - name (checkpoint label)
    - minutes (int)
    - lanes (string)
    """
    waits = predictor.predict_all_terminals(outlook_minutes=outlook_minutes)
    return {
        "refreshed_at": datetime.now().isoformat(),
        "outlook_minutes": outlook_minutes,
        "terminals": [
            {
                "terminal": "Terminal A",
                "name": "Checkpoint A1 / A2",
                "minutes": int(waits.get("A", 15)),
                "lanes": "Standard + TSA PreCheck®",
            },
            {
                "terminal": "Terminal B",
                "name": "Checkpoint B1",
                "minutes": int(waits.get("B", 15)),
                "lanes": "Standard lanes",
            },
            {
                "terminal": "Terminal C",
                "name": "Checkpoint C1",
                "minutes": int(waits.get("C", 15)),
                "lanes": "Standard + TSA PreCheck®",
            },
        ],
    }


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_datetime(value: str) -> tuple[datetime, list[str]]:
    assumptions: list[str] = []
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid datetime: {value}") from exc

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
        assumptions.append("scheduled_departure_missing_timezone_assumed_utc")
    return dt, assumptions


def _clamp_minutes(value: int, min_value: int = 0, max_value: int = 24 * 60) -> int:
    return max(min_value, min(max_value, int(value)))


class PlanRequest(BaseModel):
    scheduled_departure: str = Field(..., description="ISO-8601 datetime for departure (with timezone preferred).")
    terminal: str | None = Field(default=None, description="Terminal label from flight data (e.g., 'A', 'B', 'C').")
    gate: str | None = Field(default=None, description="Gate identifier if known (e.g., 'C123').")

    origin: str | None = Field(
        default=None,
        description="User's starting point. Placeholder string for now (address/city/etc).",
    )
    tsa_precheck: bool = Field(default=False, description="Whether traveler uses TSA PreCheck.")
    checked_bags: bool = Field(default=False, description="Whether traveler will check bags at the counter.")

    board_buffer_minutes: int = Field(
        default=35,
        ge=0,
        le=240,
        description="Minutes before scheduled departure the user wants to be at the gate (boarding buffer).",
    )
    risk_profile: str = Field(
        default="normal",
        description="One of: aggressive, normal, conservative. Used for extra buffer.",
    )


class DriveEstimateRequest(BaseModel):
    """
    Traffic-aware drive time to EWR for a *future* departure instant.

    Provide either `origin_place_id` (preferred after Autocomplete) and/or `origin_address`.
    """

    origin_address: str | None = Field(default=None, description="Free-text address (fallback if no place id).")
    origin_place_id: str | None = Field(default=None, description="Google Places place_id from Autocomplete selection.")
    departure_time: str = Field(..., description="ISO-8601 datetime for when the user would leave home/drive start.")


@app.get("/api/config/google-maps")
def google_maps_client_config():
    """
    The browser needs a Maps JavaScript API key to run Places Autocomplete.

    In production, restrict this key (HTTP referrers) and keep server-side keys separate if needed.
    """
    key = (os.getenv("GOOGLE_MAPS_JS_API_KEY") or os.getenv("GOOGLE_MAPS_API_KEY") or "").strip()
    return {"enabled": bool(key), "api_key": key}


@app.post("/api/planner/drive-estimate")
def planner_drive_estimate(req: DriveEstimateRequest):
    dep_dt, dep_assumptions = _parse_datetime(req.departure_time)
    if dep_dt < _now_utc():
        dep_assumptions = [*dep_assumptions, "departure_time_in_past_traffic_may_be_inaccurate"]

    try:
        route = compute_drive_route(
            origin_address=req.origin_address,
            origin_place_id=req.origin_place_id,
            departure_time=dep_dt,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "drive_minutes": route["drive_minutes"],
        "duration_seconds": route["duration_seconds"],
        "distance_meters": route["distance_meters"],
        "destination": route["destination"],
        "departure_time": route["departure_time"],
        "assumptions": [
            *dep_assumptions,
            "routes_api_compute_routes",
            "routing_preference_traffic_aware_optimal",
            "destination_fixed_ewr",
        ],
    }


def _estimate_traffic_minutes(origin: str | None, terminal: str | None) -> tuple[int, list[str]]:
    assumptions: list[str] = []
    if origin:
        assumptions.append("traffic_placeholder_constant_from_origin")
    else:
        assumptions.append("traffic_placeholder_constant_no_origin")
    base = 55
    if terminal:
        t = str(terminal).strip().upper()
        if "A" in t:
            base = 50
        elif "B" in t:
            base = 55
        elif "C" in t:
            base = 60
    return base, assumptions


def _estimate_bag_drop_minutes(checked_bags: bool) -> tuple[int, list[str]]:
    if not checked_bags:
        return 0, ["bag_drop_assumed_none"]
    return 15, ["bag_drop_placeholder_constant_checked_bags"]


def _estimate_security_minutes(tsa_precheck: bool) -> tuple[int, list[str]]:
    assumptions: list[str] = []
    # Use terminal-aware predictor when possible (falls back internally if model missing).
    minutes = int(predictor.predict_wait("A"))  # default to A when no terminal context is provided
    assumptions.append("security_from_wait_time_model_predictor")

    if tsa_precheck:
        minutes = max(3, int(round(minutes * 0.65)))
        assumptions.append("security_precheck_multiplier_0_65")

    return _clamp_minutes(minutes, 0, 240), assumptions


def _estimate_walk_minutes(terminal: str | None, gate: str | None) -> tuple[int, list[str]]:
    assumptions: list[str] = []
    if gate:
        assumptions.append("walk_placeholder_gate_known")
        return 10, assumptions
    if terminal:
        assumptions.append("walk_placeholder_terminal_default")
        t = str(terminal).strip().upper()
        if "A" in t:
            return 12, assumptions
        if "B" in t:
            return 14, assumptions
        if "C" in t:
            return 11, assumptions
    assumptions.append("walk_placeholder_generic_default")
    return 12, assumptions


def _risk_buffer_minutes(profile: str) -> tuple[int, list[str]]:
    p = (profile or "").strip().lower()
    if p == "aggressive":
        return 10, ["risk_profile_aggressive"]
    if p == "conservative":
        return 30, ["risk_profile_conservative"]
    if p and p != "normal":
        return 20, ["risk_profile_unknown_default_normal"]
    return 20, ["risk_profile_normal_default"]


def _read_cache_file() -> dict[str, Any] | None:
    if not CACHE_FILE.exists():
        return None
    try:
        with CACHE_FILE.open("r", encoding="utf-8") as f:
            payload = json.load(f)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Bad cache file: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cache read failed: {exc}") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Bad cache file: expected object")
    if "cached_at" not in payload or "response" not in payload:
        raise HTTPException(status_code=500, detail="Bad cache file: missing fields")
    return payload


def _is_cache_valid(cached_at_str: str) -> bool:
    try:
        cached_at = datetime.fromisoformat(cached_at_str)
    except ValueError:
        raise HTTPException(status_code=500, detail="Bad cache file: invalid timestamp")
    return (_now_utc() - cached_at) < timedelta(minutes=CACHE_TTL_MINUTES)


def _write_cache_file(response_json: dict[str, Any]) -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cached_at = _now_utc().isoformat()
    payload = {
        "cached_at": cached_at,
        "response": response_json,
    }
    try:
        with CACHE_FILE.open("w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cache write failed: {exc}") from exc
    return cached_at


def _call_aviationstack() -> tuple[dict[str, Any], str]:
    api_key = (os.getenv("AVIATIONSTACK_API_KEY") or "").strip()
    if not api_key:
        api_key = _read_api_key_from_env_file() or ""
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail=(
                "Missing API key. "
                f"Checked process env and {ENV_FILE} (exists={ENV_FILE.exists()})."
            ),
        )

    params = {
        "access_key": api_key,
        "dep_iata": EWR_IATA,
        "limit": 100,
    }
    try:
        response = requests.get(AVIATIONSTACK_URL, params=params, timeout=20)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Failed API request: {exc}") from exc

    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Aviationstack returned HTTP {response.status_code}",
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Aviationstack returned invalid JSON") from exc

    if payload.get("error"):
        raise HTTPException(status_code=502, detail=f"Aviationstack error: {payload['error']}")

    cached_at = _write_cache_file(payload)
    return payload, cached_at


def _extract_airline_name(item: dict[str, Any]) -> str:
    return str((item.get("airline") or {}).get("name") or "").strip()


def _extract_destination_iata(item: dict[str, Any]) -> str:
    return str((item.get("arrival") or {}).get("iata") or "").strip()


def _extract_destination_text(item: dict[str, Any]) -> str:
    arrival = item.get("arrival") or {}
    city = str(arrival.get("timezone") or "")
    airport = str(arrival.get("airport") or "")
    return f"{city} {airport}".strip()


def _clean_result(item: dict[str, Any]) -> dict[str, Any]:
    airline = item.get("airline") or {}
    flight = item.get("flight") or {}
    departure = item.get("departure") or {}
    arrival = item.get("arrival") or {}
    timezone_value = str(arrival.get("timezone") or "")
    city_guess = timezone_value.split("/")[-1].replace("_", " ") if timezone_value else None
    return {
        "airline": airline.get("name"),
        "flight_number": flight.get("iata") or flight.get("number"),
        "departure_airport": departure.get("airport"),
        "destination_airport": arrival.get("airport"),
        "destination_city": city_guess,
        "scheduled_departure": departure.get("scheduled"),
        "terminal": departure.get("terminal"),
        "gate": departure.get("gate"),
        "flight_status": item.get("flight_status"),
    }


def _extract_flight_number(item: dict[str, Any]) -> str:
    flight = item.get("flight") or {}
    return str(flight.get("iata") or flight.get("number") or "").strip().upper().replace(" ", "")


def _filter_flights(
    flights: list[dict[str, Any]],
    airline: str | None,
    destination: str | None,
    flight_number: str | None = None,
) -> list[dict[str, Any]]:
    results = flights

    if flight_number:
        flight_q = flight_number.strip().upper().replace(" ", "")
        results = [f for f in results if flight_q in _extract_flight_number(f)]

    if airline:
        airline_q = airline.strip().lower()
        results = [f for f in results if airline_q in _extract_airline_name(f).lower()]

    if destination:
        destination_q = destination.strip()
        if len(destination_q) == 3 and destination_q.isalpha():
            iata_q = destination_q.upper()
            results = [f for f in results if _extract_destination_iata(f).upper() == iata_q]
        else:
            dest_q = destination_q.lower()
            results = [f for f in results if dest_q in _extract_destination_text(f).lower()]

    return [_clean_result(f) for f in results]


def _get_raw_flights(force_refresh: bool) -> tuple[dict[str, Any], str, str]:
    if not force_refresh:
        cached_payload = _read_cache_file()
        if cached_payload:
            cached_at = str(cached_payload["cached_at"])
            if _is_cache_valid(cached_at):
                return cached_payload["response"], "cache", cached_at

    live_payload, cached_at = _call_aviationstack()
    return live_payload, "live", cached_at


@app.get("/api/flights/search")
def search_flights(
    flight_number: str | None = Query(default=None),
    airline: str | None = Query(default=None),
    destination: str | None = Query(default=None),
    force_refresh: bool = Query(default=False),
):
    payload, source, cached_at = _get_raw_flights(force_refresh=force_refresh)
    flights = payload.get("data") or []

    if not isinstance(flights, list):
        raise HTTPException(status_code=502, detail="Invalid Aviationstack payload format")

    filtered = _filter_flights(
        flights,
        airline=airline,
        destination=destination,
        flight_number=flight_number,
    )

    return {
        "source": source,
        "cached_at": cached_at,
        "results": filtered,
    }


@app.get("/api/flights/refresh")
def refresh_flights_cache():
    payload, cached_at = _call_aviationstack()
    flights = payload.get("data") or []
    count = len(flights) if isinstance(flights, list) else 0
    return {
        "message": "Live Aviationstack data fetched and cache overwritten.",
        "cached_at": cached_at,
        "count": count,
    }


@app.post("/api/plan")
def plan_departure(req: PlanRequest):
    dep_dt, dep_assumptions = _parse_datetime(req.scheduled_departure)
    board_by = dep_dt - timedelta(minutes=_clamp_minutes(req.board_buffer_minutes, 0, 240))

    traffic_m, traffic_a = _estimate_traffic_minutes(req.origin, req.terminal)
    bag_m, bag_a = _estimate_bag_drop_minutes(req.checked_bags)
    # Security estimate is terminal-dependent if terminal is known.
    if req.terminal:
        base_sec = int(predictor.predict_wait(req.terminal))
        security_m = base_sec
        security_a = ["security_from_wait_time_model_predictor_terminal"]
        if req.tsa_precheck:
            security_m = max(3, int(round(security_m * 0.65)))
            security_a.append("security_precheck_multiplier_0_65")
        security_m = _clamp_minutes(security_m, 0, 240)
    else:
        security_m, security_a = _estimate_security_minutes(req.tsa_precheck)
    walk_m, walk_a = _estimate_walk_minutes(req.terminal, req.gate)
    risk_m, risk_a = _risk_buffer_minutes(req.risk_profile)

    total_m = int(traffic_m + bag_m + security_m + walk_m + risk_m)
    leave_by = board_by - timedelta(minutes=total_m)
    if dep_dt < _now_utc():
        dep_assumptions = [*dep_assumptions, "scheduled_departure_in_past"]

    return {
        "leave_by": leave_by.isoformat(),
        "board_by": board_by.isoformat(),
        "scheduled_departure": dep_dt.isoformat(),
        "total_minutes": total_m,
        "breakdown_minutes": {
            "traffic": traffic_m,
            "bag_drop": bag_m,
            "security": security_m,
            "walk": walk_m,
            "risk_buffer": risk_m,
        },
        "inputs": {
            "terminal": req.terminal,
            "gate": req.gate,
            "origin": req.origin,
            "tsa_precheck": req.tsa_precheck,
            "checked_bags": req.checked_bags,
            "board_buffer_minutes": req.board_buffer_minutes,
            "risk_profile": req.risk_profile,
        },
        "assumptions": [
            *dep_assumptions,
            *traffic_a,
            *bag_a,
            *security_a,
            *walk_a,
            *risk_a,
        ],
    }
