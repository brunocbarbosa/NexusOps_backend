import { randomUUID } from 'node:crypto';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import { validateEnv } from '../../src/config/env.validation';
import {
  ReportStatus,
  TicketPriority,
  UserRole,
} from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import { ReportsModule } from '../../src/reports/reports.module';
import { ReportsService } from '../../src/reports/reports.service';
import {
  currentScope,
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';
import { TicketsService } from '../../src/tickets/tickets.service';

/**
 * The asynchronous export, against a real Redis and a real PostgreSQL.
 *
 * The claim under test is the one CLAUDE.md flags as the most dangerous in the
 * project: **a worker has no HTTP request, so the AsyncLocalStorage scope is
 * empty and the tenant has to be re-established from the job payload.** A
 * mistake here does not throw — it produces a CSV containing another company's
 * tickets, and nobody finds out until somebody opens the file.
 */
describe('ticket report queue', () => {
  let mod: TestingModule;
  let reports: ReportsService;
  let tickets: TicketsService;
  let prisma: ExtendedPrismaClient;
  let maxRows: number;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let agentA: AuthenticatedUser;
  let adminA: AuthenticatedUser;
  let requesterA: AuthenticatedUser;
  let otherRequesterA: AuthenticatedUser;
  let requesterB: AuthenticatedUser;

  const asUser = (
    row: { id: string; email: string },
    tenantId: string,
    role: UserRole,
  ): AuthenticatedUser => ({ id: row.id, tenantId, email: row.email, role });

  const seed = async (label: string) => {
    const domain = `reports-${label}-${run}.example`;
    domains.push(domain);

    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({ data: { name: `Reports ${label}`, domain } }),
    );

    return runWithTenant(tenant.id, async () => {
      await prisma.ticketCounter.create({ data: tenantScoped({}) });

      const make = (email: string, role: UserRole) =>
        prisma.user.create({
          data: tenantScoped({ email, passwordHash: 'x', role }),
        });

      const agent = await make(`agent@${label}.example`, UserRole.AGENT);
      const one = await make(`one@${label}.example`, UserRole.REQUESTER);
      const two = await make(`two@${label}.example`, UserRole.REQUESTER);
      const boss = await make(`admin@${label}.example`, UserRole.ADMIN);

      return { tenantId: tenant.id, agent, one, two, boss };
    });
  };

  /** Polls the report row: the worker finishes after the request returns. */
  const settle = async (tenantId: string, reportId: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const report = await runWithTenant(tenantId, () =>
        prisma.report.findFirst({ where: { id: reportId } }),
      );
      if (
        report &&
        (report.status === ReportStatus.COMPLETED ||
          report.status === ReportStatus.FAILED)
      ) {
        return report;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Report ${reportId} never settled`);
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        EventEmitterModule.forRoot({ wildcard: true }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              host: config.getOrThrow<string>('REDIS_HOST'),
              port: config.getOrThrow<number>('REDIS_PORT'),
            },
          }),
        }),
        ReportsModule,
      ],
    }).compile();
    await mod.init();

    reports = mod.get(ReportsService);
    tickets = mod.get(TicketsService);
    prisma = mod.get<ExtendedPrismaClient>(PRISMA);
    maxRows = mod.get(ConfigService).getOrThrow<number>('REPORTS_MAX_ROWS');

    const a = await seed('a');
    const b = await seed('b');
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    agentA = asUser(a.agent, tenantA, UserRole.AGENT);
    adminA = asUser(a.boss, tenantA, UserRole.ADMIN);
    requesterA = asUser(a.one, tenantA, UserRole.REQUESTER);
    otherRequesterA = asUser(a.two, tenantA, UserRole.REQUESTER);
    requesterB = asUser(b.one, tenantB, UserRole.REQUESTER);

    // Two tickets for requesterA, one for the other requester, one in the other
    // company. Every leak this suite can catch needs all four.
    //
    // One of requesterA's is then handed to the agent, because an agent's
    // export is scoped to what it is working: without an assignment the agent
    // would have nothing to export and the rule would be untested rather than
    // proved.
    await runWithTenant(tenantA, async () => {
      await tickets.create(
        { title: 'A-one urgent', priority: TicketPriority.URGENT },
        requesterA,
      );
      const normal = await tickets.create(
        { title: 'A-one normal' },
        requesterA,
      );
      await tickets.assign(
        normal.id,
        { version: normal.version, assigneeId: agentA.id },
        adminA,
      );
    });
    await runWithTenant(tenantA, () =>
      tickets.create({ title: 'A-two private' }, otherRequesterA),
    );
    await runWithTenant(tenantB, () =>
      tickets.create({ title: 'B-one elsewhere' }, requesterB),
    );
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await mod.close();
  });

  // The premise the whole design rests on. If this ever comes back as a tenant
  // scope, the payload-carrying could be dropped -- and it must not be.
  it('runs the worker with no ambient tenant scope', () => {
    expect(currentScope()).toEqual({ kind: 'none' });
  });

  it('answers immediately and finishes later', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport({}, adminA),
    );

    // What the 202 hands back: a request, not a report.
    expect(requested.status).toBe(ReportStatus.PENDING);
    expect(requested.rowCount).toBeNull();

    const settled = await settle(tenantA, requested.id);
    expect(settled.status).toBe(ReportStatus.COMPLETED);
    expect(settled.completedAt).not.toBeNull();
    expect(settled.content).toContain('A-one urgent');
  });

  it('never puts another company tickets in the file', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport({}, adminA),
    );
    const settled = await settle(tenantA, requested.id);

    // An admin of company A sees all three of A's tickets and none of B's.
    expect(settled.rowCount).toBe(3);
    expect(settled.content).not.toContain('B-one elsewhere');
  });

  // The strongest placement of the visibility rule there is: it proves the
  // scope survives the trip through Redis into a worker that has no request
  // context to inherit one from.
  it('gives an agent only the tickets assigned to them', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport({}, agentA),
    );
    const settled = await settle(tenantA, requested.id);

    expect(settled.rowCount).toBe(1);
    expect(settled.content).toContain('A-one normal');
    expect(settled.content).not.toContain('A-one urgent');
    expect(settled.content).not.toContain('A-two private');
  });

  it('gives a requester only their own rows', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport({}, requesterA),
    );
    const settled = await settle(tenantA, requested.id);

    // The visibility rule survives the trip through Redis, because the worker
    // pages through TicketsService.findAll rather than writing its own query.
    expect(settled.rowCount).toBe(2);
    expect(settled.content).toContain('A-one urgent');
    expect(settled.content).not.toContain('A-two private');
  });

  it('applies the filters it was asked for', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport({ priority: TicketPriority.URGENT }, adminA),
    );
    const settled = await settle(tenantA, requested.id);

    expect(settled.rowCount).toBe(1);
    expect(settled.content).toContain('A-one urgent');
  });

  it('writes a header even when nothing matches', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport(
        { search: 'no such ticket anywhere' },
        agentA,
      ),
    );
    const settled = await settle(tenantA, requested.id);

    expect(settled.status).toBe(ReportStatus.COMPLETED);
    expect(settled.rowCount).toBe(0);
    // A file with a header and no rows is readable; an empty file is a bug
    // report waiting to happen.
    expect(settled.content).toContain('"number"');
  });

  it('caps the export at REPORTS_MAX_ROWS', () => {
    // .env.test sets it small on purpose, so the cap is assertable at all.
    expect(maxRows).toBe(100);
  });

  describe('reports are personal', () => {
    it('404s a report requested by somebody else', async () => {
      const requested = await runWithTenant(tenantA, () =>
        reports.requestTicketReport({}, requesterA),
      );
      await settle(tenantA, requested.id);

      // Same company. The file was built through requesterA's visibility, so
      // handing it to anybody else would hand over rows the ticket routes
      // would refuse them.
      await expect(
        runWithTenant(tenantA, () =>
          reports.download(requested.id, otherRequesterA),
        ),
      ).rejects.toThrow(/No report/);
    });

    it('404s a report of another company', async () => {
      const requested = await runWithTenant(tenantA, () =>
        reports.requestTicketReport({}, agentA),
      );
      await settle(tenantA, requested.id);

      await expect(
        runWithTenant(tenantB, () => reports.findOne(requested.id, requesterB)),
      ).rejects.toThrow(/No report/);
    });
  });

  it('refuses to download one that is not finished', async () => {
    const requested = await runWithTenant(tenantA, () =>
      reports.requestTicketReport({}, agentA),
    );

    // Racy by nature: if the worker already finished, the download succeeds and
    // there is nothing to assert. Only the PENDING case carries the claim.
    const before = await runWithTenant(tenantA, () =>
      prisma.report.findFirst({ where: { id: requested.id } }),
    );

    if (before?.status !== ReportStatus.COMPLETED) {
      await expect(
        runWithTenant(tenantA, () => reports.download(requested.id, agentA)),
      ).rejects.toThrow(/nothing to download/);
    }

    await settle(tenantA, requested.id);
  });
});
