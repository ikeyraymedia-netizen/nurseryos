import {
  getMultiFactorResolver,
  multiFactor,
  MultiFactorError,
  MultiFactorResolver,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  sendEmailVerification,
  TotpMultiFactorGenerator,
  TotpSecret,
  User
} from 'firebase/auth';
import QRCode from 'qrcode';
import { auth } from '../firebase';
import { TenantMember } from '../types';

const ISSUER = 'NurseryOS';

/** Every nursery member must use two-step login. */
export function memberRequiresMfa(member: Pick<TenantMember, 'role' | 'roles'> | null): boolean {
  return !!member;
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

export function hasPhoneFactor(resolver: MultiFactorResolver): boolean {
  return resolver.hints.some((hint) => hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID);
}

export async function sendPhoneEnrollmentCode(
  user: User,
  phoneNumber: string,
  container: HTMLElement
): Promise<string> {
  const session = await multiFactor(user).getSession();
  const verifier = new RecaptchaVerifier(auth, container, { size: 'invisible' });
  try {
    return await new PhoneAuthProvider(auth).verifyPhoneNumber({ phoneNumber, session }, verifier);
  } finally {
    verifier.clear();
  }
}

export async function confirmPhoneEnrollment(
  user: User,
  verificationId: string,
  code: string
): Promise<void> {
  const cred = PhoneAuthProvider.credential(verificationId, code.replace(/\s+/g, ''));
  await multiFactor(user).enroll(PhoneMultiFactorGenerator.assertion(cred), 'Text message');
}

export async function sendPhoneSignInCode(
  resolver: MultiFactorResolver,
  container: HTMLElement
): Promise<string> {
  const hint = resolver.hints.find((item) => item.factorId === PhoneMultiFactorGenerator.FACTOR_ID);
  if (!hint) throw new Error('No text-message sign-in is set up for this account.');
  const verifier = new RecaptchaVerifier(auth, container, { size: 'invisible' });
  try {
    return await new PhoneAuthProvider(auth).verifyPhoneNumber(
      { multiFactorHint: hint, session: resolver.session },
      verifier
    );
  } finally {
    verifier.clear();
  }
}

export async function resolveSignInWithPhone(
  resolver: MultiFactorResolver,
  verificationId: string,
  code: string
): Promise<User> {
  const cred = PhoneAuthProvider.credential(verificationId, code.replace(/\s+/g, ''));
  const result = await resolver.resolveSignIn(PhoneMultiFactorGenerator.assertion(cred));
  return result.user;
}

export async function resolveSignInWithTotp(resolver: MultiFactorResolver, code: string): Promise<User> {
  const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  if (!hint) throw new Error('No authenticator app is set up for this account.');
  const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.replace(/\s+/g, ''));
  const cred = await resolver.resolveSignIn(assertion);
  return cred.user;
}
