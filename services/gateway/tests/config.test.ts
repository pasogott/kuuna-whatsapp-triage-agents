import assert from "node:assert/strict";
import test from "node:test";

import { getSettings, resetSettingsForTests } from "../src/config.js";

const historyEnvKeys = ["GATEWAY_SYNC_FULL_HISTORY", "GATEWAY_PROCESS_HISTORY_SYNC"] as const;

function withHistoryEnv(values: Partial<Record<(typeof historyEnvKeys)[number], string>>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of historyEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  resetSettingsForTests();
  try {
    fn();
  } finally {
    for (const key of historyEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetSettingsForTests();
  }
}

test("history sync env flags default to disabled", () => {
  withHistoryEnv({}, () => {
    const settings = getSettings();
    assert.equal(settings.GATEWAY_SYNC_FULL_HISTORY, false);
    assert.equal(settings.GATEWAY_PROCESS_HISTORY_SYNC, false);
  });
});

test("history sync env flags parse explicit true values", () => {
  for (const value of ["true", "1", "yes", "on"]) {
    withHistoryEnv({ GATEWAY_SYNC_FULL_HISTORY: value, GATEWAY_PROCESS_HISTORY_SYNC: value }, () => {
      const settings = getSettings();
      assert.equal(settings.GATEWAY_SYNC_FULL_HISTORY, true, value);
      assert.equal(settings.GATEWAY_PROCESS_HISTORY_SYNC, true, value);
    });
  }
});

test("history sync env flags parse explicit false values", () => {
  for (const value of ["false", "0", "no", "off", ""]) {
    withHistoryEnv({ GATEWAY_SYNC_FULL_HISTORY: value, GATEWAY_PROCESS_HISTORY_SYNC: value }, () => {
      const settings = getSettings();
      assert.equal(settings.GATEWAY_SYNC_FULL_HISTORY, false, value);
      assert.equal(settings.GATEWAY_PROCESS_HISTORY_SYNC, false, value);
    });
  }
});
