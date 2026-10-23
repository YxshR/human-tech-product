import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators';
import { uuidParam } from '../common/params';
import { OnboardingService } from './onboarding.service';

@Controller()
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly svc: OnboardingService) {}

  @Get('onboarding/templates') @RequirePermission('onboarding.read', 'onboarding.manage')
  async templates(@Req() req: Request) { return { data: await this.svc.listTemplates(req.auth!) }; }
  @Post('onboarding/templates') @HttpCode(201) @RequirePermission('onboarding.manage')
  async createTemplate(@Req() req: Request, @Body() body: unknown) { return { data: await this.svc.createTemplate(req.auth!, body) }; }
  @Patch('onboarding/templates/:id') @RequirePermission('onboarding.manage')
  async updateTemplate(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateTemplate(req.auth!, id, body) }; }

  @Get('onboarding/my-tasks') @RequirePermission('onboarding.read', 'onboarding.manage', 'profile.read_own')
  async myTasks(@Req() req: Request) { return { data: await this.svc.myTasks(req.auth!) }; }
  @Patch('onboarding/tasks/:id') @RequirePermission('onboarding.manage', 'onboarding.read', 'profile.read_own')
  async updateTask(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateTask(req.auth!, id, body) }; }
  @Get('employees/:id/onboarding') @RequirePermission('onboarding.read', 'onboarding.manage', 'profile.read_own')
  async tasks(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.listTasks(req.auth!, id) }; }
  @Post('employees/:id/onboarding/instantiate') @HttpCode(200) @RequirePermission('onboarding.manage')
  async instantiate(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.instantiate(req.auth!, id, body) }; }
  @Post('employees/:id/onboarding/tasks') @HttpCode(201) @RequirePermission('onboarding.manage')
  async addTask(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.addTask(req.auth!, id, body) }; }
  @Post('employees/:id/onboarding/complete') @HttpCode(200) @RequirePermission('onboarding.manage')
  async complete(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.completeOnboarding(req.auth!, id, body) }; }

  @Get('employees/:id/exit') @RequirePermission('employee.exit', 'profile.read_own')
  async exit(@Req() req: Request, @Param('id', uuidParam) id: string) { return { data: await this.svc.getExit(req.auth!, id) }; }
  @Post('employees/:id/exit') @HttpCode(201) @RequirePermission('employee.exit')
  async startExit(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.startExit(req.auth!, id, body) }; }
  @Patch('exits/:id') @RequirePermission('employee.exit')
  async updateExit(@Req() req: Request, @Param('id', uuidParam) id: string, @Body() body: unknown) { return { data: await this.svc.updateExit(req.auth!, id, body) }; }
}
