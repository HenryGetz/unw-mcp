import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";
import { config } from "../src/config.js";
import { PortalUnavailableError } from "../src/auth/session.js";
import type { PortalReader } from "../src/portal/client.js";
import {
  loadPage,
  loadPageSearch,
  projectPageDocument,
  projectPageSearchRow,
  type PageDeps,
} from "../src/portal/pages.js";

class FakePortal implements PortalReader {
  readonly calls: string[] = [];
  constructor(private readonly handler: (url: string) => unknown) {}
  getPortalJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    return Promise.resolve(this.handler(url) as T);
  }
  getFlowJson<T>(): Promise<T> {
    return Promise.resolve({} as T);
  }
}

function deps(portal: PortalReader, cache = new TtlCache()): PageDeps {
  return { portal, cfg: config(), cache };
}

describe("page projections", () => {
  it("strips HTML, projects category and excerpt", () => {
    const row = projectPageSearchRow(
      {
        slug: "registration-holds-trad",
        title: "Registration Holds",
        category: { name: "Registration" },
        body_html: "<p>Clear your <b>holds</b> before registering.</p>",
        body: "",
      },
      300,
    );
    expect(row).toEqual({
      slug: "registration-holds-trad",
      title: "Registration Holds",
      category: "Registration",
      excerpt: "Clear your holds before registering.",
    });
  });

  it("prefers body text and caps the document", () => {
    const document = projectPageDocument(
      {
        slug: "meal-plan-information",
        title: "Meal Plan Information",
        category: "Dining",
        body: "x".repeat(120),
        body_html: "<p>ignored</p>",
      },
      100,
    );
    expect(document?.body_chars).toBe(120);
    expect(document?.body_truncated).toBe(true);
    expect(document?.body.length).toBeLessThanOrEqual(100);
    expect(document?.body.endsWith("…")).toBe(true);
    expect(JSON.stringify(document)).not.toContain("body_html");
  });

  it("does not flag a short body as truncated", () => {
    const document = projectPageDocument({ slug: "short", body: "hello" }, 100);
    expect(document?.body).toBe("hello");
    expect(document?.body_truncated).toBe(false);
  });

  it("rejects a payload without a slug", () => {
    expect(projectPageDocument({ title: "No slug" }, 100)).toBeUndefined();
  });
});

describe("page loaders", () => {
  it("searches, de-duplicates and caches for 10 minutes", async () => {
    const portal = new FakePortal(() => ({
      count: 2,
      results: [
        { slug: "a", title: "Alpha", body: "first" },
        { slug: "a", title: "Alpha again", body: "duplicate" },
        { slug: "b", title: "Beta", body_html: "<p>second</p>" },
      ],
    }));
    const d = deps(portal);
    const result = await loadPageSearch(d, "registration", 10);
    expect(result.query).toBe("registration");
    expect(result.count).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((row) => row.excerpt).sort()).toEqual(["first", "second"]);
    expect(result.truncated).toBe(false);
    expect(portal.calls[0]).toContain("search=registration");
    expect(portal.calls[0]).toContain("limit=25");
    await loadPageSearch(d, "registration", 10);
    expect(portal.calls).toHaveLength(1);
  });

  it("caps excerpts to excerpt_chars", async () => {
    const portal = new FakePortal(() => ({
      count: 1,
      results: [
        {
          slug: "long-page",
          title: "Long Page",
          body: "word ".repeat(200),
        },
      ],
    }));
    const d = deps(portal);
    const defaulted = await loadPageSearch(d, "long", 10);
    expect(defaulted.items[0]?.excerpt?.length).toBeLessThanOrEqual(120);
    expect(defaulted.items[0]?.excerpt?.endsWith("…")).toBe(true);

    const short = await loadPageSearch(d, "long", 10, 40);
    expect(short.items[0]?.excerpt?.length).toBeLessThanOrEqual(40);
  });

  it("ranks an exact title/slug first and reports truncation", async () => {
    const portal = new FakePortal(() => ({
      count: 56,
      results: [
        { slug: "internship-registration", title: "Internship Registration", body: "internship" },
        { slug: "registration-guide", title: "Registration Guide", body: "guide" },
        { slug: "registration-holds-trad", title: "Registration Holds", body: "holds" },
        { slug: "registration", title: "Registration", body: "overview" },
      ],
    }));
    const result = await loadPageSearch(deps(portal), "registration holds", 2);
    expect(result.count).toBe(56);
    expect(result.truncated).toBe(true);
    expect(result.items.map((row) => row.slug)).toEqual([
      "registration-holds-trad",
      "registration",
    ]);
  });

  it("loads and caches a page by slug", async () => {
    const portal = new FakePortal(() => ({
      slug: "meal-plan-information",
      title: "Meal Plan Information",
      category: { name: "Dining" },
      body: "Meal plan details",
    }));
    const d = deps(portal);
    const first = await loadPage(d, "meal-plan-information");
    const second = await loadPage(d, "meal-plan-information");
    expect(first.status).toBe("ok");
    expect(first).toMatchObject({
      slug: "meal-plan-information",
      body: "Meal plan details",
      body_truncated: false,
    });
    expect(second).toEqual(first);
    expect(portal.calls).toHaveLength(1);
    expect(portal.calls[0]).toContain("/api/v1/pages/slug/meal-plan-information/");
  });

  it("maps a 404 to not_found without caching an error", async () => {
    const portal = new FakePortal(() => {
      throw new PortalUnavailableError("portal request failed (HTTP 404)");
    });
    const d = deps(portal);
    const result = await loadPage(d, "missing-page");
    expect(result).toEqual({ status: "not_found", slug: "missing-page" });
  });
});
