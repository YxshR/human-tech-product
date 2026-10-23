import { ZodTypeAny, z } from 'zod';

/** Parse with a Zod schema; ZodError is turned into a 422 by the global filter. */
export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}
