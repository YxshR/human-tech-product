import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { ApiError } from '../common/errors';
import { uuidParam } from '../common/params';
import { SettingsService } from './settings.service';

const entity = (e: string): 'employee' | 'candidate' => {
  if (e === 'employees') return 'employee';
  if (e === 'candidates') return 'candidate';
  throw new ApiError('not_found', 404, 'unknown record type');
};

@Controller()
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly svc: SettingsService) {}

  // ---- custom fields ----
  @Get('custom-fields') @RequirePermission('custom_field.manage', 'employee.read', 'candidate.read')
  async fields(@Req() req: Request, @Query('entityType') t?: string) { return { data: await this.svc.listFields(req.auth!, t) }; }
  @Post('custom-fields') @HttpCode(201) @RequirePermission('custom_field.manage')
  async createField(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createField(req.auth!, body) }; }
  @Patch('custom-fields/:id') @RequirePermission('custom_field.manage')
  async updateField(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateField(req.auth!, id, body) }; }
  @Get(':kind/:id/custom-values') @RequirePermission('employee.read', 'profile.read_own', 'candidate.read')
  async values(@Req() req: Request, @Param('kind') kind: string, @Param('id', uuidParam) id: string) { return { data: await this.svc.getValues(req.auth!, entity(kind), id) }; }
  @Put(':kind/:id/custom-values') @RequirePermission('employee.update', 'candidate.update')
  async setValues(@Req() req: Request, @Param('kind') kind: string, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.setValues(req.auth!, entity(kind), id, body) }; }

  // ---- saved views (own + shared) ----
  @Get('views') @RequirePermission('profile.read_own')
  async views(@Req() req: Request, @Query('entityType') t?: string) { return { data: await this.svc.listViews(req.auth!, t) }; }
  @Post('views') @HttpCode(201) @RequirePermission('profile.read_own')
  async createView(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createView(req.auth!, body) }; }
  @Patch('views/:id') @RequirePermission('profile.read_own')
  async updateView(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateView(req.auth!, id, body) }; }
  @Delete('views/:id') @HttpCode(204) @RequirePermission('profile.read_own')
  async deleteView(@Req() req: Request, @Param('id', uuidParam) id: string) { await this.svc.deleteView(req.auth!, id); }

  // ---- privacy ----
  @Get('privacy-requests') @RequirePermission('privacy.manage', 'profile.read_own')
  async privacy(@Req() req: Request, @Query('status') status?: string) { return { data: await this.svc.listPrivacy(req.auth!, status) }; }
  @Post('privacy-requests') @HttpCode(201) @RequirePermission('privacy.manage', 'profile.read_own')
  async createPrivacy(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createPrivacy(req.auth!, body) }; }
  @Post('privacy-requests/:id/status') @HttpCode(200) @RequirePermission('privacy.manage')
  async updatePrivacy(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updatePrivacy(req.auth!, id, body) }; }
  @Get('retention-policies') @RequirePermission('privacy.manage')
  async retention(@Req() req: Request) { return { data: await this.svc.listRetention(req.auth!) }; }
  @Put('retention-policies') @RequirePermission('privacy.manage')
  async setRetention(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.setRetention(req.auth!, body) }; }

  // ---- billing ----
  @Get('billing') @RequirePermission('subscription.read')
  async billing(@Req() req: Request) { return { data: await this.svc.billing(req.auth!) }; }
}
