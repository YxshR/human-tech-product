import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DOCUMENT_CONTENT_TYPES, DocumentView, createDocument } from '@humantech/contracts';
import { Database } from '../db';
import { RequestAuth } from '../auth/auth-context';
import { AuditService } from '../common/audit';
import { ApiError, notFound } from '../common/errors';
import { authorizeOnEmployee } from '@humantech/authz';
import { employeeFor } from '../common/employee-access';
import { FILE_STORAGE, FileStorage } from './storage';

export const FILE_CONFIG = Symbol('FILE_CONFIG');
export interface FileConfig { signingSecret: string; maxUploadBytes: number }
const ctxOf = (a: RequestAuth, reason?: string) => ({ tenantId: a.tenantId, userId: a.userId, reason });
const LINK_TTL_SECONDS = 60;

/** Content must start with the signature of the type the client declared. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

const COLS = `d.id, d.employee_id, d.document_type, d.title, f.original_filename, f.content_type, f.size_bytes::int AS size_bytes, f.status, d.verified_at, to_char(d.expires_on,'YYYY-MM-DD') AS expires_on, d.created_at`;
const view = (r: Record<string, unknown>): DocumentView => ({
  id: r.id as string, employeeId: r.employee_id as string, documentType: r.document_type as string, title: (r.title as string | null) ?? null, filename: (r.original_filename as string | null) ?? null,
  contentType: r.content_type as string, sizeBytes: r.size_bytes as number, status: r.status as string, verifiedAt: r.verified_at ? (r.verified_at as Date).toISOString() : null,
  expiresOn: (r.expires_on as string | null) ?? null, createdAt: (r.created_at as Date).toISOString(),
});

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(Database) private readonly db: Database, @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage, @Inject(FILE_CONFIG) private readonly cfg: FileConfig,
  ) {}

  private async event(c: PoolClient, a: RequestAuth, fileId: string, action: 'upload' | 'download_url_issued' | 'download' | 'delete' | 'denied'): Promise<void> {
    await c.query('INSERT INTO file_access_events (tenant_id, file_id, actor_user_id, action, request_id) VALUES ($1,$2,$3,$4,$5)', [a.tenantId, fileId, a.userId, action, a.requestId]);
  }

  async list(a: RequestAuth, employeeId: string): Promise<DocumentView[]> {
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'document.read', { allowOwn: 'profile.read_own' });
      return (await c.query(`SELECT ${COLS} FROM employee_documents d JOIN stored_files f ON f.tenant_id=d.tenant_id AND f.id=d.file_id
        WHERE d.tenant_id=$1 AND d.employee_id=$2 AND f.status IN ('pending_upload','clean') ORDER BY d.created_at DESC`, [a.tenantId, employeeId])).rows.map(view);
    });
  }

  /** Step 1: declare the file. The caller then PUTs the bytes to the returned path. */
  async create(a: RequestAuth, employeeId: string, body: unknown): Promise<{ document: DocumentView; upload: { method: 'PUT'; path: string; expiresInSeconds: number } }> {
    const b = createDocument.parse(body);
    if (b.sizeBytes > this.cfg.maxUploadBytes) throw new ApiError('payload_too_large', 413, `Files can be at most ${Math.floor(this.cfg.maxUploadBytes / 1024 / 1024)} MB`);
    return this.db.run(ctxOf(a), async (c) => {
      await employeeFor(c, a, employeeId, 'document.upload');
      const fileId = randomUUID();
      await c.query(
        `INSERT INTO stored_files (id, tenant_id, purpose, object_key, original_filename, content_type, size_bytes, checksum_sha256, uploaded_by) VALUES ($1,$2,'employee_document',$3,$4,$5,$6,$7,$8)`,
        [fileId, a.tenantId, `${a.tenantId}/employee_document/${fileId}`, b.filename, b.contentType, b.sizeBytes, b.sha256, a.userId]);
      const d = (await c.query<{ id: string }>('INSERT INTO employee_documents (tenant_id, employee_id, file_id, document_type, title, expires_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [a.tenantId, employeeId, fileId, b.documentType, b.title ?? null, b.expiresOn ?? null, a.userId])).rows[0]!;
      await this.audit.record(c, a, 'document.declare', 'employee_documents', d.id, null, { employeeId, documentType: b.documentType, sizeBytes: b.sizeBytes });
      return {
        document: view((await c.query(`SELECT ${COLS} FROM employee_documents d JOIN stored_files f ON f.tenant_id=d.tenant_id AND f.id=d.file_id WHERE d.tenant_id=$1 AND d.id=$2`, [a.tenantId, d.id])).rows[0]!),
        upload: { method: 'PUT', path: `/files/${fileId}/content`, expiresInSeconds: 900 },
      };
    });
  }

  /** Step 2: receive the bytes. Size, checksum and file signature must all match what was declared. */
  async receive(a: RequestAuth, fileId: string, data: unknown, contentType: string | undefined): Promise<DocumentView> {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new ApiError('unsupported_media_type', 415, 'Send the file bytes as the request body');
    return this.db.run(ctxOf(a), async (c) => {
      const f = (await c.query<{ id: string; object_key: string; content_type: string; size_bytes: string; checksum_sha256: string; status: string; uploaded_by: string | null; created_at: Date }>(
        `SELECT id, object_key, content_type, size_bytes::text, checksum_sha256, status, uploaded_by, created_at FROM stored_files WHERE tenant_id=$1 AND id=$2 AND purpose='employee_document' FOR UPDATE`, [a.tenantId, fileId])).rows[0];
      if (!f || f.uploaded_by !== a.userId) throw notFound('file');
      if (f.status !== 'pending_upload') throw new ApiError('invalid_state', 409, 'This file has already been uploaded');
      if (Date.now() - f.created_at.getTime() > 15 * 60_000) throw new ApiError('invalid_state', 409, 'The upload window has expired; declare the file again');
      if (contentType?.split(';')[0]?.trim() !== f.content_type) throw new ApiError('unsupported_media_type', 415, `Content-Type must be ${f.content_type}`);
      if (data.length !== Number(f.size_bytes)) throw new ApiError('validation_failed', 422, 'The file size does not match what was declared');
      if (createHash('sha256').update(data).digest('hex') !== f.checksum_sha256) throw new ApiError('validation_failed', 422, 'The file checksum does not match what was declared');
      if (!MAGIC[f.content_type]?.(data)) throw new ApiError('unsupported_media_type', 415, 'The file content is not a valid ' + f.content_type);
      await this.storage.put(f.object_key, data, f.content_type);
      // No malware scanner is wired in this release: files are marked clean on arrival. A scanner would set 'quarantined' here instead.
      await c.query(`UPDATE stored_files SET status='clean', scanned_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, fileId]);
      await this.event(c, a, fileId, 'upload');
      return view((await c.query(`SELECT ${COLS} FROM employee_documents d JOIN stored_files f ON f.tenant_id=d.tenant_id AND f.id=d.file_id WHERE d.tenant_id=$1 AND d.file_id=$2`, [a.tenantId, fileId])).rows[0]!);
    });
  }

  private sign(a: RequestAuth, fileId: string, exp: number): string {
    return createHmac('sha256', this.cfg.signingSecret).update(`${a.tenantId}.${a.userId}.${fileId}.${exp}`).digest('base64url');
  }
  async downloadLink(a: RequestAuth, documentId: string): Promise<{ url: string; expiresAt: string }> {
    return this.db.run(ctxOf(a), async (c) => {
      const d = (await c.query<{ employee_id: string; file_id: string; status: string }>(
        `SELECT d.employee_id, d.file_id, f.status FROM employee_documents d JOIN stored_files f ON f.tenant_id=d.tenant_id AND f.id=d.file_id WHERE d.tenant_id=$1 AND d.id=$2`, [a.tenantId, documentId])).rows[0];
      if (!d) throw notFound('document');
      await employeeFor(c, a, d.employee_id, 'document.read', { allowOwn: 'profile.read_own' });
      if (d.status !== 'clean') throw new ApiError('invalid_state', 409, 'This document is not available');
      return this.issueLink(c, a, d.file_id);
    });
  }
  /** Short-lived link bound to tenant + user + file. The caller has already authorised access to the file. */
  async issueLink(c: PoolClient, a: RequestAuth, fileId: string): Promise<{ url: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    await this.event(c, a, fileId, 'download_url_issued');
    return { url: `/files/${fileId}/download?exp=${exp}&sig=${this.sign(a, fileId, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }
  /** Server-generated artefacts (exports, import results): stored privately, checksummed, optionally expiring. */
  async storeGenerated(c: PoolClient, a: RequestAuth, purpose: 'export_result' | 'import_source' | 'import_result', filename: string, contentType: string, data: Buffer, expiresAt?: Date): Promise<string> {
    const fileId = randomUUID();
    const key = `${a.tenantId}/${purpose}/${fileId}`;
    await this.storage.put(key, data, contentType);
    await c.query(
      `INSERT INTO stored_files (id, tenant_id, purpose, object_key, original_filename, content_type, size_bytes, checksum_sha256, status, scanned_at, expires_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'clean',now(),$9,$10)`,
      [fileId, a.tenantId, purpose, key, filename, contentType, data.length, createHash('sha256').update(data).digest('hex'), expiresAt ?? null, a.userId]);
    return fileId;
  }
  async download(a: RequestAuth, fileId: string, exp: string | undefined, sig: string | undefined): Promise<{ data: Buffer; contentType: string; filename: string }> {
    const e = Number(exp);
    const expected = Buffer.from(this.sign(a, fileId, e));
    const given = Buffer.from(sig ?? '');
    if (!Number.isFinite(e) || e < Date.now() / 1000 || given.length !== expected.length || !timingSafeEqual(given, expected)) throw notFound('file');
    return this.db.run(ctxOf(a), async (c) => {
      const f = (await c.query<{ object_key: string; content_type: string; original_filename: string | null; purpose: string }>(
        `SELECT object_key, content_type, original_filename, purpose FROM stored_files WHERE tenant_id=$1 AND id=$2 AND status='clean' AND (expires_at IS NULL OR expires_at > now())`, [a.tenantId, fileId])).rows[0];
      if (!f) throw notFound('file');
      await this.assertCanRead(c, a, fileId, f.purpose);
      await this.event(c, a, fileId, 'download');
      return { data: await this.storage.get(f.object_key), contentType: f.content_type, filename: (f.original_filename ?? 'file').replace(/[^\w.\- ]/g, '_') };
    });
  }

  /** Each kind of file is governed by the rules of the thing it belongs to. Anything else is simply not found. */
  private async assertCanRead(c: PoolClient, a: RequestAuth, fileId: string, purpose: string): Promise<void> {
    if (purpose === 'employee_document') {
      const d = (await c.query<{ employee_id: string }>('SELECT employee_id FROM employee_documents WHERE tenant_id=$1 AND file_id=$2', [a.tenantId, fileId])).rows[0];
      if (!d) throw notFound('file');
      await employeeFor(c, a, d.employee_id, 'document.read', { allowOwn: 'profile.read_own' });
    } else if (purpose === 'payslip') {
      const p = (await c.query<{ employee_id: string; branch_id: string | null }>(
        `SELECT s.employee_id, e.branch_id FROM payslips s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id WHERE s.tenant_id=$1 AND s.file_id=$2 AND s.status IN ('ready','superseded')`, [a.tenantId, fileId])).rows[0];
      if (!p || !authorizeOnEmployee(a, 'payslip.read_any', { tenantId: a.tenantId, branchId: p.branch_id, employeeId: p.employee_id }, { allowOwn: 'payslip.read_own' }).allowed) throw notFound('file');
    } else if (purpose === 'export_result' || purpose === 'import_result') {
      const own = (await c.query(
        purpose === 'export_result' ? 'SELECT 1 FROM export_jobs WHERE tenant_id=$1 AND result_file_id=$2 AND requested_by=$3' : 'SELECT 1 FROM import_jobs WHERE tenant_id=$1 AND result_file_id=$2 AND created_by=$3',
        [a.tenantId, fileId, a.userId])).rows[0];
      if (!own) throw notFound('file');
    } else throw notFound('file');
  }

  async verify(a: RequestAuth, documentId: string): Promise<DocumentView> {
    return this.db.run(ctxOf(a), async (c) => {
      const d = (await c.query<{ employee_id: string }>('SELECT employee_id FROM employee_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, documentId])).rows[0];
      if (!d) throw notFound('document');
      await employeeFor(c, a, d.employee_id, 'employee.update');
      await c.query('UPDATE employee_documents SET verified_at=now(), verified_by=$3 WHERE tenant_id=$1 AND id=$2', [a.tenantId, documentId, a.userId]);
      await this.audit.record(c, a, 'document.verify', 'employee_documents', documentId, null, null);
      return view((await c.query(`SELECT ${COLS} FROM employee_documents d JOIN stored_files f ON f.tenant_id=d.tenant_id AND f.id=d.file_id WHERE d.tenant_id=$1 AND d.id=$2`, [a.tenantId, documentId])).rows[0]!);
    });
  }

  async remove(a: RequestAuth, documentId: string): Promise<void> {
    await this.db.run(ctxOf(a), async (c) => {
      const d = (await c.query<{ employee_id: string; file_id: string; object_key: string }>(
        `SELECT d.employee_id, d.file_id, f.object_key FROM employee_documents d JOIN stored_files f ON f.tenant_id=d.tenant_id AND f.id=d.file_id WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d`, [a.tenantId, documentId])).rows[0];
      if (!d) throw notFound('document');
      await employeeFor(c, a, d.employee_id, 'document.delete');
      await c.query('DELETE FROM employee_documents WHERE tenant_id=$1 AND id=$2', [a.tenantId, documentId]);
      await c.query(`UPDATE stored_files SET status='deleted' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, d.file_id]);
      await this.event(c, a, d.file_id, 'delete');
      await this.audit.record(c, a, 'document.delete', 'employee_documents', documentId, { employeeId: d.employee_id }, null);
      await this.storage.delete(d.object_key).catch(() => undefined);   // best effort; the row is already marked deleted
    });
  }
}

export const ALLOWED_CONTENT_TYPES: readonly string[] = DOCUMENT_CONTENT_TYPES;
