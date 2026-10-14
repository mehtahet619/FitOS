import type { EquipmentDetection } from "./equipmentVisionProvider";

/**
 * Remove only near-identical, same-label boxes. A label-only de-dupe loses
 * separate machines of the same type (for example multiple benches).
 */
export function deduplicateOverlappingDetections(
  detections: EquipmentDetection[],
  overlapThreshold = 0.92,
): EquipmentDetection[] {
  const ordered = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: EquipmentDetection[] = [];

  for (const detection of ordered) {
    const box = detection.boundingBox;
    const duplicate = Boolean(box && kept.some((existing) => {
      const existingBox = existing.boundingBox;
      return existing.equipmentName === detection.equipmentName && existingBox !== undefined &&
        intersectionOverUnion(box, existingBox) >= overlapThreshold;
    }));
    if (!duplicate) kept.push(detection);
  }

  return kept;
}

function intersectionOverUnion(
  a: NonNullable<EquipmentDetection["boundingBox"]>,
  b: NonNullable<EquipmentDetection["boundingBox"]>,
): number {
  // Roboflow object detection boxes use center x/y and width/height. The IoU
  // is translation invariant, and this conversion also works for top-left
  // boxes as long as both boxes in the pair use the same convention.
  const aLeft = a.x - a.width / 2;
  const aTop = a.y - a.height / 2;
  const bLeft = b.x - b.width / 2;
  const bTop = b.y - b.height / 2;
  const intersectionWidth = Math.max(0, Math.min(aLeft + a.width, bLeft + b.width) - Math.max(aLeft, bLeft));
  const intersectionHeight = Math.max(0, Math.min(aTop + a.height, bTop + b.height) - Math.max(aTop, bTop));
  const intersection = intersectionWidth * intersectionHeight;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}
