import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { notFound } from '../common/errors';
import { uuidParam } from '../common/params';
import { CompensationService } from './compensation.service';

@Controller('compensation')
export class CompensationController {
  constructor(@Inject(CompensationService) private readonly svc: CompensationService) {}

  @Get('components') @RequirePermission('salary_structure.read')
  async components(@Req() req: Request) { return { data: await this.svc.listComponents(req.auth!) }; }
  @Post('components') @HttpCode(201) @RequirePermission('salary_structure.manage')
  async createComponent(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createComponent(req.auth!, body) }; }
  @Patch('components/:id') @RequirePermission('salary_structure.manage')
  async updateComponent(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateComponent(req.auth!, id, body) }; }
  @Post('components/:id/versions') @HttpCode(201) @RequirePermission('salary_structure.manage')
  async createVersion(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.createVersion(req.auth!, id, body) }; }
  @Post('component-versions/:id/activate') @HttpCode(200) @RequirePermission('salary_structure.manage')
  async activateVersion(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setVersionStatus(req.auth!, id, 'active') }; }
  @Post('component-versions/:id/retire') @HttpCode(200) @RequirePermission('salary_structure.manage')
  async retireVersion(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setVersionStatus(req.auth!, id, 'retired') }; }
  @Delete('component-versions/:id') @HttpCode(204) @RequirePermission('salary_structure.manage')
  async deleteVersion(@Req() req: Request, @Param('id', uuidParam) id: string) { await this.svc.deleteDraftVersion(req.auth!, id); }

  @Get('structures') @RequirePermission('salary_structure.read')
  async structures(@Req() req: Request) { return { data: await this.svc.listStructures(req.auth!) }; }
  @Post('structures') @HttpCode(201) @RequirePermission('salary_structure.manage')
  async createStructure(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createStructure(req.auth!, body) }; }
  @Patch('structures/:id') @RequirePermission('salary_structure.manage')
  async updateStructure(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateStructure(req.auth!, id, body) }; }
  @Post('structures/:id/activate') @HttpCode(200) @RequirePermission('salary_structure.manage')
  async activateStructure(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setStructureStatus(req.auth!, id, 'active') }; }
  @Post('structures/:id/retire') @HttpCode(200) @RequirePermission('salary_structure.manage')
  async retireStructure(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.setStructureStatus(req.auth!, id, 'retired') }; }
  @Post('structures/:id/new-version') @HttpCode(201) @RequirePermission('salary_structure.manage')
  async newVersion(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.newStructureVersion(req.auth!, id) }; }

  @Get('assignments') @RequirePermission('salary.read_assignment')
  async assignments(@Req() req: Request, @Query('employeeId') employeeId?: string) {
    if (!employeeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employeeId)) throw notFound('employee');
    return { data: await this.svc.listAssignments(req.auth!, employeeId) };
  }
  @Get('assignments/pending') @RequirePermission('salary.approve_assignment')
  async pending(@Req() req: Request) { return { data: await this.svc.pendingAssignments(req.auth!) }; }
  @Post('assignments') @HttpCode(201) @RequirePermission('salary.assign')
  async propose(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.propose(req.auth!, body) }; }
  @Post('assignments/:id/approve') @HttpCode(200) @RequirePermission('salary.approve_assignment')
  async approve(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.review(req.auth!, id, 'approve', body) }; }
  @Post('assignments/:id/reject') @HttpCode(200) @RequirePermission('salary.approve_assignment')
  async reject(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.review(req.auth!, id, 'reject', body) }; }
}
