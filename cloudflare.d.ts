interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<T>;
  all<T = Record<string, unknown>>(): Promise<T>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    [key: string]: unknown;
  };
}
