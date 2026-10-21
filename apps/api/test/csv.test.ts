import { describe, expect, it } from 'vitest';
import { CsvError, csvCell, parseCsv, toCsv } from '../src/common/csv';

describe('csvCell', () => {
  it('quotes when needed and defuses formulas but keeps numbers', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+91 98765')).toBe("'+91 98765");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-5.25')).toBe('-5.25');
    expect(csvCell('-abc')).toBe("'-abc");
  });
  it('toCsv writes CRLF rows and blanks for null', () => {
    expect(toCsv(['a', 'b'], [[1, null], ['x,y', undefined]])).toBe('a,b\r\n1,\r\n"x,y",\r\n');
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines and both line endings', () => {
    expect(parseCsv('a,b,c\r\n1,"two, 2","say ""hi"""\n"multi\nline",,x\n')).toEqual([['a', 'b', 'c'], ['1', 'two, 2', 'say "hi"'], ['multi\nline', '', 'x']]);
  });
  it('strips a BOM, skips blank lines, and accepts a missing final newline', () => {
    expect(parseCsv('﻿a,b\n\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a\r\rb')).toEqual([['a'], ['b']]);
  });
  it('round-trips what toCsv writes (including nasty values)', () => {
    const rows = [['x', 'y'], ['a "q", b', 'c\r\nd'], ['', ' sp ']];
    expect(parseCsv(toCsv(rows[0]!, rows.slice(1)))).toEqual(rows);
  });
  it('treats a quote in the middle of a field literally', () => { expect(parseCsv('ab"c,d')).toEqual([['ab"c', 'd']]); });
  it('rejects unterminated quotes and oversized input', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(CsvError);
    expect(() => parseCsv('1\n2\n3\n4', { maxRows: 2 })).toThrow(/more than 2 rows/);
    expect(() => parseCsv('a,b,c', { maxColumns: 2 })).toThrow(/columns/);
  });
});
