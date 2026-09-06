import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { tenantIsolationExtension } from '../../src/tenancy/tenant-extension';
import { runWithTenant } from '../../src/tenancy/tenant-context';

// Regression guard for the Prisma 7 wiring: the client only works when it is
// generated as CJS, given a pg driver adapter, and run with VM modules enabled.
// See CLAUDE.md > Prisma 7 wiring.
describe('Prisma 7 wiring', () => {
  it('connects to PostgreSQL through the pg driver adapter', async () => {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
    const prisma = new PrismaClient({ adapter });
    try {
      const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
      expect(rows[0].ok).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});

// The extension classifies every model operation by name and throws on one it does
// not know, so that an operation Prisma adds in a future version cannot run
// unfiltered. That guarantee is only worth anything if somebody notices when the
// operation surface grows — TENANCY_EXTENSION.md states it, and until this suite
// existed nothing checked it. A failure here means: classify the new operation in
// `src/tenancy/tenant-extension.ts`, then re-read Part II of that document.
describe('the extension classifies every operation Prisma exposes', () => {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const scoped = prisma.$extends(tenantIsolationExtension);

  // A tenant that does not exist: every call below runs for real, so nothing may
  // be allowed to touch another test's rows.
  const nobody = randomUUID();

  /** Every method the generated delegate exposes, minus the client-level plumbing. */
  const modelOperations = (): string[] => {
    const delegate = prisma.user as unknown as object;
    const names = new Set<string>(Object.keys(delegate));
    let proto = Object.getPrototypeOf(delegate) as object | null;
    while (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) names.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return [...names]
      .filter(
        (name) =>
          !name.startsWith('_') &&
          !name.startsWith('$') &&
          name !== 'constructor' &&
          name !== 'fields' &&
          name !== 'name',
      )
      .sort();
  };

  // MongoDB-only, unreachable on PostgreSQL, and refused rather than passed through.
  const REFUSED = new Set(['findRaw', 'aggregateRaw']);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('exposes the operation surface this repository was written against', () => {
    // Not a snapshot for its own sake: a new name here is the signal to read the
    // extension before trusting it, which is exactly what the next test enforces.
    expect(modelOperations().length).toBeGreaterThanOrEqual(19);
  });

  it('refuses no operation except the two MongoDB-only ones', async () => {
    const refusedByExtension: string[] = [];

    for (const operation of modelOperations()) {
      const call = (
        scoped as unknown as Record<
          string,
          Record<string, (args: unknown) => Promise<unknown>>
        >
      ).user[operation];

      try {
        await runWithTenant(nobody, async () => {
          await call({});
        });
      } catch (error) {
        // Anything else — a validation error for the empty argument, most of all —
        // means the call got past the extension, which is all this asserts.
        if ((error as Error).name === 'TenantScopeUnknownOperationError') {
          refusedByExtension.push(operation);
        }
      }
    }

    expect(refusedByExtension.sort()).toEqual([...REFUSED].sort());
  });
});
