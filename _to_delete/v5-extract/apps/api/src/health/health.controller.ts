import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Database } from '../db';
import { Public } from '../auth/decorators';

@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Public() @Get('live')
  live(): { status: string } { return { status: 'ok' }; }

  /** Readiness: can serve traffic (database reachable). */
  @Public() @Get('ready')
  async ready(): Promise<{ status: string }> {
    try { await this.db.ping(); } catch { throw new ServiceUnavailableException('database unavailable'); }
    return { status: 'ok' };
  }
}
