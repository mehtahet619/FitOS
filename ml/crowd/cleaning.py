"""Turn the raw API export into one clean hourly table per gym.

Raw inputs (all first-party, anonymised):
  * arrivals : check-ins per gym-hour (a *demand proxy*, not occupancy)
  * reports  : members' "how crowded is it now" answers (0-100)
Cleaning steps: parse + validate timestamps, drop duplicates / impossible values,
clip outliers, aggregate to local-hour buckets, drop hours the gym is closed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

ASSUMED_OPEN, ASSUMED_CLOSE = 5, 23  # mirrors the API when OSM has no opening_hours

_DAYS = {"Mo": 0, "Tu": 1, "We": 2, "Th": 3, "Fr": 4, "Sa": 5, "Su": 6}


def parse_opening_hours(raw: str | None) -> dict[int, list[tuple[int, int]]] | None:
    """Tiny OSM opening_hours parser: 'Mo-Sa 06:00-22:00; Su 08:00-14:00'. Returns weekday(Mon=0)->[(start_h,end_h)]."""
    if not raw or not raw.strip():
        return None
    raw = raw.strip()
    if raw == "24/7":
        return {d: [(0, 24)] for d in range(7)}
    out: dict[int, list[tuple[int, int]]] = {}
    for clause in (c.strip() for c in raw.split(";") if c.strip()):
        m = re.search(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})", clause)
        selector = clause[: m.start()].strip() if m else clause
        days: set[int] = set()
        for tok in selector.replace(",", " ").split():
            a, _, b = tok.partition("-")
            if a in _DAYS and (b in _DAYS or not b):
                s, e = _DAYS[a], _DAYS[b or a]
                d = s
                for _ in range(7):
                    days.add(d)
                    if d == e:
                        break
                    d = (d + 1) % 7
        if not days and not selector:
            days = set(range(7))
        if re.search(r"\b(off|closed)\b", clause, re.I):
            for d in days:
                out[d] = []
            continue
        if not m:
            continue
        start, end = int(m.group(1)), int(m.group(3))
        if end == 0 or end <= start:
            end = 24  # overnight spans are clipped to midnight; good enough for hourly buckets
        for d in days:
            out.setdefault(d, []).append((start, end))
    return out or None


def is_open(hours: dict[int, list[tuple[int, int]]] | None, weekday: int, hour: int) -> bool:
    if hours is None:
        return ASSUMED_OPEN <= hour < ASSUMED_CLOSE
    return any(s <= hour < e for s, e in hours.get(weekday, []))


@dataclass
class CleanReport:
    raw_reports: int = 0
    dropped_reports: int = 0
    raw_arrival_rows: int = 0
    dropped_arrival_rows: int = 0
    labelled_hours: int = 0


def _to_hour_index(values: pd.Series) -> pd.Series:
    return pd.to_datetime(values, format="%Y-%m-%dT%H:%M:%S", errors="coerce")


def clean_gym(gym: dict, report: CleanReport | None = None) -> pd.DataFrame:
    """Returns rows: ts (local naive hour), weekday, hour, arrivals, report_mean, report_n, open."""
    report = report or CleanReport()
    hours = parse_opening_hours(gym.get("openingHoursRaw"))

    arr = pd.DataFrame(gym.get("arrivals") or [], columns=["hour", "count"])
    report.raw_arrival_rows += len(arr)
    arr["ts"] = _to_hour_index(arr["hour"])
    arr["count"] = pd.to_numeric(arr["count"], errors="coerce")
    bad = arr["ts"].isna() | arr["count"].isna() | (arr["count"] < 0)
    report.dropped_arrival_rows += int(bad.sum())
    arr = arr[~bad].groupby("ts", as_index=False)["count"].sum()
    # A single hour with a huge count is almost certainly a bot / test; clip at p99.
    if len(arr) >= 20:
        arr["count"] = arr["count"].clip(upper=arr["count"].quantile(0.99))

    rep = pd.DataFrame(gym.get("reports") or [], columns=["observedAt", "crowdPercent"])
    report.raw_reports += len(rep)
    rep["crowdPercent"] = pd.to_numeric(rep["crowdPercent"], errors="coerce")
    rep["observed"] = pd.to_datetime(rep["observedAt"], utc=True, errors="coerce")
    bad = rep["observed"].isna() | ~rep["crowdPercent"].between(0, 100)
    report.dropped_reports += int(bad.sum())
    rep = rep[~bad].copy()
    if len(rep):
        tz = gym.get("timeZone") or "Asia/Kolkata"
        rep["ts"] = rep["observed"].dt.tz_convert(tz).dt.tz_localize(None).dt.floor("h")
        rep = rep.groupby("ts", as_index=False).agg(report_mean=("crowdPercent", "mean"), report_n=("crowdPercent", "size"))
    else:
        rep = pd.DataFrame({"ts": pd.to_datetime([]), "report_mean": [], "report_n": []})

    df = arr.merge(rep, on="ts", how="outer").sort_values("ts").reset_index(drop=True)
    if df.empty:
        return df.assign(weekday=[], hour=[], open=[])
    df["weekday"] = df["ts"].dt.weekday
    df["hour"] = df["ts"].dt.hour
    df["open"] = [is_open(hours, int(w), int(h)) for w, h in zip(df["weekday"], df["hour"])]
    df = df[df["open"]].copy()  # activity while "closed" means our hours are wrong; don't learn from it
    df["count"] = df["count"].fillna(0.0)
    report.labelled_hours += len(df)
    return df
