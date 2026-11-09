"""Train, evaluate and gate the crowd model."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import f1_score, mean_absolute_error, precision_score, recall_score

from features import FEATURES, HIGH_THRESHOLD

MIN_TRAIN_ROWS = 300       # real labelled gym-hours across all gyms
MIN_HOLDOUT_ROWS = 50      # needed to trust the evaluation
HOLDOUT_DAYS = 14
REQUIRED_IMPROVEMENT = 0.05  # model MAE must beat the BEST simple baseline by >= 5%


@dataclass
class Trained:
    regressor: HistGradientBoostingRegressor
    classifier: HistGradientBoostingClassifier | None
    gym_index: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    publishable: bool = False
    reason: str = ""


CATEGORICAL = [FEATURES.index("gym_code")]


def _fit(train: pd.DataFrame):
    reg = HistGradientBoostingRegressor(categorical_features=CATEGORICAL, max_depth=5, learning_rate=0.06, max_iter=250, l2_regularization=1.0,
                                        min_samples_leaf=15, random_state=0)
    reg.fit(train[FEATURES], train["label"], sample_weight=train["weight"])
    y = (train["label"] >= HIGH_THRESHOLD).astype(int)
    clf = None
    if y.nunique() == 2 and y.value_counts().min() >= 10:
        clf = HistGradientBoostingClassifier(categorical_features=CATEGORICAL, max_depth=4, learning_rate=0.06, max_iter=200, l2_regularization=1.0,
                                             min_samples_leaf=15, random_state=0)
        clf.fit(train[FEATURES], y, sample_weight=train["weight"])
    return reg, clf


def train_and_evaluate(data: pd.DataFrame) -> Trained:
    """`data` = labelled rows from all gyms with FEATURES + label + weight + ts."""
    if len(data) < MIN_TRAIN_ROWS:
        return Trained(None, None, {}, {"labelledRows": int(len(data))}, False,
                       f"Only {len(data)} real labelled hours (need {MIN_TRAIN_ROWS}). Keeping the baseline forecast.")
    data = data.sort_values("ts").copy()
    gym_index = {g: i for i, g in enumerate(sorted(data["gym_id"].unique()))}
    data["gym_code"] = data["gym_id"].map(gym_index).astype(int)
    cutoff = data["ts"].max() - pd.Timedelta(days=HOLDOUT_DAYS)
    train, hold = data[data["ts"] <= cutoff], data[data["ts"] > cutoff]
    metrics: dict = {"labelledRows": int(len(data)), "trainRows": int(len(train)), "holdoutRows": int(len(hold)),
                     "labelMix": data["label_kind"].value_counts().to_dict()}
    if len(hold) < MIN_HOLDOUT_ROWS or len(train) < MIN_TRAIN_ROWS // 2:
        reg, clf = _fit(data)
        return Trained(reg, clf, gym_index, metrics, False, "Not enough history for a trustworthy hold-out; model trained but not published.")

    reg, clf = _fit(train)
    pred = np.clip(reg.predict(hold[FEATURES]), 0, 100)
    # Baselines the model must beat: the hand-made prior, each gym's own hour-of-week average (what the API's
    # adaptive baseline does), and a constant. A model that only beats a badly calibrated prior is not a model.
    how = train.groupby(["gym_id", "weekday", "hour"])["label"].mean()
    how_pred = np.array([how.get((g, w, h), np.nan) for g, w, h in zip(hold["gym_id"], hold["weekday"], hold["hour"])])
    how_pred = np.where(np.isnan(how_pred), hold["prior"], how_pred)
    const_pred = np.full(len(hold), float(train["label"].mean()))
    metrics["maeModel"] = round(float(mean_absolute_error(hold["label"], pred)), 2)
    metrics["maePrior"] = round(float(mean_absolute_error(hold["label"], hold["prior"])), 2)
    metrics["maeGymHourOfWeekMean"] = round(float(mean_absolute_error(hold["label"], how_pred)), 2)
    metrics["maeConstant"] = round(float(mean_absolute_error(hold["label"], const_pred)), 2)
    best_baseline = min(metrics["maePrior"], metrics["maeGymHourOfWeekMean"], metrics["maeConstant"])
    metrics["maeBestBaseline"] = best_baseline

    y_true = (hold["label"] >= HIGH_THRESHOLD).astype(int)
    metrics["holdoutHighShare"] = round(float(y_true.mean()), 3)
    if clf is not None and y_true.nunique() == 2:
        proba = clf.predict_proba(hold[FEATURES])[:, 1]
        yhat = (proba >= 0.5).astype(int)
        base = (hold["prior"] >= HIGH_THRESHOLD).astype(int)
        metrics["highCrowd"] = {
            "f1": round(float(f1_score(y_true, yhat, zero_division=0)), 3),
            "precision": round(float(precision_score(y_true, yhat, zero_division=0)), 3),
            "recall": round(float(recall_score(y_true, yhat, zero_division=0)), 3),
            "f1Prior": round(float(f1_score(y_true, base, zero_division=0)), 3),
        }

    improved = metrics["maeModel"] <= best_baseline * (1 - REQUIRED_IMPROVEMENT)
    final_reg, final_clf = _fit(data)  # refit on everything for serving
    reason = "Model beats the baseline on the hold-out." if improved else (
        f"Model MAE {metrics['maeModel']} did not beat the best baseline MAE {best_baseline} by {int(REQUIRED_IMPROVEMENT*100)}%; keeping the baseline forecast.")
    return Trained(final_reg, final_clf, gym_index, metrics, improved, reason)


def confidence_for(own_labelled_hours: int) -> str:
    return "high" if own_labelled_hours >= 300 else "medium" if own_labelled_hours >= 80 else "low"
