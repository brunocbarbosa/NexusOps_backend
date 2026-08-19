import { Prisma } from '../generated/prisma/client';
import {
  TenantContextMissingError,
  currentScope,
  requireTenantId,
} from './tenant-context';

/**
 * Injects the tenant filter into every Prisma operation.
 *
 * This is a chokepoint, not a convention: it hooks $allOperations on $allModels, so
 * "I forgot to scope this query" is not a reachable state. Services must never write
 * a tenant filter by hand -- a hand-written filter is one that can be wrong.
 *
 * What it does NOT cover, measured against Prisma 7.9.1:
 *  - $queryRaw / $executeRaw. Those are client operations, not model operations, so
 *    they never reach this hook. Row-Level Security is the only cover for them.
 *  - Nested access. `include: {}` intercepts only the parent operation, and so does a
 *    nested create. That hole is closed in the schema instead: child relations use
 *    composite foreign keys against @@unique([tenantId, id]), which makes a
 *    cross-tenant child both unwritable and non-existent.
 *
 * See docs/superpowers/specs/2026-08-19-tenant-isolation-chokepoint-design.md
 */

/** Models with no tenantId column. Everything absent from this set is scoped. */
const TENANT_AGNOSTIC: ReadonlySet<string> = new Set(['Tenant']);

/** Filtered through `where`. */
const WHERE_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'delete',
  'deleteMany',
]);

/** Filtered through `where`, and must not be allowed to rewrite tenantId in `data`. */
const UPDATE_OPERATIONS: ReadonlySet<string> = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
]);

/** The tenant is stamped into `data`. */
const CREATE_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

/** MongoDB-only; unreachable on PostgreSQL, rejected rather than silently passed. */
const UNSUPPORTED_OPERATIONS: ReadonlySet<string> = new Set([
  'findRaw',
  'aggregateRaw',
]);

type AnyArgs = Record<string, unknown>;

export class CrossTenantWriteError extends Error {
  constructor(
    model: string,
    operation: string,
    supplied: string,
    current: string,
  ) {
    super(
      `${model}.${operation} was given tenantId "${supplied}" while the active tenant ` +
        `is "${current}". Writing into another tenant is a bug, so this is rejected ` +
        `rather than silently overwritten.`,
    );
    this.name = 'CrossTenantWriteError';
  }
}

export class TenantScopeUnknownOperationError extends Error {
  constructor(model: string, operation: string) {
    super(
      `${model}.${operation} is not a known operation, so the tenant filter cannot be ` +
        `applied and the query is refused. This usually means Prisma added an operation: ` +
        `classify it in src/tenancy/tenant-extension.ts.`,
    );
    this.name = 'TenantScopeUnknownOperationError';
  }
}

/** Prisma accepts both `tenantId: 'x'` and `tenantId: { set: 'x' }`, so neither form
 * can be assumed to be a string when it lands in an error message. */
function describeTenantValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function scopeWhere(args: AnyArgs, tenantId: string): AnyArgs {
  const where = (args.where ?? {}) as AnyArgs;
  // Injected last on purpose: a caller-supplied tenant filter is harmless to override.
  return { ...args, where: { ...where, tenantId } };
}

function stampTenant(
  data: unknown,
  tenantId: string,
  model: string,
  operation: string,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => stampTenant(row, tenantId, model, operation));
  }
  const row = (data ?? {}) as AnyArgs;
  const supplied = row.tenantId;
  if (supplied !== undefined && supplied !== tenantId) {
    throw new CrossTenantWriteError(
      model,
      operation,
      describeTenantValue(supplied),
      tenantId,
    );
  }
  return { ...row, tenantId };
}

/**
 * An update may not touch tenantId at all. The `where` filter already confines it to
 * the caller's own rows, but `data: { tenantId: other }` would move a row *out* of the
 * tenant, which is a leak the where-filter does not catch.
 */
function rejectTenantRewrite(
  data: unknown,
  model: string,
  operation: string,
): void {
  if (data && typeof data === 'object' && 'tenantId' in data) {
    throw new CrossTenantWriteError(
      model,
      operation,
      describeTenantValue((data as AnyArgs).tenantId),
      'immutable',
    );
  }
}

/**
 * Tenant is exempt from tenant filtering, but not left unguarded: without this,
 * `tenant.findMany({ include: { tickets: true } })` would read every tenant's rows.
 *
 * Running unscoped requires runWithoutTenant() explicitly. Having no context at all is
 * refused like anywhere else, so a lost context cannot quietly widen a Tenant read
 * into a read of every tenant.
 */
function scopeAgnostic(operation: string, args: AnyArgs): AnyArgs {
  const scope = currentScope();

  if (scope.kind === 'none') {
    throw new TenantContextMissingError();
  }
  if (scope.kind === 'unscoped') {
    return args;
  }
  if (WHERE_OPERATIONS.has(operation) || UPDATE_OPERATIONS.has(operation)) {
    const where = (args.where ?? {}) as AnyArgs;
    return { ...args, where: { ...where, id: scope.tenantId } };
  }
  return args;
}

function scope(
  model: string,
  operation: string,
  args: AnyArgs,
  tenantId: string,
): AnyArgs {
  if (WHERE_OPERATIONS.has(operation)) {
    return scopeWhere(args, tenantId);
  }

  if (UPDATE_OPERATIONS.has(operation)) {
    rejectTenantRewrite(args.data, model, operation);
    return scopeWhere(args, tenantId);
  }

  if (CREATE_OPERATIONS.has(operation)) {
    return {
      ...args,
      data: stampTenant(args.data, tenantId, model, operation),
    };
  }

  if (operation === 'upsert') {
    rejectTenantRewrite(args.update, model, operation);
    return {
      ...scopeWhere(args, tenantId),
      create: stampTenant(args.create, tenantId, model, operation),
    };
  }

  // Fail closed. An operation nobody classified must not run unfiltered.
  throw new TenantScopeUnknownOperationError(model, operation);
}

export const tenantIsolationExtension = Prisma.defineExtension({
  name: 'tenant-isolation',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (UNSUPPORTED_OPERATIONS.has(operation)) {
          throw new TenantScopeUnknownOperationError(model, operation);
        }

        const incoming = args ?? {};

        const scoped = TENANT_AGNOSTIC.has(model)
          ? scopeAgnostic(operation, incoming)
          : scope(model, operation, incoming, requireTenantId());

        return query(scoped);
      },
    },
  },
});
