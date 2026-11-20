// The voter picture is optional. These tests never call the network or a wallet.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ballotImageFailure, createBallotImageView, pictureMatchesLedger } from "../public/js/logic.js";

const HASH = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function okResponse(bytes = new Uint8Array([1, 2, 3]), type = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === "content-type" ? type : null) },
    arrayBuffer: async () => bytes.buffer,
    json: async () => ({}),
  };
}

function failResponse(status: number, error = "") {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => (error ? { error } : {}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("optional ballot image", () => {
  it("does not fetch until load is called", async () => {
    let calls = 0;
    const view = createBallotImageView();
    const fetchImage = async () => {
      calls += 1;
      return okResponse();
    };
    expect(calls).toBe(0);
    await view.load({
      fetchImage,
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:1",
      expectedHash: "0x" + HASH,
    });
    expect(calls).toBe(1);
  });

  it("hashes the bytes before creating the object URL and only then reports a match", async () => {
    const order: string[] = [];
    const view = createBallotImageView();
    const result = await view.load({
      fetchImage: async () => okResponse(new Uint8Array([9]), "image/png"),
      hashBytes: async () => {
        order.push("hash");
        return HASH;
      },
      objectUrlFor: () => {
        order.push("url");
        return "blob:match";
      },
      expectedHash: HASH,
    });
    expect(order).toEqual(["hash", "url"]);
    expect(result).toMatchObject({ status: "ready", matches: true, url: "blob:match", hex: HASH });
  });

  it("reports a mismatch without calling it trustworthy", async () => {
    const view = createBallotImageView();
    const result = await view.load({
      fetchImage: async () => okResponse(),
      hashBytes: async () => OTHER,
      objectUrlFor: () => "blob:bad",
      expectedHash: HASH,
    });
    expect(result).toMatchObject({ status: "ready", matches: false, hex: OTHER, url: "blob:bad" });
    expect(pictureMatchesLedger(OTHER, HASH).matches).toBe(false);
  });

  it("does not start a second download while the first is still running", async () => {
    const gate = deferred<ReturnType<typeof okResponse>>();
    let calls = 0;
    const view = createBallotImageView();
    const first = view.load({
      fetchImage: () => {
        calls += 1;
        return gate.promise;
      },
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:1",
      expectedHash: HASH,
    });
    const second = await view.load({
      fetchImage: () => {
        calls += 1;
        return Promise.resolve(okResponse());
      },
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:2",
      expectedHash: HASH,
    });
    expect(second).toEqual({ status: "duplicate" });
    expect(calls).toBe(1);
    gate.resolve(okResponse());
    await first;
    expect(calls).toBe(1);
  });

  it("a new lookup revokes the picture on screen and ignores the download still in flight", async () => {
    const gate = deferred<ReturnType<typeof okResponse>>();
    const view = createBallotImageView();
    const shown = await view.load({
      fetchImage: async () => okResponse(),
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:shown",
      expectedHash: HASH,
    });
    expect(shown).toMatchObject({ status: "ready", url: "blob:shown" });
    const pending = view.load({
      fetchImage: () => gate.promise,
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:late",
      expectedHash: HASH,
    });
    expect(view.reset()).toBe("blob:shown");
    gate.resolve(okResponse());
    await expect(pending).resolves.toMatchObject({ status: "stale" });
    let calls = 0;
    const next = await view.load({
      fetchImage: async () => {
        calls += 1;
        return okResponse();
      },
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:next",
      expectedHash: HASH,
    });
    expect(calls).toBe(1);
    expect(next).toMatchObject({ status: "ready", url: "blob:next" });
  });

  it("keeps the retention, missing, and rate-limit messages and allows another try", async () => {
    expect(ballotImageFailure(410, "ignored").title).toBe("Image expired");
    expect(ballotImageFailure(410, "ignored").text).toMatch(/Fingerprints and readings stay on the chain/);
    const view = createBallotImageView();
    const missing = await view.load({
      fetchImage: async () => failResponse(404, "no image found for that election and ballot code"),
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:no",
      expectedHash: HASH,
    });
    expect(missing).toMatchObject({ status: "error", title: "No picture is stored for this ballot (yet)" });
    const staticPage = await view.load({
      fetchImage: async () => ({
        ok: false,
        status: 404,
        headers: { get: () => "text/html" },
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => {
          throw new Error("not json");
        },
      }),
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:no",
      expectedHash: HASH,
    });
    expect(staticPage).toMatchObject({ status: "error", title: "This page has no picture service" });
    expect(staticPage.status === "error" ? staticPage.text : "").not.toMatch(/isn't available from this site/);
    const again = await view.load({
      fetchImage: async () => failResponse(429),
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:no",
      expectedHash: HASH,
    });
    expect(again).toMatchObject({ status: "error", title: "Too many lookups" });
    const down = await view.load({
      fetchImage: async () => {
        throw new Error("offline");
      },
      hashBytes: async () => HASH,
      objectUrlFor: () => "blob:no",
      expectedHash: HASH,
    });
    expect(down).toMatchObject({ status: "error", text: "The image service didn't answer. Your ledger entry above is not affected." });
  });

  it("the voter page does not request an image until the view button runs", () => {
    const src = readFileSync(new URL("../public/js/voter.js", import.meta.url), "utf8");
    expect(src).toContain("View original ballot image");
    expect(src).toContain("Report a problem");
    expect(src).toContain("Open full size");
    expect(src).not.toContain("loadImage(");
    const fetchAt = src.indexOf("fetch(");
    const clickAt = src.indexOf('addEventListener("click"');
    expect(clickAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(clickAt);
    expect(src.split("fetch(").length - 1).toBe(1);
  });
});
