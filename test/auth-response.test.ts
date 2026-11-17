import { describe, expect, it } from "vitest";
import { classifyResponse, type ResponseShape } from "../src/auth/response.js";

function response(overrides: Partial<ResponseShape> = {}): ResponseShape {
  return {
    status: 200,
    contentType: "application/json",
    finalUrl: "https://my.unw.edu/api/v1/users/me/",
    body: '{"ok":true}',
    expectJson: true,
    ...overrides,
  };
}

describe("classifyResponse", () => {
  it("accepts JSON", () => {
    expect(classifyResponse(response()).verdict).toBe("ok");
  });

  it("treats 401 and 403 as auth failures", () => {
    expect(classifyResponse(response({ status: 401, body: "" })).verdict).toBe("auth");
    expect(classifyResponse(response({ status: 403, body: "" })).verdict).toBe("auth");
  });

  it("treats a redirect chain to sign-in as an auth failure", () => {
    expect(
      classifyResponse(
        response({
          finalUrl: "https://login.microsoftonline.com/tenant/saml2?SAMLRequest=x",
          contentType: "text/html",
          body: "<html>login</html>",
        }),
      ).verdict,
    ).toBe("auth");
  });

  it("treats HTML where JSON was expected as an auth failure", () => {
    expect(
      classifyResponse(response({ contentType: "text/html", body: "<!doctype html><html></html>" })).verdict,
    ).toBe("auth");
  });

  it("treats an unexpected 302 as an auth failure", () => {
    expect(classifyResponse(response({ status: 302, body: "", expectJson: false })).verdict).toBe("auth");
  });

  it("does not call a 5xx an auth failure", () => {
    expect(classifyResponse(response({ status: 503, body: "" })).verdict).toBe("unavailable");
  });

  it("accepts HTML when text was requested", () => {
    expect(
      classifyResponse(
        response({ expectJson: false, contentType: "text/html", body: "<html>page</html>" }),
      ).verdict,
    ).toBe("ok");
  });

  it("accepts an empty JSON response body", () => {
    expect(classifyResponse(response({ body: "", contentType: "" })).verdict).toBe("ok");
  });
});
