import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { tenantIsolationExtension } from '../tenancy/tenant-extension';
import { currentTransaction } from '../tenancy/tenant-store';

/**
 * The one place a Prisma client is built.
 *
 * Three things are non-negotiable here and all are documented in CLAUDE.md: the
 * `pg` driver adapter, which Prisma 7 requires for SQL providers,
 * `$extends(tenantIsolationExtension)`, which is what makes "I forgot to scope
 * this query" unreachable, and the proxy below, which is what makes every query
 * land on the connection that knows which tenant is asking. A client
 * constructed anywhere else has none of them, so this factory exists to make
 * the un-extended client the awkward path rather than the default one.
 *
 * The integration suites call this too. A test that builds its own client is a
 * test that proves nothing about the client the application actually runs — the
 * only exceptions are `test/integration/tenant-isolation.int-spec.ts`, which
 * deliberately uses a bare client to show what the schema does *without* the
 * extension, and `test/integration/rls.int-spec.ts`, which uses one to show what
 * the database does without either.
 */
export function createPrismaClient(connectionString: string) {
  // Pool settings live on the adapter in v7, not on PrismaClient.
  const adapter = new PrismaPg({ connectionString });
  const base = new PrismaClient({ adapter }).$extends(tenantIsolationExtension);
  return withOpenTransaction(base);
}

/**
 * `$extends` returns a proxy whose type is not `PrismaClient`, so the usual
 * `class PrismaService extends PrismaClient` pattern cannot be used and the type
 * has to be inferred from the factory.
 */
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * Client methods that must never be answered by a transaction.
 *
 * `$connect` / `$disconnect` are the load-bearing pair: Prisma removes them from
 * an interactive transaction client, so without this exception
 * `PrismaModule.onModuleDestroy` would read `undefined` mid-request and the e2e
 * suites would hang on shutdown. The other three are the rest of
 * `ITXClientDenyList`, routed here for the same reason rather than left to
 * return `undefined` from a `tx`.
 */
const CLIENT_ONLY: ReadonlySet<string | symbol> = new Set([
  '$connect',
  '$disconnect',
  '$on',
  '$use',
  '$extends',
]);

/**
 * Routes every query to the transaction the current scope opened.
 *
 * This is the other half of `TenantScopeService`: the scope sets
 * `app.tenant_id` on one connection, and this makes sure the queries that follow
 * run on *that* connection rather than on whichever one the pool hands out next.
 * Without it the tenant would be set on a connection nobody queries, and under
 * Row-Level Security every read would come back empty — silently. See
 * documents/RLS_DESIGN.md, Part II.
 *
 * Model delegates and the raw-SQL methods follow the transaction. When there is
 * none, they fall through to the base client, which under RLS fails closed.
 */
function withOpenTransaction<T extends object>(base: T): T {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return reentrantTransaction(target as TransactionCapable);
      }

      const source =
        CLIENT_ONLY.has(property) || currentTransaction() === null
          ? target
          : (currentTransaction() as object);

      // `unknown` and not `any`: a proxy trap is where types stop being checked,
      // so the one place that reads an arbitrary property should say so.
      const value: unknown = Reflect.get(source, property, receiver);

      // Bound to where it came from: Prisma's methods read their own internals
      // off `this`, and handing them the proxy as a receiver would send those
      // reads back through this trap.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(source)
        : value;
    },
  });
}

type TransactionCapable = {
  $transaction(...args: unknown[]): unknown;
};

/**
 * `$transaction` becomes re-entrant, in both of its forms.
 *
 * Given a callback, it runs it with the transaction that already exists rather
 * than opening another — Prisma would refuse the nesting anyway. Given an array,
 * it awaits the elements in order: they were created *on the transaction* by the
 * proxy above, so they are already in one transaction and the batching was only
 * ever a round-trip optimisation.
 *
 * This is what makes all nine existing `$transaction` call sites keep working
 * untouched. Two of them change what they guarantee rather than breaking, and
 * both are named in documents/RLS_DESIGN.md, Part II: `TicketsService.create()`
 * holds the ticket-counter row lock until the request commits, and
 * `TicketsService.mutate()` emits inside an open transaction — which is what
 * `DomainEvents` exists to make safe.
 */
function reentrantTransaction(target: TransactionCapable) {
  return (argument: unknown, options?: unknown): unknown => {
    const tx = currentTransaction();

    if (tx === null) {
      return options === undefined
        ? target.$transaction(argument)
        : target.$transaction(argument, options);
    }

    if (typeof argument === 'function') {
      return (argument as (tx: unknown) => unknown)(tx);
    }

    // Sequential rather than `Promise.all`: they share one connection, so
    // dispatching them together would only queue them behind each other anyway,
    // and awaiting in order keeps the failure attributable to one element.
    return (async () => {
      const results: unknown[] = [];
      for (const promise of argument as unknown[]) {
        results.push(await promise);
      }
      return results;
    })();
  };
}

/**
 * Injection token for the client above. It lives next to the factory because
 * every call site needs both — the token to inject and the type to annotate —
 * and importing them from the module file instead would point feature modules
 * at `PrismaModule` for a type they only use structurally.
 */
export const PRISMA = Symbol('PRISMA');

/**
 * The client handed to an interactive `$transaction(async (tx) => ...)`.
 *
 * `Prisma.TransactionClient` in the generated namespace is `Omit<
 * DefaultPrismaClient, ITXClientDenyList>` — the *unextended* client — so it is
 * the wrong type here: annotating a helper with it would quietly drop the
 * tenancy extension from the type and let a call slip through that the running
 * code would still scope, or worse, one it would not.
 *
 * The omitted keys are ITXClientDenyList spelled out. They are the operations
 * that make no sense once a transaction is already open, and Prisma removes
 * them at runtime whether or not the type says so.
 *
 * It exists as a named export because a service that wants one OCC chokepoint
 * has to pass `tx` to a private helper, and a helper needs a parameter type.
 */
export type ExtendedTransactionClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
