import { ActorType, MemberRole } from '../../generated/prisma/client';
import type { Actor } from '../../modules/audit/audit.service';

export type AuthContext =
  | {
      kind: 'user';
      userId: string;
      organizationId: string;
      role: MemberRole;
      sessionId: string;
      isPlatformAdmin: boolean;
    }
  | {
      kind: 'api_key';
      apiKeyId: string;
      organizationId: string;
      role: MemberRole;
    };

export function actorOf(auth: AuthContext): Actor {
  return auth.kind === 'user' ? { type: ActorType.USER, id: auth.userId } : { type: ActorType.API_KEY, id: auth.apiKeyId };
}

export function creatorFields(auth: AuthContext): { createdById: string | null; createdByApiKeyId: string | null } {
  return auth.kind === 'user'
    ? { createdById: auth.userId, createdByApiKeyId: null }
    : { createdById: null, createdByApiKeyId: auth.apiKeyId };
}

// ───────────── RBAC extensível ─────────────
export const Permission = {
  DOCUMENT_READ: 'document:read',
  DOCUMENT_WRITE: 'document:write',
  ENVELOPE_READ: 'envelope:read',
  ENVELOPE_WRITE: 'envelope:write',
  ENVELOPE_CANCEL: 'envelope:cancel',
  TEMPLATE_READ: 'template:read',
  TEMPLATE_WRITE: 'template:write',
  MEMBERS_READ: 'members:read',
  MEMBERS_MANAGE: 'members:manage',
  API_KEYS_MANAGE: 'api_keys:manage',
  WEBHOOKS_MANAGE: 'webhooks:manage',
  BILLING_READ: 'billing:read',
  BILLING_MANAGE: 'billing:manage',
  ORG_SETTINGS: 'org:settings',
  REPORTS_READ: 'reports:read',
} as const;
export type PermissionValue = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

export const ROLE_PERMISSIONS: Record<MemberRole, readonly PermissionValue[]> = {
  OWNER: ALL,
  ADMIN: [
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_WRITE,
    Permission.ENVELOPE_READ,
    Permission.ENVELOPE_WRITE,
    Permission.ENVELOPE_CANCEL,
    Permission.TEMPLATE_READ,
    Permission.TEMPLATE_WRITE,
    Permission.MEMBERS_READ,
    Permission.MEMBERS_MANAGE,
    Permission.BILLING_READ,
    Permission.REPORTS_READ,
  ],
  MEMBER: [
    Permission.DOCUMENT_READ,
    Permission.DOCUMENT_WRITE,
    Permission.ENVELOPE_READ,
    Permission.ENVELOPE_WRITE,
    Permission.ENVELOPE_CANCEL,
    Permission.TEMPLATE_READ,
    Permission.BILLING_READ,
  ],
  VIEWER: [Permission.DOCUMENT_READ, Permission.ENVELOPE_READ, Permission.TEMPLATE_READ, Permission.BILLING_READ],
};

export function hasPermission(role: MemberRole, permission: PermissionValue): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ROLE_RANK: Record<MemberRole, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };
