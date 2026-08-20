/**
 * Proves the built image can actually reach PostgreSQL through the generated
 * Prisma client.
 *
 * The Dockerfile deletes the Prisma CLI, Studio, the legacy engines and every
 * query compiler that is not PostgreSQL, on the argument that none of it is
 * reachable at runtime. That argument is only worth as much as this check: the
 * removed files are loaded lazily, so a broken prune shows up on the first real
 * query and nowhere earlier. Booting the HTTP server would not catch it.
 *
 * Run inside the container, against a live database:
 *   docker run --rm --network <net> -e DATABASE_URL=... image \
 *     node scripts/docker-smoke.js
 */
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('/app/dist/generated/prisma/client');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    // Raw SQL exercises the adapter and the connection.
    const [{ ok }] = await prisma.$queryRaw`SELECT 1 AS ok`;
    if (Number(ok) !== 1) {
      throw new Error(`unexpected result: ${ok}`);
    }

    // A model query exercises the WASM query compiler, which is the part the
    // prune actually touches. $queryRaw alone would not reach it.
    const tenants = await prisma.tenant.count();
    console.log(`prisma smoke ok: raw=1, tenant.count=${tenants}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('prisma smoke FAILED:', error);
  process.exit(1);
});
