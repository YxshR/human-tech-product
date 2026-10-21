import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createEmployee, employeeListQuery, linkLogin, updateEmployee } from '@humantech/contracts';
import { RequirePermission } from '../auth/decorators';
import { ApiError } from '../common/errors';
import { parse } from '../common/zod';
import { EmployeesService } from './employees.service';

const uuidPipe = new ParseUUIDPipe({ version: '4', exceptionFactory: () => new ApiError('not_found', 404, 'employee not found') });

@Controller('employees')
export class EmployeesController {
  constructor(@Inject(EmployeesService) private readonly svc: EmployeesService) {}

  @Get() @RequirePermission('employee.read')
  async list(@Req() req: Request, @Query() query: unknown) {
    const q = parse(employeeListQuery, query);
    const { data, nextCursor } = await this.svc.list(req.auth!, q);
    return { data, page: { nextCursor, limit: q.limit } };
  }

  /** Not gated by employee.read: employees may open their own record (profile.read_own). */
  @Get(':id')
  async get(@Req() req: Request, @Param('id', uuidPipe) id: string) {
    return { data: await this.svc.get(req.auth!, id) };
  }

  @Post() @HttpCode(201) @RequirePermission('employee.create')
  async create(@Req() req: Request, @Body() body: unknown) {
    return { data: await this.svc.create(req.auth!, parse(createEmployee, body)) };
  }

  @Patch(':id') @RequirePermission('employee.update')
  async update(@Req() req: Request, @Param('id', uuidPipe) id: string, @Body() body: unknown) {
    return { data: await this.svc.update(req.auth!, id, parse(updateEmployee, body)) };
  }

  /** Critical: whoever holds this login can read the employee's own payslips, leave and profile. */
  @Put(':id/login') @RequirePermission('user.manage')
  async linkLogin(@Req() req: Request, @Param('id', uuidPipe) id: string, @Body() body: unknown) {
    return { data: await this.svc.linkLogin(req.auth!, id, parse(linkLogin, body).userId) };
  }

  @Post(':id/archive') @HttpCode(200) @RequirePermission('employee.archive')
  async archive(@Req() req: Request, @Param('id', uuidPipe) id: string) {
    return { data: await this.svc.archive(req.auth!, id) };
  }
}
