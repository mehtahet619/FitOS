import { afterEach, describe, expect, it, vi } from "vitest";
import { missingModelError, getEquipmentVisionProvider } from "../vision/equipmentVisionProvider";

afterEach(() => vi.unstubAllEnvs());

describe("local equipment vision", () => {
  it("does not turn a missing model into an empty successful detection", async () => {
    vi.stubEnv("ROBOFLOW_WORKFLOW_MODE", "false");
    const result = await getEquipmentVisionProvider().detectEquipment("a".repeat(100));
    expect(result.configured).toBe(false);
    expect(result.detections).toEqual([]);
    expect(result.error).toBe(missingModelError);
  });

  it("selects the Roboflow workflow only when explicitly enabled", () => {
    vi.stubEnv("ROBOFLOW_WORKFLOW_MODE", "true");
    vi.stubEnv("ROBOFLOW_API_KEY", "test-only-key");
    expect(getEquipmentVisionProvider().getProviderName()).toBe("roboflow-workflow-sam3");
  });

  it("does not silently fall back when Roboflow is enabled without a key", async () => {
    vi.stubEnv("ROBOFLOW_WORKFLOW_MODE", "true");
    vi.stubEnv("ROBOFLOW_API_KEY", "");
    const result = await getEquipmentVisionProvider().detectEquipment("a".repeat(100));
    expect(result.configured).toBe(false);
    expect(result.provider).toBe("roboflow-workflow-sam3");
    expect(result.detections).toEqual([]);
  });
});
