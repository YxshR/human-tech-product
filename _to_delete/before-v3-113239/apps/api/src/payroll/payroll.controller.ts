import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermission } from '../auth/decorators';
import { ApiError } from '../common/errors';
import { uuidParam } from '../common/params';
import { PayrollService } from './payroll.service';

const optionalUuid = (v?: string): string | undefined => {
  if (v === undefined || v === '') return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new ApiError('validation_failed', 422, 'Invalid id in query', [{ path: 'id', message: 'expected a UUID' }]);
  return v;
};

@Controller('payroll')
export class PayrollController {
  constructor(@Inject(PayrollService) private readonly svc: PayrollService) {}

  @Get('status') @RequirePermission('payroll.read', 'payroll.manage_settings')
  async status(@Req() req: Request) { return { data: await this.svc.status(req.auth!) }; }
  @Post('activation-request') @HttpCode(200) @RequirePermission('payroll.manage_settings')
  async activation(@Req() req: Request) { return { data: await this.svc.requestActivation(req.auth!) }; }

  @Get('pay-groups') @RequirePermission('payroll.read', 'payroll.manage_settings')
  async groups(@Req() req: Request) { return { data: await this.svc.listGroups(req.auth!) }; }
  @Post('pay-groups') @HttpCode(201) @RequirePermission('payroll.manage_settings')
  async createGroup(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createGroup(req.auth!, body) }; }
  @Patch('pay-groups/:id') @RequirePermission('payroll.manage_settings')
  async updateGroup(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateGroup(req.auth!, id, body) }; }
  @Put('employees/:id/pay-setup') @RequirePermission('payroll.manage_settings')
  async paySetup(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.setEmployeePaySetup(req.auth!, id, body) }; }

  @Get('periods') @RequirePermission('payroll.read', 'payroll.manage_settings')
  async periods(@Req() req: Request, @Query('payGroupId') g?: string) { return { data: await this.svc.listPeriods(req.auth!, optionalUuid(g)) }; }
  @Post('periods/generate') @HttpCode(201) @RequirePermission('payroll.manage_settings')
  async generate(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.generatePeriod(req.auth!, body) }; }

  @Get('runs') @RequirePermission('payroll.read')
  async runs(@Req() req: Request, @Query('periodId') p?: string) { return { data: await this.svc.listRuns(req.auth!, optionalUuid(p)) }; }
  @Post('runs') @HttpCode(201) @RequirePermission('payroll.create_run')
  async createRun(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createRun(req.auth!, body) }; }
  @Get('runs/:id') @RequirePermission('payroll.read')
  async run(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.getRun(req.auth!, id) }; }
  @Post('runs/:id/validate') @HttpCode(200) @RequirePermission('payroll.calculate')
  async validate(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.validate(req.auth!, id) }; }
  @Post('runs/:id/calculate') @HttpCode(200) @RequirePermission('payroll.calculate')
  async calculate(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.calculate(req.auth!, id) }; }
  @Post('runs/:id/reopen') @HttpCode(200) @RequirePermission('payroll.calculate')
  async reopen(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.reopen(req.auth!, id) }; }
  @Post('runs/:id/cancel') @HttpCode(200) @RequirePermission('payroll.create_run', 'payroll.calculate')
  async cancel(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.cancel(req.auth!, id) }; }
  @Post('runs/:id/submit') @HttpCode(200) @RequirePermission('payroll.submit')
  async submit(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.submit(req.auth!, id) }; }
  @Post('runs/:id/approve') @HttpCode(200) @RequirePermission('payroll.approve')
  async approve(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.approve(req.auth!, id) }; }
  @Post('runs/:id/reject') @HttpCode(200) @RequirePermission('payroll.approve')
  async reject(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reject(req.auth!, id, body) }; }
  @Post('runs/:id/finalize') @HttpCode(200) @RequirePermission('payroll.finalize')
  async finalize(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.finalize(req.auth!, id) }; }
  @Post('runs/:id/correct') @HttpCode(201) @RequirePermission('payroll.correct')
  async correct(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.correct(req.auth!, id, body) }; }

  @Get('runs/:id/exceptions') @RequirePermission('payroll.read')
  async exceptions(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.listExceptions(req.auth!, id) }; }
  @Patch('exceptions/:id') @RequirePermission('payroll.resolve_exception')
  async resolve(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.resolveException(req.auth!, id, body) }; }
  @Get('runs/:id/items') @RequirePermission('payroll.read')
  async items(@Req() req: Request, @Param('id', uuidParam) id: string, @Query() q: Record<string, string>) {
    const r = await this.svc.listItems(req.auth!, id, q);
    return { data: r.data, page: { nextCursor: r.nextCursor, limit: Math.min(Number(q.limit) || 50, 200) } };
  }
  @Get('runs/:id/items/:itemId') @RequirePermission('payroll.read')
  async item(@Req() req: Request, @Param('id', uuidParam) id: string, @Param('itemId', uuidParam) itemId: string) { return { data: await this.svc.itemLines(req.auth!, id, itemId) }; }
  @Get('runs/:id/payslips') @RequirePermission('payslip.read_any')
  async runPayslips(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.runPayslips(req.auth!, id) }; }
  @Get('runs/:id/register') @RequirePermission('payroll.export')
  async register(@Req() req: Request, @Res() res: Response, @Param('id', uuidParam) id: string, @Query('format') format?: string) {
    if (format !== undefined && format !== 'csv' && format !== 'json') throw new ApiError('validation_failed', 422, 'format must be csv or json', [{ path: 'format', message: 'csv or json' }]);
    const out = await this.svc.register(req.auth!, id, format === 'json' ? 'json' : 'csv');
    res.setHeader('Cache-Control', 'no-store');
    if (out.csv !== undefined) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.send(out.csv);
    } else res.json({ data: out.json });
  }

  @Get('adjustments') @RequirePermission('payroll.read', 'payroll.manage_adjustments', 'payroll.approve_adjustment')
  async adjustments(@Req() req: Request, @Query('periodId') p?: string, @Query('employeeId') e?: string, @Query('status') s?: string) {
    return { data: await this.svc.listAdjustments(req.auth!, { periodId: optionalUuid(p), employeeId: optionalUuid(e), status: s }) };
  }
  @Post('adjustments') @HttpCode(201) @RequirePermission('payroll.manage_adjustments')
  async createAdj(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createAdjustment(req.auth!, body) }; }
  @Post('adjustments/:id/approve') @HttpCode(200) @RequirePermission('payroll.approve_adjustment')
  async approveAdj(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewAdjustment(req.auth!, id, 'approve', body) }; }
  @Post('adjustments/:id/reject') @HttpCode(200) @RequirePermission('payroll.approve_adjustment')
  async rejectAdj(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewAdjustment(req.auth!, id, 'reject', body) }; }
  @Post('adjustments/:id/cancel') @HttpCode(200) @RequirePermission('payroll.manage_adjustments')
  async cancelAdj(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.cancelAdjustment(req.auth!, id) }; }

  @Get('payslips/:id') @RequirePermission('payslip.read_any', 'payslip.read_own')
  async payslip(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.getPayslip(req.auth!, id) }; }
  @Get('payslips/:id/download-link') @RequirePermission('payslip.read_any', 'payslip.read_own')
  async payslipLink(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.payslipLink(req.auth!, id) }; }
}

@Controller('me/payslips')
export class MePayslipsController {
  constructor(@Inject(PayrollService) private readonly svc: PayrollService) {}
  @Get() @RequirePermission('payslip.read_own')
  async mine(@Req() req: Request) { return { data: await this.svc.myPayslips(req.auth!) }; }
  @Get(':id') @RequirePermission('payslip.read_own')
  async one(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.getPayslip(req.auth!, id) }; }
  @Get(':id/download-link') @RequirePermission('payslip.read_own')
  async link(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.payslipLink(req.auth!, id) }; }
}
