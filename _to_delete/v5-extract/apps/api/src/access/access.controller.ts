import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Put, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission, NoTenant } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { AccessService } from './access.service';

@Controller('access')
export class AccessController {
  constructor(@Inject(AccessService) private readonly svc: AccessService) {}

  @Get('users') @RequirePermission('user.read')
  async users(@Req() req: Request) { return { data: await this.svc.listUsers(req.auth!) }; }

  @Get('roles') @RequirePermission('role.read')
  async roles(@Req() req: Request) { return { data: await this.svc.listRoles(req.auth!) }; }

  @Get('permissions') @RequirePermission('role.read')
  permissions() { return { data: this.svc.permissionCatalogue() }; }

  @Post('roles') @HttpCode(201) @RequirePermission('role.manage')
  async createRole(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createRole(req.auth!, body) }; }
  @Patch('roles/:id') @RequirePermission('role.manage')
  async updateRole(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateRole(req.auth!, id, body) }; }
  @Delete('roles/:id') @HttpCode(204) @RequirePermission('role.manage')
  async deleteRole(@Req() req: Request, @Param('id', uuidParam) id: string) { await this.svc.deleteRole(req.auth!, id); }

  @Get('invitations') @RequirePermission('user.read')
  async invitations(@Req() req: Request) { return { data: await this.svc.listInvitations(req.auth!) }; }
  /** The one-time token is returned ONCE so the admin can share the link if e-mail is unavailable. */
  @Post('invitations') @HttpCode(201) @RequirePermission('user.invite')
  async invite(@Req() req: Request, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const { invitation, token } = await this.svc.invite(req.auth!, body, key?.slice(0, 100));
    return { data: { ...invitation, acceptToken: token } };
  }
  @Post('invitations/:id/revoke') @HttpCode(204) @RequirePermission('user.invite')
  async revoke(@Req() req: Request, @Param('id', uuidParam) id: string) { await this.svc.revokeInvitation(req.auth!, id); }
  /** Invitee redeems a token; works before any company is selected. */
  @Post('invitations/accept') @HttpCode(200) @NoTenant()
  async accept(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.accept(req.auth!.userId, body) }; }

  @Put('users/:userId/roles') @RequirePermission('role.manage')
  async setRoles(@Req() req: Request, @Param('userId', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.setRoles(req.auth!, id, body) }; }
  @Put('users/:userId/branch-scope') @RequirePermission('role.manage')
  async setScope(@Req() req: Request, @Param('userId', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.setScope(req.auth!, id, body) }; }
  @Post('users/:userId/suspend') @HttpCode(200) @RequirePermission('user.manage')
  async suspend(@Req() req: Request, @Param('userId', uuidParam) id: string) { return { data: await this.svc.setStatus(req.auth!, id, 'suspended') }; }
  @Post('users/:userId/restore') @HttpCode(200) @RequirePermission('user.manage')
  async restore(@Req() req: Request, @Param('userId', uuidParam) id: string) { return { data: await this.svc.setStatus(req.auth!, id, 'active') }; }
}
