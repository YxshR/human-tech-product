import { AuthContext } from '@humantech/authz';

export interface RequestAuth extends AuthContext {
  email: string;
  requestId: string;
}
