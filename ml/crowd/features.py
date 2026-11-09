"""Feature engineering + label construction (all open data / first-party)."""
from __future__ import annotations

import numpy as np
import pandas as pd

HIGH_THRESHOLD = 60.0

try:  # offline calendar, MIT licensed
    import holidays as _holidays
except Exception:  # pragma: no cover
    _holidays = None


def prior_profile(weekday: int, hour: int) -> float:
    """Same hand-made hourly prior the API uses on cold start (kept in sync with intelligence.ts)."""
    weekend = weekday in (5, 6)
    if weekend:
        return 58 if 8 <= hour <= 11 else 48 if 16 <= hour <= 19 else 35 if 12 <= hour <= 15 else 22
    return (62 if 6 <= hour <= 8 else 72 if 17 <= hour <= 20 else 42 if 9 <= hour <= 11
            else 28 if 12 <= hour <= 16 else 38 if 21 <= hour <= 22 else 18)


def build_labels(df: pd.DataFrame) -> pd.DataFrame:
    """Real labels only.

    * member reports (0-100)           -> used directly, weight 3 per report (capped)
    * check-in arrivals                -> relative demand: 100 * count / gym p95 of non-zero hours
    Arrivals are a proxy (check-in is optional, once a day) so they get a lower weight.
    """
    out = df.copy()
    nz = out.loc[out["count"] > 0, "count"]
    p95 = float(nz.quantile(0.95)) if len(nz) >= 5 else np.nan
    arrivals_label = (100.0 * out["count"] / p95).clip(0, 100) if np.isfinite(p95) and p95 > 0 else pd.Series(np.nan, index=out.index)
    arrivals_label = arrivals_label.where(out["count"] > 0)  # zero check-ins != empty gym, so no label
    # Arrivals only say "busier / quieter than usual here", not an absolute percentage. Anchor their *level* to the
    # prior's average for the same hours and let the data decide the *shape*. Reports (absolute) are left untouched.
    if arrivals_label.notna().sum():
        prior = pd.Series([prior_profile(int(w), int(h)) for w, h in zip(out["weekday"], out["hour"])], index=out.index)
        mask = arrivals_label.notna()
        scale = float(np.clip(prior[mask].mean() / max(arrivals_label[mask].mean(), 1e-6), 0.5, 3.0))
        arrivals_label = (arrivals_label * scale).clip(0, 100)
    out["label"] = out["report_mean"].where(out["report_mean"].notna(), arrivals_label)
    out["label_kind"] = np.where(out["report_mean"].notna(), "report", np.where(arrivals_label.notna(), "arrivals", "none"))
    out["weight"] = np.where(out["label_kind"] == "report", np.minimum(3.0, 1.0 + out["report_n"].fillna(0)), np.where(out["label_kind"] == "arrivals", 1.0, 0.0))
    return out[out["label_kind"] != "none"].copy()


def _holiday_calendar(country: str = "IN"):
    return _holidays.country_holidays(country) if _holidays else {}


def add_features(df: pd.DataFrame, weather: pd.DataFrame | None, country: str = "IN") -> pd.DataFrame:
    out = df.copy()
    out["hour_sin"] = np.sin(2 * np.pi * out["hour"] / 24)
    out["hour_cos"] = np.cos(2 * np.pi * out["hour"] / 24)
    out["dow_sin"] = np.sin(2 * np.pi * out["weekday"] / 7)
    out["dow_cos"] = np.cos(2 * np.pi * out["weekday"] / 7)
    out["is_weekend"] = (out["weekday"] >= 5).astype(int)
    cal = _holiday_calendar(country)
    out["is_holiday"] = [int(d.date() in cal) for d in out["ts"]]
    out["prior"] = [prior_profile(int(w), int(h)) for w, h in zip(out["weekday"], out["hour"])]
    if weather is not None and len(weather):
        out = out.merge(weather, on="ts", how="left")
    for col, default in (("temp_c", 28.0), ("precip_mm", 0.0)):
        if col not in out:
            out[col] = default
        out[col] = out[col].fillna(out[col].median() if out[col].notna().any() else default)
    out["is_rainy"] = (out["precip_mm"] >= 1.0).astype(int)
    return out


# gym_code lets the pooled model learn each gym's own shape (e.g. morning-heavy vs evening-heavy);
# unseen gyms get -1 (treated as missing) and fall back to the shared pattern.
FEATURES = ["hour_sin", "hour_cos", "dow_sin", "dow_cos", "is_weekend", "is_holiday", "temp_c", "precip_mm", "is_rainy", "prior", "gym_code"]
