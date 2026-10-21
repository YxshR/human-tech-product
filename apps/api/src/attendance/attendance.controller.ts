import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { notFound } from '../common/errors';
import { uuidParam } from '../common/params';
import { AttendanceService } from './attendance.service';

const READ = ['attendance.read', 'attendance.read_own'] as const;

@Controller('attendance')
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly svc: AttendanceService) {}

  @Get('shifts') @RequirePermission('attendance.read', 'attendance.read_own', 'attendance.manage_policy', 'attendance.mark')
  async shifts(@Req() req: Request, @Query('includeInactive') inc?: string) { return { data: await this.svc.listShifts(req.auth!, inc === 'true') }; }
  @Post('shifts') @HttpCode(201) @RequirePermission('attendance.manage_policy')
  async createShift(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createShift(req.auth!, body) }; }
  @Patch('shifts/:id') @RequirePermission('attendance.manage_policy')
  async updateShift(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateShift(req.auth!, id, body) }; }
  @Get('shift-assignments') @RequirePermission(...READ)
  async assignments(@Req() req: Request, @Query('employeeId') employeeId?: string) {
    const id = employeeId ?? req.auth!.employeeId;
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound('employee');
    return { data: await this.svc.listAssignments(req.auth!, id) };
  }
  @Post('shift-assignments') @HttpCode(201) @RequirePermission('attendance.manage_policy')
  async assign(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.assign(req.auth!, body) }; }

  @Get('policies') @RequirePermission('attendance.manage_policy', 'attendance.read')
  async policies(@Req() req: Request) { return { data: await this.svc.listPolicies(req.auth!) }; }
  @Post('policies') @HttpCode(201) @RequirePermission('attendance.manage_policy')
  async createPolicy(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createPolicy(req.auth!, body) }; }
  @Post('policies/:id/activate') @HttpCode(200) @RequirePermission('attendance.manage_policy')
  async activate(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setPolicyStatus(req.auth!, id, 'active') }; }
  @Post('policies/:id/retire') @HttpCode(200) @RequirePermission('attendance.manage_policy')
  async retire(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setPolicyStatus(req.auth!, id, 'retired') }; }

  @Get('days') @RequirePermission(...READ)
  async days(@Req() req: Request, @Query() q: unknown) {
    const r = await this.svc.days(req.auth!, q);
    return { data: r.data, page: { nextCursor: r.nextCursor, limit: r.limit } };
  }
  @Get('summary') @RequirePermission(...READ)
  async summary(@Req() req: Request, @Query() q: unknown) { return { data: await this.svc.summary(req.auth!, q) }; }
  @Post('days/mark') @HttpCode(200) @RequirePermission('attendance.mark')
  async mark(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.mark(req.auth!, body) }; }
  @Post('check-in') @HttpCode(200) @RequirePermission('attendance.checkin_own')
  async checkIn(@Req() req: Request, @Headers('idempotency-key') k?: string) { return { data: await this.svc.punch(req.auth!, 'check_in', k?.slice(0, 80)) }; }
  @Post('check-out') @HttpCode(200) @RequirePermission('attendance.checkin_own')
  async checkOut(@Req() req: Request, @Headers('idempotency-key') k?: string) { return { data: await this.svc.punch(req.auth!, 'check_out', k?.slice(0, 80)) }; }
  @Post('events/import') @HttpCode(200) @RequirePermission('attendance.mark')
  async importEvents(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.importPunches(req.auth!, body) }; }
  @Post('finalize') @HttpCode(200) @RequirePermission('attendance.mark')
  async finalize(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.finalize(req.auth!, body) }; }
  @Post('lock') @HttpCode(200) @RequirePermission('attendance.lock')
  async lock(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.lock(req.auth!, body) }; }

  @Get('corrections') @RequirePermission('attendance.request_correction_own', 'attendance.approve_correction', 'attendance.correct')
  async corrections(@Req() req: Request, @Query('status') status?: string) { return { data: await this.svc.listCorrections(req.auth!, status) }; }
  @Post('corrections') @HttpCode(201) @RequirePermission('attendance.request_correction_own', 'attendance.correct')
  async requestCorrection(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.requestCorrection(req.auth!, body) }; }
  @Post('corrections/:id/approve') @HttpCode(200) @RequirePermission('attendance.approve_correction')
  async approve(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewCorrection(req.auth!, id, 'approve', body) }; }
  @Post('corrections/:id/reject') @HttpCode(200) @RequirePermission('attendance.approve_correction')
  async reject(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewCorrection(req.auth!, id, 'reject', body) }; }
  @Post('corrections/:id/cancel') @HttpCode(200) @RequirePermission('attendance.request_correction_own', 'attendance.correct')
  async cancel(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewCorrection(req.auth!, id, 'cancel', body) }; }
}
