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
import { AuditService } from './common/audit';
import { AccessController } from './access/access.controller';
import { AccessService } from './access/access.service';
import { LeaveController } from './leave/leave.controller';
import { LeaveService } from './leave/leave.service';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import { CompensationController } from './compensation/compensation.controller';
import { CompensationService } from './compensation/compensation.service';
import { MePayslipsController, PayrollController } from './payroll/payroll.controller';
import { PayrollService } from './payroll/payroll.service';
import { FIELD_CRYPTO, ProfileService } from './profile/profile.service';
import { ProfileController } from './profile/profile.controller';
import { DocumentsController } from './files/documents.controller';
import { DocumentsService, FILE_CONFIG } from './files/documents.service';
import { buildStorage } from '@humantech/storage';
import { FILE_STORAGE, FileStorage } from './files/storage';
import { OnboardingController } from './onboarding/onboarding.controller';
import { OnboardingService } from './onboarding/onboarding.service';
import { RecruitmentController } from './recruitment/recruitment.controller';
import { RecruitmentService } from './recruitment/recruitment.service';
import { AuditViewerService } from './platform/audit-viewer.service';
import { NotificationsService } from './platform/notifications.service';
import { PlatformController } from './platform/platform.controller';
import { ImportsController } from './platform/imports.controller';
import { ImportsService } from './platform/imports.service';
import { SignupController } from './platform/signup.controller';
import { SettingsController } from './platform/settings.controller';
import { SettingsService } from './platform/settings.service';
import { ReportsService } from './platform/reports.service';
import { FieldCrypto } from './security/field-crypto';
import { OrgController } from './org/org.controller';
import { OrgService } from './org/org.service';

function storageFor(config: AppConfig): FileStorage {
  return buildStorage(config.STORAGE_DRIVER === 's3'
    ? { driver: 's3', s3: { bucket: config.S3_BUCKET!, endpoint: config.S3_ENDPOINT, region: config.S3_REGION, accessKey: config.S3_ACCESS_KEY!, secretKey: config.S3_SECRET_KEY!, forcePathStyle: config.S3_FORCE_PATH_STYLE } }
    : { driver: 'local', localDir: config.STORAGE_LOCAL_DIR });
}

@Module({})
export class AppModule {
  static register(config: AppConfig, verifier: TokenVerifier): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MeController, EmployeesController, OrgController, AccessController, LeaveController, AttendanceController, CompensationController, PayrollController, MePayslipsController, ProfileController, DocumentsController, OnboardingController, RecruitmentController, PlatformController, ImportsController, SettingsController, SignupController],
      providers: [
        { provide: Database, useValue: new Database(config.DATABASE_URL, config.DATABASE_POOL_MAX) },
        { provide: TOKEN_VERIFIER, useValue: verifier },
        AuditService,
        EmployeesService,
        OrgService,
        AccessService,
        LeaveService,
        AttendanceService,
        CompensationService,
        PayrollService,
        ProfileService,
        DocumentsService,
        OnboardingService,
        RecruitmentService,
        NotificationsService,
        AuditViewerService,
        ReportsService,
        ImportsService,
        SettingsService,
        { provide: FIELD_CRYPTO, useValue: new FieldCrypto(config.FIELD_ENCRYPTION_KEYS, config.BLIND_INDEX_KEY) },
        { provide: FILE_CONFIG, useValue: { signingSecret: config.FILE_SIGNING_SECRET, maxUploadBytes: config.MAX_UPLOAD_BYTES } },
        { provide: FILE_STORAGE, useValue: storageFor(config) },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
