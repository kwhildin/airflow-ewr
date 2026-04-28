import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"

FLIGHTVIEW_CACHE_FILE = DATA_DIR / "flights_cache_flightview.json"
FLIGHTVIEW_CACHE_TTL_MINUTES = 10

EWR_IATA = "EWR"


class FlightViewParseError(RuntimeError):
    pass


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _read_cache() -> dict[str, Any] | None:
    if not FLIGHTVIEW_CACHE_FILE.exists():
        return None
    try:
        return json.loads(FLIGHTVIEW_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_cache(results: list[dict[str, Any]], raw_count: int) -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cached_at = _now_utc().isoformat()
    payload = {
        "cached_at": cached_at,
        "raw_count": int(raw_count),
        "results": results,
    }
    FLIGHTVIEW_CACHE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return cached_at


def _is_cache_valid(cached_at_str: str) -> bool:
    try:
        cached_at = datetime.fromisoformat(cached_at_str)
    except ValueError:
        return False
    return (_now_utc() - cached_at) < timedelta(minutes=FLIGHTVIEW_CACHE_TTL_MINUTES)


def _normalize_scheduled(depdate_yyyymmdd: str, deptime_hhmm: str) -> str | None:
    """
    FlightView provides local airport date+time without timezone.
    Return a timezone-less ISO string so the browser formats it in local time.
    """
    depdate_yyyymmdd = (depdate_yyyymmdd or "").strip()
    deptime_hhmm = (deptime_hhmm or "").strip()
    if not (len(depdate_yyyymmdd) == 8 and depdate_yyyymmdd.isdigit()):
        return None
    if not (len(deptime_hhmm) in (3, 4) and deptime_hhmm.isdigit()):
        return None
    if len(deptime_hhmm) == 3:
        deptime_hhmm = "0" + deptime_hhmm
    y = int(depdate_yyyymmdd[0:4])
    m = int(depdate_yyyymmdd[4:6])
    d = int(depdate_yyyymmdd[6:8])
    hh = int(deptime_hhmm[0:2])
    mm = int(deptime_hhmm[2:4])
    try:
        return f"{y:04d}-{m:02d}-{d:02d}T{hh:02d}:{mm:02d}:00"
    except Exception:
        return None


# NOTE: Do NOT use a strict single-regex "match the whole row until closing tags".
# The FlightView HTML changes frequently and rows contain nested divs/anchors.
# Instead, we locate row start indices and slice until the next row start.
_ROW_START_RE = re.compile(
    r'<div\s+role="row"[^>]*class="[^"]*\bflight\b[^"]*"[^>]*>',
    flags=re.IGNORECASE,
)
_CELL_RE = re.compile(
    r'<div\s+role="cell"[^>]*class="[^"]*\bflightValue\b[^"]*\bc(?P<col>\d+)\b[^"]*"[^>]*>(?P<html>.*?)</div>',
    flags=re.IGNORECASE | re.DOTALL,
)
_STRIP_TAGS_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _text_from_html(fragment: str) -> str:
    if fragment is None:
        return ""
    # Keep &nbsp; semantics roughly by converting to space.
    fragment = (
        fragment.replace("\u00a0", " ")
        .replace("\ufffd", " ")
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
    )
    fragment = _STRIP_TAGS_RE.sub("", fragment)
    fragment = fragment.replace("\r", " ").replace("\n", " ")
    return _WS_RE.sub(" ", fragment).strip()


def _extract_airline_name(cell1_html: str) -> str | None:
    # <td id="ffAlLbl" class="ffAlLbl">Air France</td>
    m = re.search(r'class="ffAlLbl"\s*>\s*([^<]+)\s*<', cell1_html, flags=re.IGNORECASE)
    if m:
        return _text_from_html(m.group(1)) or None
    # fallback to all text
    t = _text_from_html(cell1_html)
    return t or None


def _extract_arrival_iata_from_onclick(row_html: str) -> str | None:
    # ffDtNm('fD','5925','AF','EWR','DTW','20260428','1259')
    m = re.search(
        r"ffDtNm\('fD','[^']+','[^']+','(?P<dep>[A-Z]{3})','(?P<arr>[A-Z]{3})','(?P<depdate>\d{8})','(?P<deptime>\d{3,4})'\)",
        row_html,
        flags=re.IGNORECASE,
    )
    if not m:
        return None
    return (m.group("arr") or "").upper().strip() or None


def _extract_dep_datetime_from_onclick(row_html: str) -> tuple[str | None, str | None]:
    m = re.search(
        r"ffDtNm\('fD','[^']+','[^']+','(?P<dep>[A-Z]{3})','(?P<arr>[A-Z]{3})','(?P<depdate>\d{8})','(?P<deptime>\d{3,4})'\)",
        row_html,
        flags=re.IGNORECASE,
    )
    if not m:
        return None, None
    return m.group("depdate"), m.group("deptime")


def _parse_terminal_gate(cell9_text: str) -> tuple[str | None, str | None]:
    """
    Examples seen: "Term. 4 - A12", "Term. C - 123", "Term. A - 23"
    """
    s = (cell9_text or "").strip()
    if not s:
        return None, None
    # Clean weird whitespace from HTML-to-text (often includes NBSP artifacts)
    s = _WS_RE.sub(" ", s.replace("\u00a0", " ")).strip()
    # Capture "Term. A - A30" OR "Term. B" (no gate) OR "Term. B - 42"
    # FlightView sometimes injects odd replacement characters between tokens, so be liberal:
    # Use ASCII alnum for robustness: replacement chars can be treated as "word" in Unicode regex.
    m = re.search(
        r"Term\.?[^A-Za-z0-9]*([A-Za-z0-9]+)(?:[^A-Za-z0-9]*-[^A-Za-z0-9]*([A-Za-z0-9]+))?",
        s,
        flags=re.IGNORECASE,
    )
    if not m:
        return None, None
    term = m.group(1).strip()
    gate = (m.group(2) or "").strip()
    return (term or None), (gate or None)


def _slice_flight_rows(html: str) -> list[str]:
    """
    Return HTML slices for each visible flight row.
    This avoids brittle nested-tag regex matching.
    """
    starts = [m.start() for m in _ROW_START_RE.finditer(html)]
    if not starts:
        return []
    slices: list[str] = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else len(html)
        slices.append(html[s:e])
    return slices


def parse_fids_departures_html(html: str) -> tuple[list[dict[str, Any]], int, list[str], list[dict[str, Any]]]:
    """
    Returns (normalized_results, raw_row_count, raw_row_text_snippets, parsed_preview).
    Normalized results match the backend's existing frontend contract.
    """
    if not html or "<div" not in html:
        raise FlightViewParseError("Empty or invalid HTML")

    rows = _slice_flight_rows(html)
    if not rows:
        raise FlightViewParseError("No flight rows found (parser pattern mismatch)")

    raw_snips = [_text_from_html(r)[:220] for r in rows[:20]]

    results: list[dict[str, Any]] = []
    for row_html in rows:
        cells = {int(m.group("col")): m.group("html") for m in _CELL_RE.finditer(row_html)}
        airline = _extract_airline_name(cells.get(1, ""))  # Airline name
        flight_number = _text_from_html(cells.get(3, "")) or None  # e.g. "AF5925"
        destination_city = _text_from_html(cells.get(4, "")) or None
        status = _text_from_html(cells.get(5, "")) or _text_from_html(cells.get(8, "")) or None

        depdate, deptime = _extract_dep_datetime_from_onclick(row_html)
        scheduled_departure = _normalize_scheduled(depdate or "", deptime or "")

        destination_airport = _extract_arrival_iata_from_onclick(row_html)

        term_gate_text = _text_from_html(cells.get(9, ""))
        terminal, gate = _parse_terminal_gate(term_gate_text)

        results.append(
            {
                "airline": airline,
                "flight_number": flight_number,
                "departure_airport": EWR_IATA,
                "destination_airport": destination_airport,
                "destination_city": destination_city,
                "scheduled_departure": scheduled_departure,
                "terminal": terminal,
                "gate": gate,
                "flight_status": status,
            }
        )

    preview = results[:20]
    return results, len(rows), raw_snips, preview


def fetch_ewr_departures(force_refresh: bool = False) -> dict[str, Any]:
    """
    Fetch EWR departures from FlightView FIDS.

    Returns:
      {
        "source": "official_ewr",
        "cache": "cache" | "live",
        "cached_at": "<iso>",
        "raw_count": <int>,
        "results": [ normalized flight objects ... ],
      }
    """
    cached = _read_cache()
    if not force_refresh and cached and _is_cache_valid(str(cached.get("cached_at") or "")):
        return {
            "source": "official_ewr",
            "cache": "cache",
            "cached_at": str(cached["cached_at"]),
            "raw_count": int(cached.get("raw_count") or 0),
            "results": list(cached.get("results") or []),
        }

    url = (
        "https://tracker.flightview.com/FVAccess3/tools/fids/fidsDefault.asp"
        "?accCustId=PANYNJ&fidsId=20001&fidsInit=departures&fidsApt=EWR"
    )

    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": os.getenv("FLIGHTVIEW_USER_AGENT", "Mozilla/5.0"),
        "Referer": os.getenv(
            "FLIGHTVIEW_REFERER",
            "https://tracker.flightview.com/CustomerSetup/panynj/customweb/?apt=EWR&view=VIEW_DEPARTURE",
        ),
    }

    cookies = {}
    affinity = (os.getenv("FLIGHTVIEW_AFFINITY_CORS") or "").strip()
    if affinity:
        cookies["ApplicationGatewayAffinityCORS"] = affinity

    try:
        resp = requests.get(url, headers=headers, cookies=cookies, timeout=25)
    except requests.RequestException as exc:
        raise RuntimeError(f"FlightView request failed: {exc}") from exc

    if resp.status_code != 200:
        raise RuntimeError(f"FlightView returned HTTP {resp.status_code}")

    results, raw_count, raw_snips, preview = parse_fids_departures_html(resp.text)
    print(f"[flightview] html_len={len(resp.text)} rows_found={raw_count}")
    if raw_snips:
        print("[flightview] first_20_raw_row_text=")
        for i, s in enumerate(raw_snips, start=1):
            print(f"  {i:02d}. {s}")
    if preview:
        print("[flightview] first_20_parsed=")
        for i, f in enumerate(preview, start=1):
            print(
                f"  {i:02d}. airline={f.get('airline')} flight_number={f.get('flight_number')} "
                f"dest={f.get('destination_airport') or f.get('destination_city')} "
                f"scheduled={f.get('scheduled_departure')} term={f.get('terminal')} gate={f.get('gate')} "
                f"status={f.get('flight_status')}",
            )

    cached_at = _write_cache(results=results, raw_count=raw_count)
    return {
        "source": "official_ewr",
        "cache": "live",
        "cached_at": cached_at,
        "raw_count": raw_count,
        "results": results,
    }

