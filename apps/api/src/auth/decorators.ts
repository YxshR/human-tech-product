import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from '@humantech/authz';

export const PERMISSION_KEY = 'ht:permission';
export const PUBLIC_KEY = 'ht:public';
export const NO_TENANT_KEY = 'ht:no-tenant';

/** Route requires this permission (checked after tenant membership is resolved). */
export const RequirePermission = (p: PermissionKey) => SetMetadata(PERMISSION_KEY, p);
/** Route needs no authentication at all (health probes). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Route needs a signed-in user but no tenant selected (e.g. "which companies can I enter?"). */
export const NoTenant = () => SetMetadata(NO_TENANT_KEY, true);
