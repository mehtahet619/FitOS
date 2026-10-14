/**
 * Integration test for Roboflow Workflow provider.
 * Tests equipment detection from a base64-encoded image.
 *
 * Run with: npm test
 */

import { describe, it, expect, vi } from "vitest";
import { RoboflowWorkflowProvider } from "../vision/roboflowWorkflowProvider";

// Mock fetch for testing
global.fetch = vi.fn();

describe("RoboflowWorkflowProvider", () => {
  const mockApiKey = "test_api_key_12345";
  const provider = new RoboflowWorkflowProvider(mockApiKey);

  // Equipment label map from equipmentVisionProvider
  const equipmentLabelMap: Record<string, string> = {
    dumbbell: "Dumbbells",
    dumbbells: "Dumbbells",
    barbell: "Barbell",
    bench: "Bench",
    "pull-up bar": "Pull-up Bar",
    "pullup bar": "Pull-up Bar",
    "resistance band": "Resistance Bands",
    "resistance bands": "Resistance Bands",
    "cable machine": "Cable Machine",
    "squat rack": "Squat Rack",
    treadmill: "Treadmill",
    "exercise bike": "Exercise Bike",
    "smith machine": "Smith Machine",
    "leg press": "Leg Press",
    "lat pulldown": "Lat Pulldown",
    kettlebell: "Dumbbells",
  };

  // Simple test image (small base64 string)
  const testBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("should parse successful workflow response with predictions", async () => {
    const mockResponse = {
      predictions: [
        { class: "dumbbell", confidence: 0.95 },
        { class: "bench", confidence: 0.87 },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result).toHaveLength(2);
    expect(result[0].equipmentName).toBe("Dumbbells");
    expect(result[0].confidence).toBe(0.95);
    expect(result[0].rawLabel).toBe("dumbbell");
    expect(result[1].equipmentName).toBe("Bench");
  });

  it("should handle unmapped equipment classes gracefully", async () => {
    const mockResponse = {
      predictions: [
        { class: "dumbbell", confidence: 0.95 },
        { class: "unknown_class", confidence: 0.8 }, // Not in equipmentLabelMap
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result).toHaveLength(1); // Only mapped class
    expect(result[0].equipmentName).toBe("Dumbbells");
  });

  it("should preserve model bounding boxes for live overlays", async () => {
    const mockResponse = {
      predictions: [{ class: "bench", confidence: 0.91, x: 320, y: 240, width: 180, height: 120 }],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result[0].boundingBox).toEqual({ x: 320, y: 240, width: 180, height: 120 });
  });

  it("keeps separate machines with the same canonical label", async () => {
    const mockResponse = {
      predictions: [
        { class: "bench", confidence: 0.7, x: 100, y: 100, width: 80, height: 50 },
        { class: "bench", confidence: 0.95, x: 300, y: 100, width: 80, height: 50 },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result).toHaveLength(2);
    expect(result.map((detection) => detection.confidence)).toEqual([0.95, 0.7]);
  });

  it("merges near-identical overlapping boxes for the same machine", async () => {
    const mockResponse = {
      predictions: [
        { class: "bench", confidence: 0.7, x: 100, y: 100, width: 80, height: 50 },
        { class: "bench", confidence: 0.95, x: 101, y: 100, width: 80, height: 50 },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => mockResponse });
    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.95);
  });

  it("should handle empty predictions response", async () => {
    const mockResponse = { predictions: [] };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result).toHaveLength(0);
  });

  it("ignores invalid confidence values", async () => {
    const mockResponse = {
      predictions: [
        { class: "dumbbell", confidence: 1.5 }, // Invalid: > 1
        { class: "bench", confidence: -0.1 }, // Invalid: < 0
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await provider.detectEquipment(testBase64, equipmentLabelMap);

    expect(result).toEqual([]);
  });

  it("should send correct request headers", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [] }),
    });

    await provider.detectEquipment(testBase64, equipmentLabelMap);

    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[1].headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Bearer ${mockApiKey}`,
    });
  });

  it("should include base64 image in request payload", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [] }),
    });

    await provider.detectEquipment(testBase64, equipmentLabelMap);

    const callArgs = (global.fetch as any).mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);

    expect(payload).toMatchObject({
      inputs: {
        image: {
          type: "base64",
          value: testBase64,
        },
      },
    });
  });
});
