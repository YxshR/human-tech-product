import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermission } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { AuditViewerService } from './audit-viewer.service';
import { NotificationsService } from './notifications.service';
import { ReportsService } from './reports.service';

@Controller()
export class PlatformController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(AuditViewerService) private readonly auditViewer: AuditViewerService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  // ---- notifications (everyone, own only) ----
  @Get('me/notifications') @RequirePermission('profile.read_own')
  async list(@Req() req: Request, @Query() query: unknown) {
    const r = await this.notifications.list(req.auth!, query);
    return { data: r.data, unread: r.unread, page: { nextCursor: r.nextCursor, limit: r.data.length } };
  }
  @Post('me/notifications/read-all') @HttpCode(200) @RequirePermission('profile.read_own')
  async readAll(@Req() req: Request) { return { data: await this.notifications.markAllRead(req.auth!) }; }
  @Post('me/notifications/:id/read') @HttpCode(200) @RequirePermission('profile.read_own')
  async read(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.notifications.markRead(req.auth!, id) }; }
  @Get('me/notification-preferences') @RequirePermission('profile.read_own')
  async prefs(@Req() req: Request) { return { data: await this.notifications.preferences(req.auth!) }; }
  @Put('me/notification-preferences/:key') @RequirePermission('profile.read_own')
  async setPref(@Req() req: Request, @Param('key') key: string, @Body() body: unknown) { return { data: await this.notifications.setPreference(req.auth!, key, body) }; }

  // ---- audit ----
  @Get('audit-logs') @RequirePermission('audit.read')
  async audit(@Req() req: Request, @Query() query: unknown) {
    const r = await this.auditViewer.list(req.auth!, query);
    return { data: r.data, page: { nextCursor: r.nextCursor, limit: r.data.length } };
  }

  // ---- reports & exports ----
  @Get('reports') @RequirePermission('report.read', 'candidate.read')
  async catalogue(@Req() req: Request) { return { data: this.reports.catalogue(req.auth!) }; }
  @Get('reports/:key') @RequirePermission('report.read', 'candidate.read')
  async report(@Req() req: Request, @Res() res: Response, @Param('key') key: string, @Query() query: unknown) {
    const r = await this.reports.run(req.auth!, key, query);
    if (r.csv !== undefined) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${key}.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(r.csv);
    } else res.json({ data: r.result });
  }
  @Post('exports') @HttpCode(201) @RequirePermission('export.create')
  async createExport(@Req() req: Request, @Body() body: unknown) { return { data: await this.reports.createExport(req.auth!, body) }; }
  @Get('exports') @RequirePermission('export.create')
  async exports(@Req() req: Request) { return { data: await this.reports.listExports(req.auth!) }; }
  @Get('exports/:id/download-link') @RequirePermission('export.create')
  async exportLink(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.reports.exportLink(req.auth!, id) }; }
}
