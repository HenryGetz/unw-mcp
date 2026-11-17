import { describe, expect, it } from "vitest";
import { classifySignInPage, type SignInSnapshot } from "../src/auth/signin.js";

function snap(overrides: Partial<SignInSnapshot> = {}): SignInSnapshot {
  return {
    url: "https://login.microsoftonline.com/tenant/saml2",
    body: "",
    buttonValue: "",
    consentButton: false,
    otpInput: false,
    mfaSwitcher: false,
    emailVisible: false,
    emailValue: "",
    passwordVisible: false,
    ...overrides,
  };
}

describe("classifySignInPage", () => {
  it("recognizes the identifier step by the Next button", () => {
    expect(
      classifySignInPage(snap({ emailVisible: true, buttonValue: "Next", body: "Sign in" })).step,
    ).toBe("identifier");
  });

  it("recognizes the password step before the identifier step", () => {
    expect(
      classifySignInPage(
        snap({
          emailVisible: true,
          emailValue: "",
          passwordVisible: true,
          buttonValue: "Sign in",
          body: "Enter password",
        }),
      ).step,
    ).toBe("password");
  });

  it("recognizes the TOTP step", () => {
    expect(classifySignInPage(snap({ otpInput: true, body: "Enter code" })).step).toBe("totp");
  });

  it("recognizes the MFA method switcher", () => {
    expect(classifySignInPage(snap({ mfaSwitcher: true })).step).toBe("mfa-switch");
  });

  it("recognizes consent", () => {
    expect(classifySignInPage(snap({ consentButton: true })).step).toBe("consent");
  });

  it("recognizes the account picker", () => {
    expect(classifySignInPage(snap({ body: "Pick an account" })).step).toBe("account-picker");
  });

  it("recognizes stay-signed-in", () => {
    expect(classifySignInPage(snap({ body: "Stay signed in?", buttonValue: "Yes" })).step).toBe("kmsi");
  });

  it("extracts AADSTS errors", () => {
    const result = classifySignInPage(
      snap({ body: "AADSTS50076: due to a configuration change, you must use MFA" }),
    );
    expect(result.step).toBe("aadsts");
    expect(result.aadsts).toBe("AADSTS50076");
  });

  it("flags the MFA setup wall", () => {
    expect(classifySignInPage(snap({ body: "More information required" })).step).toBe("mfa-setup");
  });

  it("falls back to unknown", () => {
    expect(classifySignInPage(snap({ body: "Something else entirely" })).step).toBe("unknown");
  });
});
