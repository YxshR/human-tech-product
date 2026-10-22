import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { notFound } from '../common/errors';
import { uuidParam } from '../common/params';
import { LeaveService } from './leave.service';

@Controller('leave')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly svc: LeaveService) {}

  // types & policies
  @Get('types') @RequirePermission('leave.request', 'leave.read_own', 'leave.read_team', 'leave.read_all', 'leave.manage_policy')
  async types(@Req() req: Request, @Query('includeInactive') inc?: string) { return { data: await this.svc.listTypes(req.auth!, inc === 'true') }; }
  @Post('types') @HttpCode(201) @RequirePermission('leave.manage_policy')
  async createType(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createType(req.auth!, body) }; }
  @Patch('types/:id') @RequirePermission('leave.manage_policy')
  async updateType(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateType(req.auth!, id, body) }; }

  @Get('policies') @RequirePermission('leave.manage_policy')
  async policies(@Req() req: Request) { return { data: await this.svc.listPolicies(req.auth!) }; }
  @Post('policies') @HttpCode(201) @RequirePermission('leave.manage_policy')
  async createPolicy(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createPolicy(req.auth!, body) }; }
  @Post('policies/:id/activate') @HttpCode(200) @RequirePermission('leave.manage_policy')
  async activate(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setPolicyStatus(req.auth!, id, 'active') }; }
  @Post('policies/:id/retire') @HttpCode(200) @RequirePermission('leave.manage_policy')
  async retire(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setPolicyStatus(req.auth!, id, 'retired') }; }

  // requests
  @Get('requests') @RequirePermission('leave.read_own', 'leave.read_team', 'leave.read_all')
  async list(@Req() req: Request, @Query() q: unknown) {
    const r = await this.svc.list(req.auth!, q);
    return { data: r.data, page: { nextCursor: r.nextCursor, limit: r.limit } };
  }
  @Post('requests') @HttpCode(201) @RequirePermission('leave.request', 'leave.approve')
  async apply(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.apply(req.auth!, body) }; }
  @Get('requests/:id') @RequirePermission('leave.read_own', 'leave.read_team', 'leave.read_all')
  async get(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.get(req.auth!, id) }; }
  @Post('requests/:id/approve') @HttpCode(200) @RequirePermission('leave.approve')
  async approve(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.decide(req.auth!, id, 'approve', body) }; }
  @Post('requests/:id/reject') @HttpCode(200) @RequirePermission('leave.reject')
  async reject(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.decide(req.auth!, id, 'reject', body) }; }
  @Post('requests/:id/cancel') @HttpCode(200) @RequirePermission('leave.request', 'leave.approve')
  async cancel(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.cancel(req.auth!, id, body) }; }

  // balances
  @Get('balances') @RequirePermission('leave.read_own', 'leave.read_team', 'leave.read_all')
  async balances(@Req() req: Request, @Query('employeeId') employeeId?: string) {
    return { data: await this.svc.balances(req.auth!, employeeId ? this.uuid(employeeId) : undefined) };
  }
  @Get('balances/ledger') @RequirePermission('leave.read_own', 'leave.read_team', 'leave.read_all')
  async ledger(@Req() req: Request, @Query('employeeId') employeeId?: string, @Query('leaveTypeId') leaveTypeId?: string) {
    return { data: await this.svc.ledger(req.auth!, this.uuid(employeeId ?? req.auth!.employeeId ?? ''), leaveTypeId ? this.uuid(leaveTypeId) : undefined) };
  }
  @Post('balances/adjust') @HttpCode(201) @RequirePermission('leave.adjust_balance')
  async adjust(@Req() req: Request, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return { data: await this.svc.adjust(req.auth!, body, key?.slice(0, 100)) };
  }

  // scheduled rules (also run by the worker)
  @Post('accrual/run') @HttpCode(200) @RequirePermission('leave.manage_policy')
  async accrue(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.accrue(req.auth!, body ?? {}) }; }
  @Post('year-end/run') @HttpCode(200) @RequirePermission('leave.manage_policy')
  async yearEnd(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.yearEnd(req.auth!, body) }; }

  private uuid(v: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw notFound('resource');
    return v;
  }
}
