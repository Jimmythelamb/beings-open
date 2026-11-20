import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SCANNER_UPLOAD_TOKEN: "t".repeat(40),
          VERIFIER_AUTH_MODE: "allowlist",
          VERIFIER_ADDRESSES: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
          ALLOWED_ORIGINS: "https://beingsvote.live",
          MAX_IMAGE_BYTES: "1000",
          COMMENT_ADMIN_TOKEN: "a".repeat(40),
          TURNSTILE_SECRET: "s".repeat(40),
          TURNSTILE_HOSTNAMES: "beingsvote.live",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], fileParallelism: false },
});
