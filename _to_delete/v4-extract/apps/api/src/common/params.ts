import { ParseUUIDPipe } from '@nestjs/common';
import { ApiError } from './errors';

/** Malformed ids are "not found", never a 500 or a validation oracle. */
export const uuidParam = new ParseUUIDPipe({ exceptionFactory: () => new ApiError('not_found', 404, 'resource not found') });
