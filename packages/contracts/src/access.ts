import { z } from 'zod';
import { uuid } from './common';

const roleKey = z.string().trim().min(2).max(40).regex(/^[a-z][a-z_]*$/, 'lowercase letters and underscores');
const email = z.string().trim().toLowerCase().email().max(254);
const permissionKey = z.string().regex(/^[a-z_]+\.[a-z_]+$/);

export const inviteUser = z.object({
  email,
  roleKeys: z.array(roleKey).min(1).max(10),
  branchScope: z.union([z.literal('all'), z.array(uuid).min(1).max(200)]),
}).strict();
/** A login code for an employee. Without `roleKeys` the person gets the Employee role only. */
export const issueLoginCode = z.object({ employeeId: uuid, email, roleKeys: z.array(roleKey).min(1).max(10).optional() }).strict();
/** A code that lets an employee who forgot their password choose a new one. */
export const issuePasswordReset = z.object({ employeeId: uuid }).strict();
export const LOGIN_CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;
/** What people type is forgiving: spaces, dashes and lower case are fine. */
export const normalizeLoginCode = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();
const loginCode = z.string().max(40).transform(normalizeLoginCode).pipe(z.string().regex(LOGIN_CODE_RE, 'that is not a login code'));
export const PASSWORD_RULE = 'At least 8 characters, with a letter and a number';
const newPassword = z.string().min(8, PASSWORD_RULE).max(128).regex(/[A-Za-z]/, PASSWORD_RULE).regex(/[0-9]/, PASSWORD_RULE);
export const activateLogin = z.object({ email, code: loginCode, password: newPassword }).strict();
export const passwordLogin = z.object({ email, password: z.string().min(1).max(128) }).strict();
export type LoginCodeIssued = { invitationId: string; employeeId: string; email: string; code: string; expiresAt: string; roleKeys: string[] };
export const acceptInvitation = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid invitation token') }).strict();
export const setUserRoles = z.object({ roleKeys: z.array(roleKey).max(10) }).strict();
export const setBranchScope = z.object({ scope: z.union([z.literal('all'), z.array(uuid).min(1).max(200)]) }).strict();
export const createRole = z.object({ key: roleKey, name: z.string().trim().min(2).max(80), permissions: z.array(permissionKey).min(1).max(200) }).strict();
export const updateRole = z.object({ name: z.string().trim().min(2).max(80).optional(), permissions: z.array(permissionKey).min(1).max(200).optional() }).strict();

export type AccessUserView = {
  userId: string; email: string; displayName: string; status: string; roleKeys: string[];
  branchScope: 'all' | string[]; employeeId: string | null; joinedAt: string | null;
};
export type RoleView = { id: string; key: string; name: string; isSystem: boolean; permissions: string[]; memberCount: number };
export type InvitationView = { id: string; email: string; status: string; expiresAt: string; roleKeys: string[]; branchScope: 'all' | string[]; kind: 'link' | 'code' | 'reset'; employeeId: string | null };
