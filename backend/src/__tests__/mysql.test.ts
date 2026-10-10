import { describe, expect, it, vi } from "vitest";

const { createPool } = vi.hoisted(() => ({
  createPool: vi.fn(() => ({
    end: vi.fn(),
    getConnection: vi.fn(),
    query: vi.fn(),
  })),
}));

vi.mock("mysql2/promise", () => ({ createPool }));

import { MySqlDatabase } from "../db/mysql";

describe("MySQL/TiDB adapter", () => {
  it.each(["mysql://user:password@host:4000/fitos", "tidb://user:password@host:4000/fitos"])(
    "enables TLS for %s connections",
    (connectionString) => {
      createPool.mockClear();

      new MySqlDatabase(connectionString);

      expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
        ssl: { rejectUnauthorized: true },
      }));
    }
  );
});
