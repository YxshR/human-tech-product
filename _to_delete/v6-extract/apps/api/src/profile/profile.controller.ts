import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { ProfileService } from './profile.service';

@Controller()
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly svc: ProfileService) {}

  @Get('employees/:id/personal') @RequirePermission('employee.read_sensitive', 'profile.read_own')
  async personal(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.getPersonal(req.auth!, id) }; }
  @Put('employees/:id/personal') @RequirePermission('employee.update_sensitive')
  async updatePersonal(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updatePersonal(req.auth!, id, body) }; }

  @Get('employees/:id/emergency-contacts') @RequirePermission('employee.read_sensitive', 'profile.read_own')
  async contacts(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.listContacts(req.auth!, id) }; }
  @Post('employees/:id/emergency-contacts') @HttpCode(201) @RequirePermission('employee.update_sensitive')
  async addContact(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.addContact(req.auth!, id, body) }; }
  @Delete('employees/:id/emergency-contacts/:contactId') @HttpCode(204) @RequirePermission('employee.update_sensitive')
  async removeContact(@Req() req: Request, @Param('id', uuidParam) id: string, @Param('contactId', uuidParam) cid: string) { await this.svc.removeContact(req.auth!, id, cid); }

  @Get('employees/:id/identifiers') @RequirePermission('employee.read_identifiers', 'profile.read_own')
  async identifiers(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.listIdentifiers(req.auth!, id) }; }
  @Put('employees/:id/identifiers/:type') @RequirePermission('employee.update_sensitive')
  async setIdentifier(@Req() req: Request, @Param('id', uuidParam) id: string, @Param('type') type: string, @Body() body: unknown) { return { data: await this.svc.setIdentifier(req.auth!, id, type, body) }; }
  @Post('employees/:id/identifiers/:type/verify') @HttpCode(200) @RequirePermission('employee.verify_bank')
  async verifyIdentifier(@Req() req: Request, @Param('id', uuidParam) id: string, @Param('type') type: string) { return { data: await this.svc.verifyIdentifier(req.auth!, id, type) }; }

  @Get('employees/:id/bank') @RequirePermission('employee.read_bank', 'profile.read_own')
  async bank(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.listBank(req.auth!, id) }; }
  @Post('employees/:id/bank') @HttpCode(201) @RequirePermission('employee.update_bank')
  async addBank(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.addBank(req.auth!, id, body) }; }
  @Post('bank-details/:id/verify') @HttpCode(200) @RequirePermission('employee.verify_bank')
  async verifyBank(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewBank(req.auth!, id, 'verify', body) }; }
  @Post('bank-details/:id/reject') @HttpCode(200) @RequirePermission('employee.verify_bank')
  async rejectBank(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewBank(req.auth!, id, 'reject', body) }; }
  @Post('bank-details/:id/withdraw') @HttpCode(200) @RequirePermission('employee.update_bank')
  async withdrawBank(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.withdrawBank(req.auth!, id) }; }

  @Get('profile-changes') @RequirePermission('profile.request_change', 'profile.review_change')
  async changes(@Req() req: Request, @Query('status') status?: string) { return { data: await this.svc.listChanges(req.auth!, status) }; }
  @Post('profile-changes') @HttpCode(201) @RequirePermission('profile.request_change')
  async requestChange(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.requestChange(req.auth!, body) }; }
  @Post('profile-changes/:id/approve') @HttpCode(200) @RequirePermission('profile.review_change')
  async approve(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewChange(req.auth!, id, 'approve', body) }; }
  @Post('profile-changes/:id/reject') @HttpCode(200) @RequirePermission('profile.review_change')
  async reject(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.reviewChange(req.auth!, id, 'reject', body) }; }
  @Post('profile-changes/:id/cancel') @HttpCode(200) @RequirePermission('profile.request_change')
  async cancel(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.cancelChange(req.auth!, id) }; }
}
