"""Synthetic export for tests and demos ONLY. It has a hidden ground-truth curve, so it can prove the
pipeline recovers a real signal. It must never be used to publish production forecasts."""
from __future__ import annotations

import numpy as np
import pandas as pd

from features import prior_profile


def _truth(weekday: int, hour: int, rainy: bool, shape: str) -> float:
    base = prior_profile(weekday, hour)
    if shape == "evening":
        base = base + (25 if 17 <= hour <= 21 else -10 if hour < 10 else 0)
    elif shape == "morning":
        base = base + (25 if 5 <= hour <= 9 else -12 if hour >= 18 else 0)
    if weekday in (5, 6):
        base += 5
    return float(np.clip(base - (12 if rainy else 0), 2, 98))


def simulate_export(n_gyms: int = 3, days: int = 70, seed: int = 7, tz: str = "Asia/Kolkata", arrivals_per_pct: float = 0.25) -> dict:
    """arrivals_per_pct: expected check-ins per hour per 1% of true crowd. Lower = noisier labels."""
    rng = np.random.default_rng(seed)
    end = pd.Timestamp.now(tz).floor("D").tz_localize(None)
    gyms = []
    for g in range(n_gyms):
        shape = ["evening", "morning", "mixed"][g % 3]
        arrivals, reports, sim_weather = [], [], []
        for d in range(days):
            day = end - pd.Timedelta(days=days - d)
            rainy = rng.random() < 0.2
            for hh in range(24):
                sim_weather.append({"ts": (day + pd.Timedelta(hours=hh)).strftime("%Y-%m-%dT%H:00:00"), "temp_c": 29.0, "precip_mm": 3.0 if rainy else 0.0})
            for hour in range(5, 23):
                truth = _truth(day.weekday(), hour, rainy, shape)
                ts = day + pd.Timedelta(hours=hour)
                n_arr = rng.poisson(max(0.2, truth * arrivals_per_pct))
                if n_arr:
                    arrivals.append({"hour": ts.strftime("%Y-%m-%dT%H:00:00"), "count": int(n_arr)})
                if rng.random() < 0.12:
                    obs = ts.tz_localize(tz).tz_convert("UTC") + pd.Timedelta(minutes=int(rng.integers(0, 59)))
                    reports.append({"observedAt": obs.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                                    "crowdPercent": float(np.clip(truth + rng.normal(0, 8), 0, 100))})
        gyms.append({"id": f"sim-gym-{g}", "name": f"Sim Gym {g}", "city": "Anand", "latitude": 22.55, "longitude": 72.95,
                     "timeZone": tz, "memberCount": 25, "openingHoursRaw": None, "arrivals": arrivals, "reports": reports,
                     "simWeather": sim_weather})  # simWeather: tests only (stands in for Open-Meteo)
    return {"generatedAt": pd.Timestamp.now("UTC").isoformat(), "sinceDays": days, "highCrowdThreshold": 60, "gyms": gyms}
