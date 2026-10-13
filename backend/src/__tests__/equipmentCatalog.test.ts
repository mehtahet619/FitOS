import { describe, expect, it } from "vitest";
import { CANONICAL_EQUIPMENT, ensureCanonicalEquipmentCatalog } from "../modules/equipment/catalog";
import type { DatabaseLike } from "../db/types";

function makeCatalogDatabase(initial: Array<{ id: string; name: string; isCustom: number }> = []) {
  const rows = [...initial];
  const database = {
    async all<T>(sql: string): Promise<T[]> {
      if (sql === "SELECT name FROM Equipment") return rows.map(({ name }) => ({ name })) as T[];
      if (sql === "SELECT * FROM Equipment ORDER BY name ASC") return [...rows].sort((a, b) => a.name.localeCompare(b.name)) as T[];
      throw new Error(`Unexpected catalog query: ${sql}`);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      if (!sql.includes("INSERT INTO Equipment (id, name, isCustom)")) throw new Error(`Unexpected catalog write: ${sql}`);
      if (!rows.some((row) => row.name === params[1])) {
        rows.push({ id: String(params[0]), name: String(params[1]), isCustom: Number(params[2]) });
      }
      return { changes: 1 };
    },
  } as unknown as Pick<DatabaseLike, "all" | "run">;
  return { database, rows };
}

describe("canonical equipment catalog", () => {
  it("restores every existing canonical choice when the migrated database is empty", async () => {
    const { database, rows } = makeCatalogDatabase();

    const catalog = await ensureCanonicalEquipmentCatalog(database);

    expect(catalog.map((row) => row.name)).toEqual(expect.arrayContaining([...CANONICAL_EQUIPMENT]));
    expect(rows).toHaveLength(CANONICAL_EQUIPMENT.length);
  });

  it("is idempotent and preserves existing custom equipment rows", async () => {
    const { database, rows } = makeCatalogDatabase([{ id: "custom-1", name: "Custom Cable Rig", isCustom: 1 }]);

    await ensureCanonicalEquipmentCatalog(database);
    await ensureCanonicalEquipmentCatalog(database);

    expect(rows).toHaveLength(CANONICAL_EQUIPMENT.length + 1);
    expect(rows.find((row) => row.name === "Custom Cable Rig")).toEqual({ id: "custom-1", name: "Custom Cable Rig", isCustom: 1 });
  });
});
