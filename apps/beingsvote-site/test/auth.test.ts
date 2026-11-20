import { describe, expect, it } from "vitest";
import { checkBearer, constantTimeEqual } from "../src/auth.js";
import { handleUpload } from "../src/upload.js";
import { MockStore, NOW, TOKEN, testConfig, uploadRequest } from "./helpers.js";

const deps = (store = new MockStore(), over = {}) => ({ store, config: testConfig(over), now: () => NOW });

describe("bearer token", () => {
  it("accepts the right token", () => expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe("ok"));
  it("accepts a lower-case scheme", () => expect(checkBearer(`bearer ${TOKEN}`, TOKEN)).toBe("ok"));
  it("rejects wrong, prefix, extended, empty and missing tokens", () => {
    for (const h of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, "Bearer ", "Bearer", TOKEN, "Basic abc", "", null]) {
      expect(checkBearer(h, TOKEN)).toBe("unauthorized");
    }
  });
  it("fails closed when the secret is unset or short", () => {
    expect(checkBearer("Bearer abc", "")).toBe("not-configured");
    expect(checkBearer("Bearer short", "short")).toBe("not-configured");
  });
  it("constantTimeEqual compares by value, for any lengths", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("a", "aa")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("upload auth", () => {
  it("401 without a token, and nothing is stored", async () => {
    const store = new MockStore();
    const res = await handleUpload(uploadRequest({ headers: { authorization: null } }), deps(store));
    expect(res.status).toBe(401);
    expect(store.map.size).toBe(0);
  });
  it("401 with a wrong token", async () => {
    const res = await handleUpload(uploadRequest({ headers: { authorization: "Bearer " + "x".repeat(40) } }), deps());
    expect(res.status).toBe(401);
  });
  it("503 when the secret is not configured, even with a matching empty bearer", async () => {
    const res = await handleUpload(uploadRequest(), deps(new MockStore(), { uploadToken: "" }));
    expect(res.status).toBe(503);
  });
  it("auth is checked before the body is examined (bad hash with bad token is still 401)", async () => {
    const res = await handleUpload(uploadRequest({ headers: { authorization: "Bearer nope", "x-image-sha256": "zz" } }), deps());
    expect(res.status).toBe(401);
  });
});
