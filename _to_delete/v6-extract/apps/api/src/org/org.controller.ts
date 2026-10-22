import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ORG_RESOURCES, OrgResource, holidayQuery } from '@humantech/contracts';
import { RequirePermission } from '../auth/decorators';
import { notFound } from '../common/errors';
import { uuidParam } from '../common/params';
import { OrgService } from './org.service';

const resource = (r: string): OrgResource => {
  if (!(ORG_RESOURCES as readonly string[]).includes(r)) throw notFound('resource');
  return r as OrgResource;
};
const includeArchived = (v: unknown) => v === 'true';

@Controller()
export class OrgController {
  constructor(@Inject(OrgService) private readonly svc: OrgService) {}

  @Get('org/:resource') @RequirePermission('org.read')
  async list(@Req() req: Request, @Param('resource') r: string, @Query('includeArchived') inc?: string) {
    return { data: await this.svc.listItems(req.auth!, resource(r), includeArchived(inc)) };
  }
  @Post('org/:resource') @HttpCode(201) @RequirePermission('org.manage')
  async create(@Req() req: Request, @Param('resource') r: string, @Body() body: unknown) {
    return { data: await this.svc.createItem(req.auth!, resource(r), body) };
  }
  @Patch('org/:resource/:id') @RequirePermission('org.manage')
  async update(@Req() req: Request, @Param('resource') r: string, @Param('id', uuidParam) id: string, @Body() body: unknown) {
    return { data: await this.svc.updateItem(req.auth!, resource(r), id, body) };
  }

  @Get('branches') @RequirePermission('branch.read')
  async branches(@Req() req: Request, @Query('includeArchived') inc?: string) {
    return { data: await this.svc.listBranches(req.auth!, includeArchived(inc)) };
  }
  @Post('branches') @HttpCode(201) @RequirePermission('branch.create')
  async createBranch(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createBranch(req.auth!, body) }; }
  @Patch('branches/:id') @RequirePermission('branch.update')
  async updateBranch(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) {
    return { data: await this.svc.updateBranch(req.auth!, id, body) };
  }

  @Get('holidays') @RequirePermission('org.read')
  async holidays(@Req() req: Request, @Query() q: unknown) {
    return { data: await this.svc.listHolidays(req.auth!, holidayQuery.parse(q)) };
  }
  @Post('holidays') @HttpCode(201) @RequirePermission('org.manage')
  async createHoliday(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createHoliday(req.auth!, body) }; }
  @Delete('holidays/:id') @HttpCode(204) @RequirePermission('org.manage')
  async deleteHoliday(@Req() req: Request, @Param('id', uuidParam) id: string) { await this.svc.deleteHoliday(req.auth!, id); }
}
