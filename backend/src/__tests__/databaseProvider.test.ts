import { describe, expect, it } from "vitest";
import { getDatabaseProvider } from "../db/provider";

describe("database provider selection", () => {
  it.each([
    "mysql://user:password@host:4000/fitos",
    "mysql2://user:password@host:4000/fitos",
    "tidb://user:password@host:4000/fitos",
  ])("selects MySQL for %s", (databaseUrl) => {
    expect(getDatabaseProvider(databaseUrl)).toBe("mysql");
  });

  it("keeps SQLite for local file URLs", () => {
    expect(getDatabaseProvider("file:./dev.db")).toBe("sqlite");
    expect(getDatabaseProvider()).toBe("sqlite");
  });

  it("does not silently fall back to SQLite for an unsupported URL", () => {
    expect(() => getDatabaseProvider("redis://localhost/fitos")).toThrow(
      "Unsupported DATABASE_URL scheme: redis"
    );
  });
});
