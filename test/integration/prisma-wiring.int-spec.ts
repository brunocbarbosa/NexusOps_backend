import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

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
