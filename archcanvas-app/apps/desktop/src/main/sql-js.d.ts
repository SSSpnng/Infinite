declare module 'sql.js' {
  export interface Statement {
    bind(values?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }

  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Uint8Array) => Database;
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string, prefix?: string) => string;
  }): Promise<SqlJsStatic>;
}
