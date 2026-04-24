from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import exp
from io import StringIO
from typing import Any

import pandas as pd
import requests


CSV_URL = "https://docs.google.com/spreadsheets/d/1w4gNnAoM-0SEopHxZLREUj83DpPNAaj0YLwYEwvYVFk/export?format=csv"


@dataclass(frozen=True)
class TerminalWaitPrediction:
    terminal: str
    wait_minutes: int
    model_bucket: str | None = None
    last_observed_minutes: int | None = None
    last_observed_at: str | None = None
    refreshed_at: str | None = None


class WaitTimePredictor:
    """
    Beginner-readable in-memory wait predictor.

    Model:
    - Pulls CSV into pandas
    - Filters to Type == Security
    - Aggregates multiple rows per terminal + timestamp into a single wait value
    - Builds historical average by terminal + day-of-week + 15-minute slot
    - Blends that historical pattern with the most recent observed terminal wait
    - Refreshes itself in memory every 5 minutes
    """

    def __init__(self, csv_url: str = CSV_URL, refresh_seconds: int = 300):
        self.csv_url = csv_url
        self.refresh_seconds = int(refresh_seconds)
        self._lock = threading.RLock()

        # Model state (updated on refresh).
        self._hist_mean: dict[tuple[str, int, int], float] = {}
        self._last_obs: dict[str, tuple[datetime, float]] = {}
        self._last_refresh: datetime | None = None
        self._last_error: str | None = None

        # Start background refresh thread.
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._refresh_loop, name="wait_time_model_refresh", daemon=True)
        self._thread.start()
        # Do NOT block app startup on initial network fetch.
        # The background thread will populate the model shortly after startup.

    def close(self) -> None:
        self._stop_event.set()

    def refresh_now(self) -> None:
        try:
            df = self._load_csv()
            hist_mean, last_obs = self._build_model(df)
            with self._lock:
                self._hist_mean = hist_mean
                self._last_obs = last_obs
                self._last_refresh = datetime.now()
                self._last_error = None
        except Exception as exc:
            with self._lock:
                self._last_error = f"{type(exc).__name__}: {exc}"
                # Keep previous model if refresh fails.

    def predict_wait(self, terminal: str, outlook_minutes: int = 0) -> int:
        terminal_key = (terminal or "").strip().upper()[:1]
        if terminal_key not in {"A", "B", "C"}:
            terminal_key = terminal_key or "A"

        now = datetime.now()
        target = now + timedelta(minutes=int(outlook_minutes or 0))
        dow = int(target.weekday())  # 0=Mon
        slot = int((target.hour * 60 + target.minute) // 15)  # 0..95

        with self._lock:
            baseline = self._hist_mean.get((terminal_key, dow, slot))
            last = self._last_obs.get(terminal_key)
            refreshed_at = self._last_refresh

        # If we have no model yet, fall back to a calm default.
        if baseline is None and last is None:
            return 15

        # Baseline-only or last-only fallback.
        if baseline is None and last is not None:
            return int(round(max(0.0, last[1])))
        if baseline is not None and last is None:
            return int(round(max(0.0, baseline)))

        assert baseline is not None and last is not None

        last_at, last_minutes = last
        age_min = max(0.0, (now - last_at).total_seconds() / 60.0)

        # Recency-weighted blend:
        # - very recent observations influence more
        # - older observations fade out smoothly
        recency = float(exp(-age_min / 60.0)) if age_min >= 0 else 0.0  # decays smoothly with age
        w_last = min(0.45, 0.10 + 0.35 * recency)  # keep model dominant but responsive
        pred = (1.0 - w_last) * float(baseline) + w_last * float(last_minutes)

        # Clamp to a sensible range for airport waits.
        pred = max(0.0, min(180.0, pred))
        return int(round(pred))

    def predict_all_terminals(self, outlook_minutes: int = 0) -> dict[str, int]:
        return {t: self.predict_wait(t, outlook_minutes=outlook_minutes) for t in ("A", "B", "C")}

    def debug_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "last_refresh": self._last_refresh.isoformat() if self._last_refresh else None,
                "last_error": self._last_error,
                "hist_buckets": len(self._hist_mean),
                "last_observed_terminals": sorted(list(self._last_obs.keys())),
            }

    def _refresh_loop(self) -> None:
        # Small jitter to avoid thundering herd if multiple processes run.
        time.sleep(0.2)
        while not self._stop_event.is_set():
            self.refresh_now()
            self._stop_event.wait(self.refresh_seconds)

    def _load_csv(self) -> pd.DataFrame:
        # Use requests with a timeout so refresh can't hang forever.
        resp = requests.get(self.csv_url, timeout=20)
        resp.raise_for_status()
        df = pd.read_csv(StringIO(resp.text))

        # Drop totally empty or unnamed columns that appear in the export.
        df = df.loc[:, [c for c in df.columns if not str(c).startswith("Unnamed") and str(c).strip() != ""]]
        return df

    def _build_model(self, raw: pd.DataFrame) -> tuple[dict[tuple[str, int, int], float], dict[str, tuple[datetime, float]]]:
        df = raw.copy()

        # Filter to security rows only.
        df["Type"] = df["Type"].astype(str)
        df = df[df["Type"].str.strip().str.lower() == "security"]

        # Parse timestamp from Date + Time.
        dt = pd.to_datetime(df["Date"].astype(str).str.strip() + " " + df["Time"].astype(str).str.strip(), errors="coerce")
        df = df.assign(_dt=dt)
        df = df[df["_dt"].notna()]

        # Terminal letter.
        df["Terminal"] = df["Terminal"].astype(str).str.strip().str.upper().str[:1]
        df = df[df["Terminal"].isin(["A", "B", "C"])]

        # Wait minutes (coerce to numeric).
        df["_wait"] = pd.to_numeric(df["Wait Time (minute)"], errors="coerce")
        df = df[df["_wait"].notna()]

        # Aggregate multiple rows per terminal + timestamp into a single wait value.
        # (e.g. PreCheck + Regular lanes)
        agg = (
            df.groupby(["Terminal", "_dt"], as_index=False)["_wait"]
            .mean()
            .rename(columns={"_wait": "wait_minutes"})
        )

        # Last observed by terminal.
        last_obs: dict[str, tuple[datetime, float]] = {}
        for t in ["A", "B", "C"]:
            tdf = agg[agg["Terminal"] == t].sort_values("_dt")
            if not len(tdf):
                continue
            row = tdf.iloc[-1]
            last_obs[t] = (row["_dt"].to_pydatetime(), float(row["wait_minutes"]))

        # Historical mean by terminal + day-of-week + 15-min slot.
        agg["_dow"] = agg["_dt"].dt.weekday.astype(int)
        agg["_slot"] = ((agg["_dt"].dt.hour * 60 + agg["_dt"].dt.minute) // 15).astype(int)
        means = agg.groupby(["Terminal", "_dow", "_slot"])["wait_minutes"].mean()

        hist_mean: dict[tuple[str, int, int], float] = {(t, int(d), int(s)): float(v) for (t, d, s), v in means.items()}
        return hist_mean, last_obs


# Singleton predictor used by the API.
predictor = WaitTimePredictor()

