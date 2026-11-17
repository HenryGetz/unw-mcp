/**
 * Microsoft Entra sign-in page classifier.
 *
 * The Entra front end keeps several inputs in the DOM on every step, so field
 * presence alone is not evidence. Observed discriminators on this tenant:
 *
 *   identifier step -> submit button value "Next"
 *   password step   -> submit button value "Sign in", heading "Enter password"
 *   MFA code step   -> one-time-code input
 *   "Stay signed in" -> button value "Yes"
 *
 * Pure so every branch is unit-testable without a browser.
 */

export type SignInStep =
  | "aadsts"
  | "consent"
  | "totp"
  | "mfa-switch"
  | "account-picker"
  | "kmsi"
  | "password"
  | "identifier"
  | "mfa-setup"
  | "unknown";

export interface SignInSnapshot {
  url: string;
  /** `document.body.innerText`, whitespace collapsed. */
  body: string;
  /** Value of `#idSIButton9`, or "" when absent. */
  buttonValue: string;
  consentButton: boolean;
  otpInput: boolean;
  mfaSwitcher: boolean;
  emailVisible: boolean;
  emailValue: string;
  passwordVisible: boolean;
}

export interface SignInClassification {
  step: SignInStep;
  aadsts?: string;
}

const AADSTS = /AADSTS\d{5,7}/;

export function classifySignInPage(snapshot: SignInSnapshot): SignInClassification {
  const aadsts = AADSTS.exec(snapshot.body)?.[0];
  if (aadsts) return { step: "aadsts", aadsts };

  if (snapshot.consentButton) return { step: "consent" };
  if (snapshot.otpInput) return { step: "totp" };
  if (snapshot.mfaSwitcher) return { step: "mfa-switch" };
  if (/Pick an account/i.test(snapshot.body)) return { step: "account-picker" };
  if (/Stay signed in\?/i.test(snapshot.body) || /^Yes$/i.test(snapshot.buttonValue.trim())) {
    return { step: "kmsi" };
  }
  if (/More information required|Let.s keep your account secure/i.test(snapshot.body)) {
    return { step: "mfa-setup" };
  }

  // Password before identifier: on the password step the identifier input is
  // still present but empty, so an "is it rendered?" test would mistype.
  if (/Enter password/i.test(snapshot.body) || /^Sign in$/i.test(snapshot.buttonValue.trim())) {
    return { step: "password" };
  }
  if (/^Next$/i.test(snapshot.buttonValue.trim()) && snapshot.emailVisible) {
    return { step: "identifier" };
  }
  if (snapshot.emailVisible && snapshot.emailValue === "") return { step: "identifier" };
  if (snapshot.passwordVisible) return { step: "password" };
  return { step: "unknown" };
}
