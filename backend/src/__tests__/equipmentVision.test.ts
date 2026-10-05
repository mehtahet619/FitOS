import { afterEach, describe, expect, it, vi } from "vitest";

const { databaseMock } = vi.hoisted(() => ({
  databaseMock: {
    all: vi.fn(async () => []),
    get: vi.fn(async (_sql: string, name: string) => ({ name })),
  },
}));
vi.mock("../db/client", () => ({ db: databaseMock }));
import { BestEquipmentVisionProvider } from "../vision/equipmentVisionProvider";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const detectorUrl = "http://127.0.0.1:9000";

describe("BestEquipmentVisionProvider", () => {
  afterEach(() => { fetchMock.mockReset(); });

  it("returns distinct equipment detections from one local-model response", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ predictions: [
      { class: "Chest Press Machine", confidence: 0.94, x: 1, y: 2, width: 3, height: 4 },
      { class: "Lat Pull Down Machine", confidence: 0.89, x: 10, y: 20, width: 30, height: 40 },
      { class: "Leg Press Machine", confidence: 0.78, x: 20, y: 20, width: 10, height: 20 },
    ] }), { status: 200 }));
    const result = await new BestEquipmentVisionProvider(detectorUrl).detectEquipment("aGVsbG8=");
    expect(result.detections.map((d) => d.equipmentName)).toEqual(["Chest Press", "Lat Pulldown", "Leg Press"]);
    expect(result.detections[0].boundingBox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("filters unknown detections and deduplicates classes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ predictions: [{ class: "Chest Press Machine", confidence: 0.8 }] }), { status: 200 }));
    expect((await new BestEquipmentVisionProvider(detectorUrl).detectEquipment("img")).detections).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ predictions: [{ class: "person", confidence: 0.99 }] }), { status: 200 }));
    expect((await new BestEquipmentVisionProvider(detectorUrl).detectEquipment("img")).detections).toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ predictions: [
      { class: "Chest Press Machine", confidence: 0.61 }, { class: "Chest Press Machine", confidence: 0.93 },
    ] }), { status: 200 }));
    const deduped = await new BestEquipmentVisionProvider(detectorUrl).detectEquipment("img");
    expect(deduped.detections).toHaveLength(1);
    expect(deduped.detections[0].confidence).toBe(0.93);
  });

  it("uses the local detector request format and reports provider failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ predictions: [] }), { status: 200 }));
    await new BestEquipmentVisionProvider(detectorUrl).detectEquipment("encoded-image");
    expect(fetchMock).toHaveBeenCalledWith(`${detectorUrl}/detect`, expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: "encoded-image", modelId: "all-gym-equipment/2" }),
    }));
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(new BestEquipmentVisionProvider(detectorUrl).detectEquipment("encoded-image")).rejects.toThrow("503");
  });
});
