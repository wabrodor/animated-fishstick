import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from './config.js';
import type { Role } from './models.js';
import { Organization, User } from './models.js';

const JWT_ISSUER = 'apexcare-api';
const JWT_AUDIENCE = 'apexcare-client';

export type OrganizationType = 'CLINIC' | 'APEXCARE';
export type AuthContext = { userId: string; organizationId: string; organizationType: OrganizationType; roles: Role[] };
export type AccessTokenContext = Omit<AuthContext, 'organizationType'>;
export type AuthenticatedRequest = Request & { auth?: AuthContext };

export function issueAccessToken(context: AccessTokenContext): string {
  return jwt.sign(
    { userId: context.userId, organizationId: context.organizationId, roles: context.roles },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' },
  );
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authorization = req.header('authorization');
    const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    if (!token) { res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' } }); return; }

    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (typeof payload === 'string' || typeof payload.userId !== 'string' || typeof payload.organizationId !== 'string') {
      res.status(401).json({ error: { code: 'AUTH_INVALID', message: 'Invalid access token.' } }); return;
    }

    const user = await User.findOne({ _id: payload.userId, organizationId: payload.organizationId, status: 'ACTIVE' }).lean();
    if (!user) { res.status(401).json({ error: { code: 'AUTH_INVALID', message: 'Invalid access token.' } }); return; }

    const organization = await Organization.findOne({ _id: user.organizationId, status: 'ACTIVE' }).select('_id type').lean();

    if (!organization) {
  res.status(403).json({
    error: {
      code: 'ORGANIZATION_INACTIVE',
      message: 'This organization is not active.'
    }
  });
  return;
}

// Users with a temporary password may only access the
// password-change flow until they set their permanent password.
if (
  user.mustChangePassword === true &&
  req.path !== '/me' &&
  req.path !== '/me/password'
) {
  res.status(403).json({
    error: {
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'You must change your temporary password before accessing clinical routes.'
    }
  });
  return;
}


    (req as AuthenticatedRequest).auth = {
      userId: String(user._id),
      organizationId: String(user.organizationId),
      organizationType: organization.type as OrganizationType,
      roles: user.roles as Role[],
    };
    next();
  } catch {
    res.status(401).json({ error: { code: 'AUTH_INVALID', message: 'Invalid or expired access token.' } });
  }
}

export function requireOrganizationType(...accepted: OrganizationType[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth || !accepted.includes(auth.organizationType)) {
      res.status(403).json({ error: { code: 'ORGANIZATION_TYPE_FORBIDDEN', message: 'This organization is not permitted to access this resource.' } });
      return;
    }
    next();
  };
}

const clinicRoles = new Set<Role>(['CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR']);
const apexCareRoles = new Set<Role>(['APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST']);

export function requireRoles(...accepted: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth || !auth.roles.some((role) => accepted.includes(role))) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission for this action.' } }); return;
    }

    const requiresClinicOrganization = accepted.length > 0 && accepted.every((role) => clinicRoles.has(role));
    const requiresApexCareOrganization = accepted.length > 0 && accepted.every((role) => apexCareRoles.has(role));
    if (requiresClinicOrganization && auth.organizationType !== 'CLINIC') {
      res.status(403).json({ error: { code: 'ORGANIZATION_TYPE_FORBIDDEN', message: 'A clinic organization is required for this action.' } }); return;
    }
    if (requiresApexCareOrganization && auth.organizationType !== 'APEXCARE') {
      res.status(403).json({ error: { code: 'ORGANIZATION_TYPE_FORBIDDEN', message: 'An ApexCare organization is required for this action.' } }); return;
    }

    next();
  };
}
