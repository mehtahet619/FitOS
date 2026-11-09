# FitOS crowd-prediction pipeline

Open-source, no Google APIs. `extract -> clean -> features -> train -> evaluate -> gate -> publish`

| Stage | File | What it does |
|---|---|---|
| Extract | `pipeline.py` | `GET /gym/ml/export`: anonymised hourly check-in counts + member crowd reports per gym (no user ids) |
| Clean | `cleaning.py` | validates timestamps, drops duplicates/impossible values, clips outliers, converts to the gym's local hour, drops hours the gym is closed |
| Features | `features.py`, `weather.py` | hour/day cycles, weekend, Indian holidays (`holidays`, offline), temperature + rain (Open-Meteo, free, non-commercial tier), per-gym code, hand-made prior |
| Train | `model.py` | HistGradientBoosting regressor (crowd %) + classifier (high crowd = 60%+) |
| Evaluate | `model.py` | last 14 days held out; compared with the prior, each gym's own hour-of-week average, and a constant |
| Gate | `model.py` | publishes only if MAE beats the best baseline by 5%; the classifier is only used if its F1 beats the baseline |
| Publish | `pipeline.py` | `POST /gym/ml/predictions`; the API blends them into `/gym/:id/forecast` (`source: "ml"`, `isHighCrowd`) |

If the gate fails, nothing is published and the API keeps serving its baseline forecast. That is intentional.

## Run
```bash
pip install -r requirements.txt
export GYM_ML_PIPELINE_KEY=...   # same value as on the API service
python pipeline.py --api https://adaptive-fit-api.onrender.com
python pipeline.py --simulate --no-weather      # demo on synthetic data, never published
pytest tests
```
Set `GYM_ML_PIPELINE_KEY` on the Render API service too. The nightly GitHub Action needs repo secrets `FITOS_API_URL` and `GYM_ML_PIPELINE_KEY`.

## What the data can and cannot tell you
Labels come only from FitOS itself: member reports (absolute 0-100) and check-ins (relative demand; check-in is once a day and optional, so it is a noisy proxy). Weather, holidays and per-gym patterns help only once there is enough data; until then the gate keeps the baseline.
Google Maps "Popular Times" is deliberately not used: it has no public API, scraping it violates Google's terms, and the API rejects it as a training source.
