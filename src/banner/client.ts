/**
 * Banner 9 Self-Service client.
 *
 * registration-ss and student-ss are separate SAML apps: each needs its own
 * `JSESSIONID` and a per-app handshake. Their sessions live in the browser
 * cookie jar, so every read goes through `page.evaluate(fetch)` rather than
 * `browserContext.request`. Reads are GET-only.
 */
import type { Page } from "playwright";
import type { ResolvedConfig } from "../config.js";
import {
  AppSessionExpiredError,
  PortalUnavailableError,
  PortalSession,
} from "../auth/session.js";
import { classifyResponse } from "../auth/response.js";

export const REGISTRATION_ENTRY = "/StudentRegistrationSsb/ssb/registration/registerPostSignIn?mode=registration";
export const STUDENT_ENTRY = "/StudentSelfService/ssb/studentProfile";

/** Minimal Banner surface consumed by the academic/finance loaders. */
export interface BannerApi {
  getTerms(): Promise<unknown>;
  registrationHistory(term: string): Promise<unknown>;
  viewGpaHours(studentId: string): Promise<unknown>;
  showHolds(studentId: string): Promise<unknown>;
  registrationNotices(studentId: string): Promise<unknown>;
  aidYears(): Promise<unknown>;
  awardInfo(aidyCode: string): Promise<unknown>;
  costOfAttendance(aidyCode: string): Promise<unknown>;
}

/** Opens one app session and runs a task inside it. */
export interface BannerReader {
  registration<T>(task: (api: BannerApi) => Promise<T>): Promise<T>;
  student<T>(task: (api: BannerApi) => Promise<T>): Promise<T>;
}

class BannerApiClient implements BannerApi {
  constructor(
    private readonly page: Page,
    private readonly origin: string,
  ) {}

  private async json<T>(path: string): Promise<T> {
    const url = new URL(path, this.origin).toString();
    if (new URL(url).origin !== this.origin) {
      throw new Error(`refusing cross-origin Banner request to ${new URL(url).origin}`);
    }
    let result: { status: number; contentType: string; finalUrl: string; body: string };
    try {
      result = await this.page.evaluate(async (target) => {
        const response = await fetch(target, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json, */*" },
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          finalUrl: response.url,
          body: await response.text(),
        };
      }, url);
    } catch (error) {
      const message = (error as Error).message;
      // A redirect to the SAML host fails CORS/opaque before a status exists.
      if (/failed to fetch|networkerror|load failed/i.test(message)) {
        throw new AppSessionExpiredError("page fetch was blocked by a redirect");
      }
      throw new PortalUnavailableError(
        "Banner page fetch failed",
        "retry shortly; the browser page may have navigated",
      );
    }

    if (!result.finalUrl.startsWith(this.origin)) {
      throw new AppSessionExpiredError("fetch followed a redirect off the app origin");
    }
    const classification = classifyResponse({
      status: result.status,
      contentType: result.contentType,
      finalUrl: result.finalUrl,
      body: result.body,
      expectJson: true,
    });
    if (classification.verdict === "auth") {
      throw new AppSessionExpiredError(classification.reason);
    }
    if (classification.verdict === "unavailable") {
      throw new PortalUnavailableError(
        `Banner request failed (${classification.reason})`,
        "retry shortly; Banner may be unavailable",
      );
    }
    try {
      return JSON.parse(result.body) as T;
    } catch {
      throw new PortalUnavailableError(
        "Banner returned malformed JSON",
        "upstream shape may have changed; degrade gracefully and report it",
      );
    }
  }

  getTerms(): Promise<unknown> {
    return this.json("/StudentRegistrationSsb/ssb/classSearch/getTerms?searchTerm=&offset=1&max=20");
  }

  registrationHistory(term: string): Promise<unknown> {
    return this.json(
      `/StudentRegistrationSsb/ssb/registrationHistory/reset?term=${encodeURIComponent(term)}`,
    );
  }

  viewGpaHours(studentId: string): Promise<unknown> {
    return this.json(
      `/StudentSelfService/studentProfile/viewGPAHoursList?studentId=${encodeURIComponent(studentId)}`,
    );
  }

  showHolds(studentId: string): Promise<unknown> {
    return this.json(
      `/StudentSelfService/studentHolds/showHolds?studentId=${encodeURIComponent(studentId)}`,
    );
  }

  registrationNotices(studentId: string): Promise<unknown> {
    return this.json(
      `/StudentSelfService/studentProfile/viewRegistrationNotices?studentId=${encodeURIComponent(studentId)}`,
    );
  }

  aidYears(): Promise<unknown> {
    return this.json("/StudentSelfService/ssb/applicantActiveAidYears/getApplicantActiveAidYears");
  }

  awardInfo(aidyCode: string): Promise<unknown> {
    return this.json(
      `/StudentSelfService/ssb/awardLetter/getAwardInfo?aidyCode=${encodeURIComponent(aidyCode)}`,
    );
  }

  costOfAttendance(aidyCode: string): Promise<unknown> {
    return this.json(
      `/StudentSelfService/ssb/awardLetter/getCostOfAttendance?aidyCode=${encodeURIComponent(aidyCode)}`,
    );
  }
}

export class BannerClient implements BannerReader {
  constructor(
    private readonly session: PortalSession,
    private readonly cfg: ResolvedConfig,
  ) {}

  registration<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return this.session.withAppSession(this.cfg.registrationOrigin, REGISTRATION_ENTRY, (page) =>
      task(new BannerApiClient(page, this.cfg.registrationOrigin)),
    );
  }

  student<T>(task: (api: BannerApi) => Promise<T>): Promise<T> {
    return this.session.withAppSession(this.cfg.studentOrigin, STUDENT_ENTRY, (page) =>
      task(new BannerApiClient(page, this.cfg.studentOrigin)),
    );
  }
}
