import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { RecruitmentService } from './recruitment.service';

@Controller()
export class RecruitmentController {
  constructor(@Inject(RecruitmentService) private readonly svc: RecruitmentService) {}

  // clients and job requirements (read by recruiters, managed by recruitment.manage)
  @Get('clients') @RequirePermission('candidate.read', 'recruitment.manage')
  async clients(@Req() req: Request) { return { data: await this.svc.listClients(req.auth!) }; }
  @Post('clients') @HttpCode(201) @RequirePermission('recruitment.manage')
  async createClient(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createClient(req.auth!, body) }; }
  @Patch('clients/:id') @RequirePermission('recruitment.manage')
  async updateClient(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateClient(req.auth!, id, body) }; }

  @Get('job-requirements') @RequirePermission('candidate.read', 'recruitment.manage')
  async jobs(@Req() req: Request, @Query('status') status?: string, @Query('clientId') clientId?: string) {
    return { data: await this.svc.listJobs(req.auth!, { status, clientId }) };
  }
  @Get('job-requirements/:id') @RequirePermission('candidate.read', 'recruitment.manage')
  async job(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.getJob(req.auth!, id) }; }
  @Post('job-requirements') @HttpCode(201) @RequirePermission('recruitment.manage')
  async createJob(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createJob(req.auth!, body) }; }
  @Patch('job-requirements/:id') @RequirePermission('recruitment.manage')
  async updateJob(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateJob(req.auth!, id, body) }; }

  // candidates
  @Get('candidates') @RequirePermission('candidate.read')
  async list(@Req() req: Request, @Query() query: unknown) {
    const r = await this.svc.list(req.auth!, query);
    return { data: r.data, page: { nextCursor: r.nextCursor, limit: r.data.length } };
  }
  @Post('candidates') @HttpCode(201) @RequirePermission('candidate.create')
  async create(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.create(req.auth!, body) }; }
  @Get('candidates/:id') @RequirePermission('candidate.read')
  async get(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.get(req.auth!, id) }; }
  @Patch('candidates/:id') @RequirePermission('candidate.update')
  async update(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.update(req.auth!, id, body) }; }
  @Put('candidates/:id/compensation') @RequirePermission('candidate.read_salary')
  async compensation(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.setCompensation(req.auth!, id, body) }; }
  @Post('candidates/:id/archive') @HttpCode(200) @RequirePermission('candidate.update')
  async archive(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.archive(req.auth!, id, false) }; }
  @Post('candidates/:id/restore') @HttpCode(200) @RequirePermission('candidate.update')
  async restore(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.archive(req.auth!, id, true) }; }
  @Post('candidates/:id/stage') @HttpCode(200) @RequirePermission('candidate.change_stage')
  async stage(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.changeStage(req.auth!, id, body) }; }
  @Get('candidates/:id/history') @RequirePermission('candidate.read')
  async history(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.history(req.auth!, id) }; }
  @Get('candidates/:id/activities') @RequirePermission('candidate.read')
  async activities(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.listActivities(req.auth!, id) }; }
  @Post('candidates/:id/activities') @HttpCode(201) @RequirePermission('candidate.update')
  async addActivity(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.addActivity(req.auth!, id, body) }; }
  @Post('candidate-activities/:id/complete') @HttpCode(200) @RequirePermission('candidate.update')
  async completeActivity(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.completeActivity(req.auth!, id) }; }
  @Post('candidates/:id/convert') @HttpCode(201) @RequirePermission('candidate.convert')
  async convert(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.convert(req.auth!, id, body) }; }
}
