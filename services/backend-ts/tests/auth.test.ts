import assert from "node:assert/strict";
import test from "node:test";

import { decodeAccessToken, passwordPolicyViolations } from "../src/auth.js";
import { getSettings, resetSettingsForTests } from "../src/config.js";

test("production settings reject default better auth secret", (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppEnv = process.env.APP_ENV;
  const previousSecret = process.env.BETTER_AUTH_SECRET;

  t.after(() => {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousAppEnv;
    }
    if (previousSecret === undefined) {
      delete process.env.BETTER_AUTH_SECRET;
    } else {
      process.env.BETTER_AUTH_SECRET = previousSecret;
    }
    resetSettingsForTests();
  });

  process.env.NODE_ENV = "production";
  delete process.env.APP_ENV;
  delete process.env.BETTER_AUTH_SECRET;
  resetSettingsForTests();
  assert.throws(() => getSettings(), /BETTER_AUTH_SECRET/);

  process.env.BETTER_AUTH_SECRET = "a".repeat(32);
  resetSettingsForTests();
  assert.equal(getSettings().BETTER_AUTH_SECRET, "a".repeat(32));
});

test("password policy reports domain violations", () => {
  const violations = passwordPolicyViolations("aaaaaaaa");
  assert.ok(violations.includes("must include an uppercase letter"));
  assert.ok(violations.includes("must include a digit"));
  assert.ok(violations.includes("must include a symbol"));
});

test("malformed access tokens decode to null", () => {
  assert.equal(decodeAccessToken("not-json.bad-signature"), null);
});
