import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AppConfig } from './config';
import { Database } from './db';
import { AuthGuard } from './auth/auth.guard';
import { TOKEN_VERIFIER, TokenVerifier } from './auth/verifier';
import { AllExceptionsFilter } from './common/error.filter';
import { HealthController } from './health/health.controller';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesService } from './employees/employees.service';
import { MeController } from './me.controller';

@Module({})
export class AppModule {
  static register(config: AppConfig, verifier: TokenVerifier): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MeController, EmployeesController],
      providers: [
        { provide: Database, useValue: new Database(config.DATABASE_URL, config.DATABASE_POOL_MAX) },
        { provide: TOKEN_VERIFIER, useValue: verifier },
        EmployeesService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
