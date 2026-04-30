"""
Google Routes API helpers (server-side).

We call `computeRoutes` with a *future* `departureTime` so Google returns a
traffic-aware duration for that departure instant (not "leave now").
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import requests

ROUTES_COMPUTE_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"


def _lat_lng(lat: float, lng: float) -> dict[str, Any]:
    return {"location": {"latLng": {"latitude": lat, "longitude": lng}}}


# Newark Liberty International Airport — routing endpoints for drive-time + Maps parity.
# Coordinates are approximate map pins (garages / terminal arrival areas); good enough for Routes API.
DESTINATION_BY_KEY: dict[str, dict[str, Any]] = {
    # Generic airport centroid (fallback when terminal unknown).
    "ewr": _lat_lng(40.6895, -74.1745),
    # Parking structures / economy lots (matches frontend lot ids).
    "p1_short_term_a": _lat_lng(40.6905, -74.1778),
    "p2_short_term_b": _lat_lng(40.6898, -74.1769),
    "p3_short_term_c": _lat_lng(40.6970, -74.1810),
    "p4_daily": _lat_lng(40.6942, -74.1845),
    "p6_economy": _lat_lng(40.6956, -74.1690),
    # Departures / terminal curb when not parking on-site.
    "terminal_a": _lat_lng(40.6910, -74.1775),
    "terminal_b": _lat_lng(40.6897, -74.1770),
    "terminal_c": _lat_lng(40.6972, -74.1813),
}

ALLOWED_DESTINATION_KEYS = frozenset(DESTINATION_BY_KEY.keys())


def _require_api_key() -> str:
    # Intentionally separate from other keys: you can scope/restrict differently in GCP.
    import os

    key = (os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_ROUTES_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("Missing GOOGLE_MAPS_API_KEY (or GOOGLE_ROUTES_API_KEY) in environment.")
    return key


def _normalize_departure_time(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _destination_waypoint(destination_key: str) -> dict[str, Any]:
    key = (destination_key or "ewr").strip().lower()
    if key not in ALLOWED_DESTINATION_KEYS:
        key = "ewr"
    return DESTINATION_BY_KEY[key]


def _origin_waypoint(*, origin_address: str | None, origin_place_id: str | None) -> dict[str, Any]:
    place_id = (origin_place_id or "").strip()
    address = (origin_address or "").strip()
    if place_id:
        return {"placeId": place_id}
    if address:
        return {"address": address}
    raise ValueError("Origin is empty. Provide origin_place_id and/or origin_address.")


def _parse_route_duration_seconds(route: dict[str, Any]) -> int:
    """
    Routes API v2 returns `duration` as a string like "1234s" for route legs.
    """
    duration = route.get("duration")
    if isinstance(duration, str) and duration.endswith("s"):
        return max(0, int(float(duration[:-1])))
    if isinstance(duration, dict):
        # Defensive: some surfaces return a proto JSON representation.
        secs = duration.get("seconds")
        if isinstance(secs, str) and secs.isdigit():
            return int(secs)
        if isinstance(secs, (int, float)):
            return max(0, int(secs))
    raise ValueError(f"Unrecognized duration format: {duration!r}")


def compute_drive_route(
    *,
    origin_address: str | None,
    origin_place_id: str | None,
    departure_time: datetime,
    destination_key: str = "ewr",
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    """
    Returns a small dict useful for JSON responses:
    - duration_seconds
    - drive_minutes (rounded up)
    - distance_meters (optional)
    - destination (normalized key: ewr, parking lot id, terminal_a|b|c, …)
    """
    api_key = _require_api_key()
    departure_dt = _normalize_departure_time(departure_time)

    dest_key = (destination_key or "ewr").strip().lower()
    if dest_key not in ALLOWED_DESTINATION_KEYS:
        dest_key = "ewr"

    body: dict[str, Any] = {
        "origin": _origin_waypoint(origin_address=origin_address, origin_place_id=origin_place_id),
        "destination": _destination_waypoint(dest_key),
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE_OPTIMAL",
        "departureTime": departure_dt.isoformat(),
    }

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        # Keep the response tiny: we only need duration (+ distance if available).
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    }

    resp = requests.post(ROUTES_COMPUTE_URL, headers=headers, json=body, timeout=timeout_seconds)
    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"Routes API returned non-JSON (HTTP {resp.status_code}).") from exc

    if resp.status_code != 200:
        err = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(f"Routes API error HTTP {resp.status_code}: {err or payload}")

    routes = payload.get("routes") if isinstance(payload, dict) else None
    if not isinstance(routes, list) or not routes:
        raise RuntimeError("Routes API returned no routes.")

    route0 = routes[0]
    if not isinstance(route0, dict):
        raise RuntimeError("Routes API returned an unexpected route object.")

    seconds = _parse_route_duration_seconds(route0)
    minutes = max(1, int((seconds + 59) // 60))
    distance_meters = route0.get("distanceMeters")
    distance_out = int(distance_meters) if isinstance(distance_meters, (int, float)) else None

    return {
        "duration_seconds": seconds,
        "drive_minutes": minutes,
        "distance_meters": distance_out,
        "destination": dest_key,
        "departure_time": departure_dt.isoformat(),
    }
