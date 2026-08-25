import { UserRole } from '../generated/prisma/enums';

/**
 * Who may administer the users of a company.
 *
 * Two roles, for two different reasons: the company's own `ADMIN`, and the
 * platform's `ADMIN_MASTER` acting *inside* that company through
 * `/platform/companies/:companyId/users`, where the tenant scope is opened
 * explicitly by `runWithTenant()` rather than by the request's own token.
 *
 * A named predicate rather than a second role check inlined in two places, and
 * emphatically not a synthetic `requester` with `role: ADMIN` handed to
 * `UsersService`: that would be a lie in the one argument the service uses to
 * decide what the caller may see, and it would survive every later reading of
 * the code as if it were true.
 *
 * `RolesGuard` is unaffected and stays non-hierarchical — it checks membership
 * in a list, never an ordering. This is not "ADMIN_MASTER outranks ADMIN"; it is
 * the two roles that answer yes to one specific question.
 */
export function administersUsers(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.ADMIN_MASTER;
}
