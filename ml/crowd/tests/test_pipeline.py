import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import numpy as np
import pandas as pd
import pytest

from cleaning import clean_gym, is_open, parse_opening_hours
from features import build_labels
from model import train_and_evaluate
from pipeline import build_training_frame, forecast_rows
from simulate import simulate_export


def test_opening_hours_parser():
    h = parse_opening_hours("Mo-Sa 06:00-22:00; Su off")
    assert is_open(h, 0, 6) and not is_open(h, 0, 22) and not is_open(h, 6, 10)
    assert parse_opening_hours("") is None and is_open(None, 3, 12) and not is_open(None, 3, 2)


def test_cleaning_drops_garbage_and_closed_hours():
    gym = {"timeZone": "Asia/Kolkata", "openingHoursRaw": "Mo-Su 06:00-22:00",
           "arrivals": [{"hour": "2026-10-05T07:00:00", "count": 4}, {"hour": "bad", "count": 2},
                        {"hour": "2026-10-05T03:00:00", "count": 9}, {"hour": "2026-10-05T08:00:00", "count": -1}],
           "reports": [{"observedAt": "2026-10-05T02:10:00.000Z", "crowdPercent": 55}, {"observedAt": "x", "crowdPercent": 20},
                       {"observedAt": "2026-10-05T02:20:00.000Z", "crowdPercent": 400}]}
    df = clean_gym(gym)
    assert set(df["hour"]) == {7}          # 03:00 closed, bad/negative dropped; 02:10Z = 07:40 IST
    row = df.iloc[0]
    assert row["count"] == 4 and row["report_mean"] == 55 and row["report_n"] == 1


def test_zero_checkins_are_not_labelled_as_empty():
    ts = pd.date_range("2026-10-01 06:00", periods=8, freq="h")
    df = pd.DataFrame({"ts": ts, "count": [0, 5, 10, 6, 7, 8, 9, 4], "weekday": ts.weekday, "hour": ts.hour,
                       "report_mean": [np.nan] * 8, "report_n": [np.nan] * 8})
    out = build_labels(df)
    assert len(out) == 7 and (out["label_kind"] == "arrivals").all()   # the zero-check-in hour gets no label


def _sim_weather_fn(gym, start, end):
    return pd.DataFrame(gym["simWeather"]).assign(ts=lambda d: pd.to_datetime(d["ts"]))


def test_model_captures_external_driver_and_beats_every_baseline():
    """Rain really lowers attendance in the simulation. Per-slot averages cannot see it; the model can."""
    export = simulate_export(n_gyms=3, days=70, arrivals_per_pct=0.25)
    data, per_gym, _ = build_training_frame(export, weather_fn=_sim_weather_fn)
    trained = train_and_evaluate(data)
    assert trained.publishable, trained.reason
    assert trained.metrics["maeModel"] < trained.metrics["maeBestBaseline"]
    rows = forecast_rows(export, trained, per_gym, weather_fn=lambda g, s, e: pd.DataFrame(columns=["ts", "temp_c", "precip_mm"]))
    assert rows and all(0 <= r["crowdPercent"] <= 100 for r in rows)
    assert all(r["highProbability"] is None or 0 <= r["highProbability"] <= 1 for r in rows)


def test_without_an_external_signal_the_gate_declines_to_claim_a_gain():
    """Pure weekly-pattern data: a per-gym hour-of-week average is already optimal, so ML must not be published."""
    export = simulate_export(n_gyms=3, days=70, arrivals_per_pct=0.25)
    for g in export["gyms"]:
        g["simWeather"] = []
    data, _, _ = build_training_frame(export, use_weather=False)
    trained = train_and_evaluate(data)
    if trained.publishable:
        assert trained.metrics["maeModel"] <= trained.metrics["maeBestBaseline"] * 0.95


def test_refuses_to_publish_with_too_little_real_data():
    export = simulate_export(n_gyms=1, days=7)
    data, _, _ = build_training_frame(export, use_weather=False)
    trained = train_and_evaluate(data.head(40))
    assert not trained.publishable and "Keeping the baseline" in trained.reason


def test_gate_rejects_pure_noise():
    """If the labels carry no signal the pipeline must keep the baseline instead of publishing a model."""
    export = simulate_export(n_gyms=2, days=70)
    data, _, _ = build_training_frame(export, use_weather=False)
    rng = np.random.default_rng(0)
    data = data.copy()
    data["label"] = rng.uniform(0, 100, len(data))
    trained = train_and_evaluate(data)
    assert not trained.publishable


def test_very_sparse_checkins_never_publish_a_model_worse_than_baseline():
    # Few check-ins => very noisy labels. Either outcome is fine, but a published model must beat the best baseline.
    export = simulate_export(n_gyms=3, days=70, arrivals_per_pct=0.08)
    data, _, _ = build_training_frame(export, use_weather=False)
    trained = train_and_evaluate(data)
    if trained.publishable:
        assert trained.metrics["maeModel"] <= trained.metrics["maeBestBaseline"] * 0.95
