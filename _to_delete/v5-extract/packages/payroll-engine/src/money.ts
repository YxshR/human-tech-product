import Decimal from 'decimal.js';
import { Rounding, RoundingMode } from './types';

/** Isolated Decimal constructor so global config elsewhere can never change payroll maths. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
export type Dec = Decimal;

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  half_even: Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Strict parser: rejects NaN, exponents, thousands separators and whitespace. */
export function parse(value: string, what = 'value'): Dec {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new Error(`${what} must be a plain decimal string, got ${JSON.stringify(value)}`);
  }
  return new D(value);
}

export function round(value: Dec, r: Rounding): Dec {
  return value.toDecimalPlaces(r.places, MODES[r.mode]);
}

/** Format to a fixed number of places for storage/transport (numeric(14,2) => 2). */
export function fmt(value: Dec, places = 2): string {
  return value.toFixed(places, Decimal.ROUND_HALF_UP);
}

export const ZERO = new D(0);
export const sum = (xs: Dec[]): Dec => xs.reduce((a, b) => a.plus(b), ZERO);
