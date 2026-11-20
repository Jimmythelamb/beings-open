import { describe, expect, it } from "vitest";
import { clientKey } from "../src/rateLimit.js";

describe("client address", () => {
  it("prefers the platform header over a spoofable forwarded address", () => {
    const req = new Request("https://beingsvote.test/api/images", {
      headers: { "x-nf-client-connection-ip": "203.0.113.9", "cf-connecting-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
    });
    expect(clientKey(req)).toBe("203.0.113.9");
    expect(clientKey(new Request("https://beingsvote.test/", { headers: { "cf-connecting-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" } }))).toBe("203.0.113.8");
    expect(clientKey(new Request("https://beingsvote.test/", { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" } }))).toBe("198.51.100.1");
    expect(clientKey(new Request("https://beingsvote.test/"))).toBe("unknown");
  });
});
