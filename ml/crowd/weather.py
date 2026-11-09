"""Open-Meteo (free, no API key, CC BY 4.0; free tier is for non-commercial use).
Failures are non-fatal: the model simply runs without weather signal."""
from __future__ import annotations

import pandas as pd
import requests

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
FORECAST = "https://api.open-meteo.com/v1/forecast"


def _frame(payload: dict) -> pd.DataFrame:
    h = payload.get("hourly") or {}
    return pd.DataFrame({
        "ts": pd.to_datetime(h.get("time", [])),
        "temp_c": h.get("temperature_2m", []),
        "precip_mm": h.get("precipitation", []),
    })


def fetch_weather(lat: float, lon: float, tz: str, start: str, end: str, timeout: int = 20, forecast_days: int = 0) -> pd.DataFrame:
    """Hourly local-time weather. `start`/`end` are YYYY-MM-DD. Returns empty frame on any error."""
    frames = []
    try:
        r = requests.get(ARCHIVE, params={"latitude": lat, "longitude": lon, "start_date": start, "end_date": end,
                                          "hourly": "temperature_2m,precipitation", "timezone": tz}, timeout=timeout)
        r.raise_for_status()
        frames.append(_frame(r.json()))
    except Exception as exc:
        print(f"[weather] archive unavailable: {exc}")
    if forecast_days:
        try:
            r = requests.get(FORECAST, params={"latitude": lat, "longitude": lon, "forecast_days": forecast_days,
                                               "hourly": "temperature_2m,precipitation", "timezone": tz}, timeout=timeout)
            r.raise_for_status()
            frames.append(_frame(r.json()))
        except Exception as exc:
            print(f"[weather] forecast unavailable: {exc}")
    if not frames:
        return pd.DataFrame(columns=["ts", "temp_c", "precip_mm"])
    return pd.concat(frames).drop_duplicates("ts", keep="last").reset_index(drop=True)
