import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Body } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { ImportsService } from './imports.service';

@Controller('imports')
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly svc: ImportsService) {}

  @Get() @RequirePermission('import.create', 'import.commit')
  async list(@Req() req: Request) { return { data: await this.svc.list(req.auth!) }; }
  @Post(':type') @HttpCode(201) @RequirePermission('import.create')
  async create(@Req() req: Request, @Param('type') type: string, @Query() query: unknown, @Body() body: unknown) { return { data: await this.svc.create(req.auth!, type, query, body) }; }
  @Get(':id') @RequirePermission('import.create', 'import.commit')
  async get(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.get(req.auth!, id) }; }
  @Post(':id/commit') @HttpCode(200) @RequirePermission('import.commit')
  async commit(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.commit(req.auth!, id) }; }
  @Post(':id/cancel') @HttpCode(200) @RequirePermission('import.create', 'import.commit')
  async cancel(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.cancel(req.auth!, id) }; }
  @Get(':id/result') @RequirePermission('import.create', 'import.commit')
  async result(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.resultLink(req.auth!, id) }; }
}
