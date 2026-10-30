# FitOS monitoring

The API exposes Prometheus metrics at `https://adaptive-fit-api.onrender.com/metrics`.

## Prometheus

Use `prometheus.yml` as the Prometheus scrape configuration (or merge its
`scrape_configs` entry into an existing Prometheus configuration). The API
exports inference request totals, inference latency histogram buckets, raw vs.
accepted predictions, and user confirm/reject feedback counts.

## Grafana

Provision the files under `grafana/provisioning` and mount
`grafana/dashboards` at `/var/lib/grafana/dashboards`. The dashboard
`fitos-gym-equipment.json` includes p95 inference latency, request rate,
prediction throughput, and human feedback panels.

## Important operational notes

- Render currently runs the API with one instance. The in-process counters
  reset on restart and are not suitable for durable billing or audit records.
  The reviewed examples themselves are persisted in the `GymEquipmentFeedback`
  database table.
- Prometheus/Grafana must be hosted and configured separately; these files
  provide the scrape and dashboard configuration, not a provisioned monitoring
  server.
- Feedback images are stored as resized JPEG base64 along with the model label,
  correction, confidence, and verdict. Only user-confirmed detections enter the
  gym equipment profile. Rejected labels are retained as reviewed training
  examples and must be included in a reviewed Roboflow dataset version before
  retraining or publishing a new model.
