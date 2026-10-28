/** Thrown when a request names a tenant that is neither configured nor auto-provisionable. */
export class UnknownTenantError extends Error {
  constructor(readonly tenantId: string) {
    super(`unknown tenant: ${tenantId}`);
  }
}
