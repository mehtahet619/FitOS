import { describe, expect, it } from "vitest";
import { missingModelError, getEquipmentVisionProvider } from "../vision/equipmentVisionProvider";

describe("local equipment vision", () => {
  it("does not turn a missing model into an empty successful detection", async () => {
    const result = await getEquipmentVisionProvider().detectEquipment("a".repeat(100));
    expect(result.configured).toBe(false);
    expect(result.detections).toEqual([]);
    expect(result.error).toBe(missingModelError);
  });
});
