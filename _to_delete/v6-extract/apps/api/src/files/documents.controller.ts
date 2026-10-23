import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermission } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { DocumentsService } from './documents.service';

@Controller()
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly svc: DocumentsService) {}

  @Get('employees/:id/documents') @RequirePermission('document.read', 'profile.read_own')
  async list(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.list(req.auth!, id) }; }
  @Post('employees/:id/documents') @HttpCode(201) @RequirePermission('document.upload')
  async create(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.create(req.auth!, id, body) }; }
  @Put('files/:fileId/content') @RequirePermission('document.upload')
  async receive(@Req() req: Request, @Param('fileId', uuidParam) fileId: string, @Headers('content-type') ct?: string) { return { data: await this.svc.receive(req.auth!, fileId, req.body, ct) }; }
  @Get('documents/:id/download-link') @RequirePermission('document.read', 'profile.read_own')
  async link(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.downloadLink(req.auth!, id) }; }
  @Get('files/:fileId/download') @RequirePermission('document.read', 'profile.read_own')
  async download(@Req() req: Request, @Res() res: Response, @Param('fileId', uuidParam) fileId: string, @Query('exp') exp?: string, @Query('sig') sig?: string) {
    const f = await this.svc.download(req.auth!, fileId, exp, sig);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.data);
  }
  @Post('documents/:id/verify') @HttpCode(200) @RequirePermission('employee.update')
  async verify(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.verify(req.auth!, id) }; }
  @Delete('documents/:id') @HttpCode(204) @RequirePermission('document.delete')
  async remove(@Req() req: Request, @Param('id', uuidParam) id: string) { await this.svc.remove(req.auth!, id); }
}
