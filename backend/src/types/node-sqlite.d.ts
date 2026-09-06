// Minimal ambient typings for Node's built-in `node:sqlite` module (stable
// as of Node 22.5+, used here without --experimental-sqlite issues on 22.x).
// Declared locally rather than relying on a specific @types/node version
// shipping these, so this project's type-checking doesn't depend on that.
declare module "node:sqlite" {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: any[]): StatementResultingChanges;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
