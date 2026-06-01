import assert from "node:assert/strict";
import test from "node:test";

import { mapBaileysMessage } from "../src/mapping.js";

function baseMessage(message: Record<string, unknown>) {
  return {
    key: {
      id: "msg-1",
      remoteJid: "1203630-group@g.us",
      participant: "4912345@s.whatsapp.net",
      fromMe: false,
    },
    messageTimestamp: 1776506400,
    message,
  };
}

test("maps text message with raw payload, reply, and mentions", () => {
  const mapped = mapBaileysMessage(
    baseMessage({
      extendedTextMessage: {
        text: "hello",
        contextInfo: {
          stanzaId: "msg-0",
          participant: "4912@s.whatsapp.net",
          mentionedJid: ["4911@s.whatsapp.net"],
        },
      },
    }),
  );

  assert.equal(mapped.provider, "whatsapp-baileys");
  assert.equal(mapped.provider_group_id, "1203630-group@g.us");
  assert.equal(mapped.provider_message_id, "msg-1");
  assert.equal(mapped.sender_provider_user_id, "4912345@s.whatsapp.net");
  assert.equal(mapped.event_type, "message_created");
  assert.equal(mapped.message.text, "hello");
  assert.equal(mapped.message.reply_to_provider_message_id, "msg-0");
  assert.equal(mapped.message.reply_to_provider_user_id, "4912@s.whatsapp.net");
  assert.deepEqual(mapped.message.mentions, ["4911@s.whatsapp.net"]);
  assert.equal((mapped.raw_event?.key as Record<string, unknown>).id, "msg-1");
});

test("extracts media metadata and caption", () => {
  const mapped = mapBaileysMessage(
    baseMessage({
      imageMessage: {
        url: "https://example.com/image.enc",
        mimetype: "image/jpeg",
        fileLength: "1234",
        mediaKey: Buffer.from("media-key-1").toString("base64"),
        caption: "photo caption",
      },
    }),
  );

  assert.equal(mapped.message.text, "photo caption");
  assert.equal(mapped.message.media.length, 1);
  assert.equal(mapped.message.media[0]?.download_url, "https://example.com/image.enc");
  assert.equal(mapped.message.media[0]?.mime_type, "image/jpeg");
  assert.equal(mapped.message.media[0]?.byte_size, 1234);
  assert.equal(mapped.message.media[0]?.provider_media_id, Buffer.from("media-key-1").toString("base64"));
});

test("unwraps ephemeral messages", () => {
  const mapped = mapBaileysMessage(
    baseMessage({
      ephemeralMessage: {
        message: {
          conversation: "wrapped hello",
        },
      },
    }),
  );

  assert.equal(mapped.message.text, "wrapped hello");
});

test("classifies protocol edits and uses edited content", () => {
  const mapped = mapBaileysMessage(
    baseMessage({
      protocolMessage: {
        type: "MESSAGE_EDIT",
        editedMessage: {
          message: {
            conversation: "updated hello",
            imageMessage: {
              url: "https://example.com/edited.jpg",
              mimetype: "image/jpeg",
              mediaKey: "edited-media-key",
            },
          },
        },
      },
    }),
  );

  assert.equal(mapped.event_type, "message_edited");
  assert.equal(mapped.message.text, "updated hello");
  assert.equal(mapped.message.media[0]?.provider_media_id, "edited-media-key");
});

test("classifies revokes as deleted and uses target message id", () => {
  const mapped = mapBaileysMessage(
    baseMessage({
      protocolMessage: {
        type: "REVOKE",
        key: { id: "msg-original-1" },
      },
    }),
  );

  assert.equal(mapped.event_type, "message_deleted");
  assert.equal(mapped.provider_message_id, "msg-original-1");
  assert.equal(mapped.message.text, null);
  assert.deepEqual(mapped.message.media, []);
});

test("ignores empty media shells", () => {
  const mapped = mapBaileysMessage(
    baseMessage({
      conversation: "hi",
      imageMessage: {
        fileLength: "0",
        mimetype: "",
      },
    }),
  );

  assert.deepEqual(mapped.message.media, []);
});
