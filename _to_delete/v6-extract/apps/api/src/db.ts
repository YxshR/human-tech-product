import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { createPool, withContext } from '@humantech/database';

export const DB_URL = Symbol('DB_URL');

/** The only way request code reaches the database: always inside a tenant-scoped transaction. */
@Injectable()
export class Database implements OnApplicationShutdown {
  readonly pool: Pool;
  constructor(url: string, max: number) {
    this.pool = createPool(url, max);
  }
  run<T>(ctx: { tenantId?: string; userId?: string; reason?: string; effectiveDate?: string }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withContext(this.pool, ctx, fn);
  }
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
