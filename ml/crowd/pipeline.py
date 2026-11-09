#!/usr/bin/env python3
"""FitOS crowd-prediction pipeline:  extract -> clean -> features -> train -> evaluate -> gate -> publish.

  python pipeline.py --api https://adaptive-fit-api.onrender.com            # real run (needs GYM_ML_PIPELINE_KEY)
  python pipeline.py --input export.json --dry-run                           # offline
  python pipeline.py --simulate --dry-run                                    # demo on synthetic data (never published)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

from cleaning import CleanReport, clean_gym, is_open, parse_opening_hours
from features import FEATURES, HIGH_THRESHOLD, add_features, build_labels
from model import Trained, confidence_for, train_and_evaluate
from weather import fetch_weather


def extract(api: str, key: str, days: int) -> dict:
    r = requests.get(f"{api.rstrip('/')}/gym/ml/export", params={"days": days}, headers={"x-gym-ml-key": key}, timeout=90)
    r.raise_for_status()
    return r.json()


def build_training_frame(export: dict, use_weather: bool = True, weather_fn=None) -> tuple[pd.DataFrame, dict, CleanReport]:
    weather_fn = weather_fn or (lambda gym, start, end: fetch_weather(gym["latitude"], gym["longitude"], gym.get("timeZone") or "Asia/Kolkata", start, end))
    report, frames, per_gym = CleanReport(), [], {}
    for gym in export.get("gyms", []):
        df = clean_gym(gym, report)
        if df.empty:
            continue
        labelled = build_labels(df)
        if labelled.empty:
            continue
        weather = None
        if use_weather and gym.get("latitude") is not None and gym.get("longitude") is not None:
            weather = weather_fn(gym, labelled["ts"].min().strftime("%Y-%m-%d"), labelled["ts"].max().strftime("%Y-%m-%d"))
        labelled = add_features(labelled, weather)
        labelled["gym_id"] = gym["id"]
        per_gym[gym["id"]] = int(len(labelled))
        frames.append(labelled)
    data = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    return data, per_gym, report


def forecast_rows(export: dict, trained: Trained, per_gym: dict, use_weather: bool = True, horizon_days: int = 7, weather_fn=None) -> list[dict]:
    weather_fn = weather_fn or (lambda gym, start, end: fetch_weather(gym["latitude"], gym["longitude"], gym.get("timeZone") or "Asia/Kolkata", start, end, forecast_days=horizon_days))
    rows = []
    for gym in export.get("gyms", []):
        tz = gym.get("timeZone") or "Asia/Kolkata"
        hours = parse_opening_hours(gym.get("openingHoursRaw"))
        start = pd.Timestamp.now(tz).floor("h").tz_localize(None)
        stamps = [start.floor("D") + pd.Timedelta(days=d, hours=h) for d in range(horizon_days) for h in range(24)]
        stamps = [t for t in stamps if t > start and is_open(hours, t.weekday(), t.hour)]
        if not stamps:
            continue
        frame = pd.DataFrame({"ts": stamps})
        frame["weekday"], frame["hour"] = frame["ts"].dt.weekday, frame["ts"].dt.hour
        weather = None
        if use_weather and gym.get("latitude") is not None and gym.get("longitude") is not None:
            weather = weather_fn(gym, start.strftime("%Y-%m-%d"), stamps[-1].strftime("%Y-%m-%d"))
        frame = add_features(frame, weather)
        frame["gym_code"] = trained.gym_index.get(gym["id"], -1)
        pct = np.clip(trained.regressor.predict(frame[FEATURES]), 0, 100)
        hc = trained.metrics.get("highCrowd") or {}
        classifier_ok = trained.classifier is not None and hc.get("f1", 0) >= hc.get("f1Prior", 1)  # only trust it if it beat the baseline
        proba = trained.classifier.predict_proba(frame[FEATURES])[:, 1] if classifier_ok else [None] * len(frame)
        conf = confidence_for(per_gym.get(gym["id"], 0))
        for ts, p, q in zip(frame["ts"], pct, proba):
            rows.append({"gymId": gym["id"], "predictedFor": ts.strftime("%Y-%m-%dT%H:00:00"),
                         "crowdPercent": round(float(p), 1), "highProbability": None if q is None else round(float(q), 3),
                         "confidence": conf})
    return rows


def publish(api: str, key: str, version: str, trained: Trained, rows: list[dict]) -> None:
    for i in range(0, len(rows), 4000):
        r = requests.post(f"{api.rstrip('/')}/gym/ml/predictions", headers={"x-gym-ml-key": key}, timeout=120, json={
            "modelVersion": version, "trainedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "metrics": trained.metrics, "predictions": rows[i:i + 4000]})
        r.raise_for_status()
        print(f"[publish] {r.json()}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.getenv("FITOS_API_URL"))
    ap.add_argument("--input", help="Use a saved export JSON instead of calling the API")
    ap.add_argument("--simulate", action="store_true", help="Synthetic demo data; implies --dry-run")
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-weather", action="store_true")
    ap.add_argument("--save-export", help="Write the raw export to this path")
    args = ap.parse_args(argv)
    key = os.getenv("GYM_ML_PIPELINE_KEY", "")

    if args.simulate:
        from simulate import simulate_export
        export, args.dry_run = simulate_export(), True
        print("[demo] SYNTHETIC data - results prove the pipeline works, they say nothing about real gyms.")
    elif args.input:
        export = json.load(open(args.input))
    else:
        if not args.api or not key:
            print("Set --api/FITOS_API_URL and GYM_ML_PIPELINE_KEY (or use --input / --simulate).", file=sys.stderr)
            return 2
        export = extract(args.api, key, args.days)
    if args.save_export:
        json.dump(export, open(args.save_export, "w"))

    data, per_gym, report = build_training_frame(export, use_weather=not args.no_weather)
    print(f"[clean] gyms={len(export.get('gyms', []))} labelled_hours={len(data)} reports(raw/dropped)="
          f"{report.raw_reports}/{report.dropped_reports} arrival_rows(raw/dropped)={report.raw_arrival_rows}/{report.dropped_arrival_rows}")
    trained = train_and_evaluate(data) if len(data) else Trained(None, None, {}, {"labelledRows": 0}, False, "No labelled data yet.")
    print("[evaluate]", json.dumps(trained.metrics, indent=2, default=str))
    print(f"[gate] publishable={trained.publishable} - {trained.reason}")
    if not trained.publishable:
        return 0  # not an error: the API keeps serving its baseline forecast
    rows = forecast_rows(export, trained, per_gym, use_weather=not args.no_weather)
    version = "ml-hgb-" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    print(f"[forecast] {len(rows)} gym-hours, version {version}")
    if args.dry_run:
        print("[dry-run] not publishing. Sample:", rows[:3])
        return 0
    publish(args.api, key, version, trained, rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
