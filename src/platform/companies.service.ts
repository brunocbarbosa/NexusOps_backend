import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HashingService } from '../auth/hashing.service';
import { Prisma, Tenant } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { runWithTenant, runWithoutTenant } from '../tenancy/tenant-context';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { UserResponse, toUserResponse } from '../users/user-response';
import { CompanyResponse, toCompanyResponse } from './company-response';
import { CreateCompanyDto } from './dto/create-company.dto';
import { QueryCompaniesDto } from './dto/query-companies.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

export type PaginatedCompanies = {
  data: CompanyResponse[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

export type CompanyWithAdmin = {
  company: CompanyResponse;
  admin: UserResponse;
};

/**
 * The ADMIN_MASTER's view of the customer companies.
 *
 * Every query here runs inside `runWithoutTenant()`, and that is not a
 * convenience: `Tenant` is the one model in `TENANT_AGNOSTIC`, and under a
 * tenant scope the extension rewrites a `Tenant` read to `where.id = <current
 * tenant>` — which for the ADMIN_MASTER would return the platform row and
 * nothing else. Unscoped is the only shape in which "every company" is a
 * question that can be asked, and it has to be asked out loud.
 *
 * The platform tenant itself is never a company. `requireCompany()` is the one
 * place that says so, and `findAll` filters it out.
 */
@Injectable()
export class CompaniesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly hashing: HashingService,
  ) {}

  /**
   * Creates a company, its first ADMIN and its ticket counter, in one transaction.
   *
   * This is the transaction that used to be `AuthService.register`, moved rather
   * than rewritten when company creation became the operator's job. The delicate
   * part is unchanged: the scope changes halfway through a single transaction,
   * because `Tenant` is tenant-agnostic and `User` is not. Both halves must
   * commit together — a duplicate domain that left a tenant behind would leave a
   * company nobody can enter.
   */
  async create(dto: CreateCompanyDto): Promise<CompanyWithAdmin> {
    // Outside the transaction on purpose: bcrypt at production cost takes
    // hundreds of milliseconds, and holding a connection open for it is how a
    // burst exhausts the pool.
    const passwordHash = await this.hashing.hash(dto.admin.password);

    try {
      return await runWithoutTenant(() =>
        this.prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: { name: dto.name, domain: dto.domain },
          });

          const admin = await runWithTenant(tenant.id, async () => {
            // The row the ticket sequence increments. Created with the company
            // rather than upserted when the first ticket is opened: two
            // concurrent first opens would both find it missing, both insert,
            // and one would die on the primary key. Created here also means the
            // increment can be a plain update, which is what lets the tenancy
            // extension supply the filter instead of the service naming a tenant.
            await tx.ticketCounter.create({ data: tenantScoped({}) });

            return tx.user.create({
              data: tenantScoped({
                email: dto.admin.email,
                passwordHash,
                role: UserRole.ADMIN,
              }),
            });
          });

          return {
            company: toCompanyResponse(tenant),
            admin: toUserResponse(admin),
          };
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `The domain "${dto.domain}" is already registered`,
        );
      }
      throw error;
    }
  }

  async findAll(query: QueryCompaniesDto): Promise<PaginatedCompanies> {
    const where: Prisma.TenantWhereInput = {
      // Every company has `is_platform` NULL; the reserved row has `true`. An
      // exact match, where `domain: { not: "platform" }` would silently drop
      // every company whose domain is NULL, because NOT (NULL = 'platform') is
      // NULL rather than true.
      isPlatform: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { domain: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // One round trip for both halves, so a concurrent write cannot land between
    // them and return a total that does not match the page.
    const [total, tenants] = await runWithoutTenant(() =>
      this.prisma.$transaction([
        this.prisma.tenant.count({ where }),
        this.prisma.tenant.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.perPage,
          take: query.perPage,
        }),
      ]),
    );

    return {
      data: tenants.map(toCompanyResponse),
      meta: {
        total,
        page: query.page,
        perPage: query.perPage,
        totalPages: Math.ceil(total / query.perPage) || 1,
      },
    };
  }

  async findOne(id: string): Promise<CompanyResponse> {
    return toCompanyResponse(await this.requireCompany(id));
  }

  async update(id: string, dto: UpdateCompanyDto): Promise<CompanyResponse> {
    const company = await this.requireCompany(id);

    try {
      const updated = await runWithoutTenant(() =>
        this.prisma.tenant.update({
          where: { id: company.id },
          data: { name: dto.name, domain: dto.domain, isActive: dto.isActive },
        }),
      );
      return toCompanyResponse(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `The domain "${dto.domain}" is already registered`,
        );
      }
      throw error;
    }
  }

  /**
   * Deletes a company for real, and everything that belonged to it.
   *
   * Irreversible, unlike deactivating a user. Every child relation cascades from
   * `Tenant`, including the audit trail — measured against the running database
   * rather than reasoned about, because `audit_logs.user_id` and
   * `tickets.assignee_id` are `ON DELETE RESTRICT` and a cascade that reached the
   * users first would be refused. It is not: the rows referencing a user are
   * removed by their own tenant cascade within the same statement, so nothing is
   * left to restrict.
   *
   * `PATCH { isActive: false }` is the reversible option, and `AuthService.login`
   * already refuses an inactive tenant.
   */
  async remove(id: string): Promise<void> {
    const company = await this.requireCompany(id);

    await runWithoutTenant(() =>
      this.prisma.tenant.delete({ where: { id: company.id } }),
    );
  }

  /**
   * Loads a company, or 404s — including for the platform tenant itself.
   *
   * The chokepoint of every nested route. Two distinct things would break
   * without it, and only the first is obvious:
   *
   * `runWithTenant()` accepts any non-empty string, so an id that belongs to no
   * company would open a scope over nothing and `GET .../users` would answer an
   * empty page — "this company has no users" instead of "there is no such
   * company".
   *
   * And the platform tenant is not a company. Without the second half of the
   * check, `/platform/companies/<platform-id>/users/<self>` would let the
   * ADMIN_MASTER deactivate itself, leaving an installation with no operator and
   * no way to mint another except by rebooting.
   */
  async requireCompany(id: string): Promise<Tenant> {
    const tenant = await runWithoutTenant(() =>
      this.prisma.tenant.findUnique({ where: { id } }),
    );

    if (!tenant || tenant.isPlatform) {
      throw new NotFoundException(`No company ${id}`);
    }

    return tenant;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
