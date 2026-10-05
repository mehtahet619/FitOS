import base64
import io
import json
import sys

from PIL import Image
from ultralytics import YOLO

model = YOLO(sys.argv[1])
print("__READY__", flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
        image = Image.open(io.BytesIO(base64.b64decode(request["imageBase64"]))).convert("RGB")
        result = model.predict(image, verbose=False)[0]
        predictions = []
        for box in result.boxes:
            predictions.append({
                "class": result.names[int(box.cls[0])],
                "confidence": float(box.conf[0]),
                "x": float(box.xywh[0][0]),
                "y": float(box.xywh[0][1]),
                "width": float(box.xywh[0][2]),
                "height": float(box.xywh[0][3]),
            })
        print(json.dumps({"id": request["id"], "predictions": predictions}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id", ""), "error": str(error)}), flush=True)
