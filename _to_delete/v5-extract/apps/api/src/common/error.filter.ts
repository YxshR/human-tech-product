import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ErrorCode, SQLSTATE_TO_ERROR } from '@humantech/contracts';
import { ApiError } from './errors';

const HTTP_CODES: Record<number, ErrorCode> = {
  400: 'validation_failed', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict',
  413: 'payload_too_large', 415: 'unsupported_media_type', 422: 'validation_failed', 429: 'rate_limited',
};

function isZodLike(e: unknown): e is ZodError {
  return (e as { name?: unknown } | null)?.name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues);
}

function isHttpLike(e: unknown): e is { status: number } {
  const s = (e as { status?: unknown; statusCode?: unknown } | null)?.status ?? (e as { statusCode?: unknown } | null)?.statusCode;
  if (typeof s === 'number' && s >= 400 && s < 500 && typeof (e as { type?: unknown }).type === 'string') {
    (e as { status: number }).status = s;
    return true;
  }
  return false;
}

/** One place that turns every failure into the documented error body. Internal details never leak. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId ?? 'unknown';
    let status = 500;
    let code: ErrorCode = 'internal_error';
    let message = 'Something went wrong';
    let fields: Array<{ path: string; message: string }> | undefined;

    if (exception instanceof ApiError) {
      ({ status, code, message, fields } = exception);
    } else if (exception instanceof ZodError || isZodLike(exception)) {
      status = 422; code = 'validation_failed'; message = 'The request is invalid';
      fields = (exception as ZodError).issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = HTTP_CODES[status] ?? 'internal_error';
      message = status >= 500 ? 'Something went wrong' : exception.message;
    } else if (isHttpLike(exception)) {
      // body-parser and friends: e.g. 413 payload too large, 400 malformed JSON
      status = exception.status;
      code = HTTP_CODES[status] ?? 'validation_failed';
      message = status === 413 ? 'The request body is too large' : status === 400 ? 'The request body is malformed' : 'The request could not be processed';
    } else if (typeof (exception as { code?: unknown })?.code === 'string' && SQLSTATE_TO_ERROR[(exception as { code: string }).code]) {
      const mapped = SQLSTATE_TO_ERROR[(exception as { code: string }).code]!;
      status = mapped.status; code = mapped.code;
      // DB messages for our own HT* controls are written for humans; others are generic.
      const raw = (exception as { code: string; message?: string }).message ?? '';
      message = (exception as { code: string }).code.startsWith('HT') ? raw : 'The request conflicts with existing data';
    }

    if (status >= 500) {
      this.log.error(`${req.method} ${req.url} [${requestId}] ${(exception as Error)?.stack ?? String(exception)}`);
    }
    res.status(status).json({ error: { code, message, requestId, ...(fields ? { fields } : {}) } });
  }
}
