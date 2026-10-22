import { ErrorCode } from '@humantech/contracts';

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}
export const notFound = (what = 'resource') => new ApiError('not_found', 404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new ApiError('forbidden', 403, msg);
export const unauthenticated = (msg = 'Authentication required') => new ApiError('unauthenticated', 401, msg);
