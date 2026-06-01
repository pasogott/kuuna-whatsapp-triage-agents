import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTrigger } from "../src/trigger.js";

test("mention trigger wins", () => {
  const decision = evaluateTrigger({
    message: {
      text: "@agent kuuna: hi",
      reply_to_provider_message_id: "msg-1",
      mentions: ["agent"],
    },
  });
  assert.equal(decision.shouldExecute, true);
  assert.equal(decision.triggerType, "mention");
  assert.equal(decision.reason, "agent_mention_present");
});

test("configured agent identity mention triggers by WhatsApp lid", () => {
  const decision = evaluateTrigger(
    {
      message: {
        text: "@2768027737581120",
        reply_to_provider_message_id: null,
        mentions: ["2768027737581120@lid"],
      },
    },
    { agentMentionIds: ["2768027737581120@lid"] },
  );
  assert.equal(decision.shouldExecute, true);
  assert.equal(decision.triggerType, "mention");
  assert.equal(decision.reason, "agent_mention_present");
});

test("configured agent identity mention triggers by WhatsApp phone jid", () => {
  const decision = evaluateTrigger(
    {
      message: {
        text: "@436765308907",
        reply_to_provider_message_id: null,
        mentions: ["436765308907@s.whatsapp.net"],
      },
    },
    { agentMentionIds: ["436765308907"] },
  );
  assert.equal(decision.shouldExecute, true);
  assert.equal(decision.triggerType, "mention");
});

test("reply trigger is detected", () => {
  const decision = evaluateTrigger(
    {
      message: {
        text: "plain",
        reply_to_provider_message_id: "msg-1",
        reply_to_provider_user_id: "2768027737581120@lid",
        mentions: [],
      },
    },
    { agentMentionIds: ["2768027737581120@lid"] },
  );
  assert.equal(decision.shouldExecute, true);
  assert.equal(decision.triggerType, "reply");
  assert.equal(decision.reason, "reply_to_agent_message_present");
});

test("reply trigger falls back to known bot outbound message id", () => {
  const decision = evaluateTrigger(
    {
      message: {
        text: "plain",
        reply_to_provider_message_id: "msg-1",
        mentions: [],
      },
    },
    { replyToAgent: true },
  );
  assert.equal(decision.shouldExecute, true);
  assert.equal(decision.triggerType, "reply");
});

test("reply to non-agent message does not trigger", () => {
  const decision = evaluateTrigger(
    {
      message: {
        text: "plain",
        reply_to_provider_message_id: "msg-1",
        reply_to_provider_user_id: "111111111111@lid",
        mentions: [],
      },
    },
    { agentMentionIds: ["2768027737581120@lid"] },
  );
  assert.equal(decision.shouldExecute, false);
  assert.equal(decision.triggerType, null);
});

test("reply with unknown quoted message id does not trigger", () => {
  const decision = evaluateTrigger(
    {
      message: {
        text: "plain",
        reply_to_provider_message_id: "human-msg-1",
        mentions: [],
      },
    },
    { agentMentionIds: ["2768027737581120@lid"] },
  );
  assert.equal(decision.shouldExecute, false);
  assert.equal(decision.triggerType, null);
});

test("command-looking prefixes do not trigger by themselves", () => {
  const decision = evaluateTrigger({
    message: {
      text: "  /kuuna help",
      reply_to_provider_message_id: null,
      mentions: [],
    },
  });
  assert.equal(decision.shouldExecute, false);
  assert.equal(decision.triggerType, null);
});

test("plain messages do not trigger", () => {
  const decision = evaluateTrigger({
    message: {
      text: "hello",
      reply_to_provider_message_id: null,
      mentions: [],
    },
  });
  assert.equal(decision.shouldExecute, false);
  assert.equal(decision.triggerType, null);
});
