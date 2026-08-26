import { Tenant } from '../generated/prisma/client';

/**
 * A company, as the platform console sees it.
 *
 * `Tenant` is the infrastructure word and `company` is the business one; the
 * platform API speaks the second. `isPlatform` is deliberately absent: the
 * reserved row never reaches this shape, because every route that could return
 * one 404s on it first.
 */
export type CompanyResponse = {
  id: string;
  name: string;
  domain: string | null;
  isActive: boolean;
  createdAt: Date;
};

/** An allowlist, not a denylist: a new column is invisible until added here. */
export function toCompanyResponse(tenant: Tenant): CompanyResponse {
  return {
    id: tenant.id,
    name: tenant.name,
    domain: tenant.domain,
    isActive: tenant.isActive,
    createdAt: tenant.createdAt,
  };
}
