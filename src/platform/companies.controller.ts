import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/enums';
import { CompanyResponse } from './company-response';
import {
  CompaniesService,
  CompanyWithAdmin,
  PaginatedCompanies,
} from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { QueryCompaniesDto } from './dto/query-companies.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

/**
 * The platform console. `@Roles` sits on the class, so a route added later is
 * ADMIN_MASTER-only by default rather than by remembering.
 *
 * `RolesGuard` checks membership in a list and not an ordering, so a company's
 * own ADMIN gets 403 here — 403 and not 404, because "you may not do this"
 * reveals nothing, while a 404 is reserved for a resource that genuinely is not
 * visible.
 */
@Roles(UserRole.ADMIN_MASTER)
@Controller('platform/companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  create(@Body() dto: CreateCompanyDto): Promise<CompanyWithAdmin> {
    return this.companies.create(dto);
  }

  @Get()
  findAll(@Query() query: QueryCompaniesDto): Promise<PaginatedCompanies> {
    return this.companies.findAll(query);
  }

  @Get(':companyId')
  findOne(
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<CompanyResponse> {
    return this.companies.findOne(companyId);
  }

  @Patch(':companyId')
  update(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: UpdateCompanyDto,
  ): Promise<CompanyResponse> {
    return this.companies.update(companyId, dto);
  }

  /** Irreversible. `PATCH { isActive: false }` is the reversible one. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':companyId')
  remove(@Param('companyId', ParseUUIDPipe) companyId: string): Promise<void> {
    return this.companies.remove(companyId);
  }
}
