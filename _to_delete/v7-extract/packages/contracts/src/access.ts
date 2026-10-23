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
export type InvitationView = { id: string; email: string; status: string; expiresAt: string; roleKeys: string[]; branchScope: 'all' | string[] };
