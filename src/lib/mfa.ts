import {
  getMultiFactorResolver,
  multiFactor,
  MultiFactorError,
  MultiFactorResolver,
  sendEmailVerification,
  TotpMultiFactorGenerator,
  TotpSecret,
  User
} from 'firebase/auth';
import QRCode from 'qrcode';
import { auth } from '../firebase';
import { TenantMember } from '../types';
import { memberHasRole } from './permissions';

const ISSUER = 'NurseryOS';

/** While non-empty, only these emails are required to set up two-step login (pilot). */
const MFA_PILOT_EMAILS = ['ikey@bayoustateplantco.com'];

/** Owners and admins must use two-step login. */
export function memberRequiresMfa(
  member: Pick<TenantMember, 'role' | 'roles' | 'email'> | null
): boolean {
  if (!member) return false;
  if (!memberHasRole(member, 'owner') && !memberHasRole(member, 'admin')) return false;
  if (MFA_PILOT_EMAILS.length === 0) return true;
  return MFA_PILOT_EMAILS.includes((member.email || '').trim().toLowerCase());
}

export function hasTotpEnrolled(user: User): boolean {
  return multiFactor(user).enrolledFactors.some(
    (f) => f.factorId === TotpMultiFactorGenerator.FACTOR_ID
  );
}

export interface TotpEnrollment {
  secret: TotpSecret;
  secretKey: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export async function startTotpEnrollment(user: User): Promise<TotpEnrollment> {
  const session = await multiFactor(user).getSession();
  const secret = await TotpMultiFactorGenerator.generateSecret(session);
  const otpauthUrl = secret.generateQrCodeUrl(user.email || 'account', ISSUER);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return { secret, secretKey: secret.secretKey, otpauthUrl, qrDataUrl };
}

export async function finishTotpEnrollment(
  user: User,
  enrollment: TotpEnrollment,
  code: string
): Promise<void> {
  const assertion = TotpMultiFactorGenerator.assertionForEnrollment(
    enrollment.secret,
    code.replace(/\s+/g, '')
  );
  await multiFactor(user).enroll(assertion, 'Authenticator app');
}

export async function sendVerificationEmail(user: User): Promise<void> {
  await sendEmailVerification(user);
}

export function isMfaRequiredError(err: unknown): err is MultiFactorError {
  return (err as { code?: string })?.code === 'auth/multi-factor-auth-required';
}

export function mfaResolverFor(err: MultiFactorError): MultiFactorResolver {
  return getMultiFactorResolver(auth, err);
}

export async function resolveSignInWithTotp(resolver: MultiFactorResolver, code: string): Promise<User> {
  const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  if (!hint) throw new Error('No authenticator app is set up for this account.');
  const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.replace(/\s+/g, ''));
  const cred = await resolver.resolveSignIn(assertion);
  return cred.user;
}
