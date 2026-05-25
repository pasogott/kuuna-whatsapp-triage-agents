import { initTRPC } from "@trpc/server";
import { z } from "zod";

export type GatewayEventType =
  | "message_created"
  | "message_edited"
  | "message_deleted";

export const gatewayEventTypeSchema = z.enum([
  "message_created",
  "message_edited",
  "message_deleted",
]);

export const gatewayInboundMediaSchema = z.object({
  provider_media_id: z.string().min(1),
  mime_type: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  byte_size: z.number().int().nonnegative().nullable().optional(),
  download_url: z.string().nullable().optional(),
  inline_data_base64: z.string().nullable().optional(),
});

export const gatewayInboundMessageSchema = z.object({
  text: z.string().nullable().optional(),
  reply_to_provider_message_id: z.string().nullable().optional(),
  reply_to_provider_user_id: z.string().nullable().optional(),
  mentions: z.array(z.string()).default([]),
  media: z.array(gatewayInboundMediaSchema).default([]),
});

export const gatewayInboundEventSchema = z.object({
  trace_id: z.string().uuid(),
  provider: z.literal("whatsapp-baileys"),
  provider_group_id: z.string().min(1),
  provider_message_id: z.string().min(1),
  sender_provider_user_id: z.string().nullable().optional(),
  event_type: gatewayEventTypeSchema,
  occurred_at: z.string().datetime({ offset: true }),
  message: gatewayInboundMessageSchema,
  raw_event: z.record(z.unknown()).nullable().optional(),
});

export const gatewayInboundAckSchema = z.object({
  accepted: z.literal(true),
  trace_id: z.string().uuid(),
  deduped: z.boolean(),
  execution_enqueued: z.boolean(),
});

export const gatewayOutboundIntentSchema = z.object({
  trace_id: z.string().min(1).max(120),
  outbound_intent_id: z.string().min(1).max(120),
  provider_group_id: z.string().min(1).max(255),
  reply_to_provider_message_id: z.string().nullable().optional(),
  text: z.string().min(1).max(8000),
  metadata: z.record(z.unknown()).default({}),
});

export const gatewayOutboundStatusEventSchema = z.object({
  trace_id: z.string().uuid(),
  outbound_intent_id: z.string().uuid(),
  status: z.enum(["sent", "failed", "retrying"]),
  provider_message_id: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  occurred_at: z.string().datetime({ offset: true }),
});

export const gatewayOutboundStatusAckSchema = z.object({
  accepted: z.literal(true),
  found: z.boolean(),
});

const backendGatewayContractTrpc = initTRPC.create();

export const backendGatewayContractRouter = backendGatewayContractTrpc.router({
  gateway: backendGatewayContractTrpc.router({
    inbound: backendGatewayContractTrpc.router({
      ingest: backendGatewayContractTrpc.procedure
        .input(gatewayInboundEventSchema)
        .output(gatewayInboundAckSchema)
        .mutation(() => {
          throw new Error("backend gateway contract router is type-only");
        }),
    }),
    outbound: backendGatewayContractTrpc.router({
      status: backendGatewayContractTrpc.procedure
        .input(gatewayOutboundStatusEventSchema)
        .output(gatewayOutboundStatusAckSchema)
        .mutation(() => {
          throw new Error("backend gateway contract router is type-only");
        }),
    }),
  }),
});

export type GatewayInboundMedia = z.infer<typeof gatewayInboundMediaSchema>;

export type GatewayInboundMessage = z.infer<typeof gatewayInboundMessageSchema>;

export type GatewayInboundEvent = z.infer<typeof gatewayInboundEventSchema>;

export type GatewayInboundAck = z.infer<typeof gatewayInboundAckSchema>;

export type GatewayOutboundIntent = z.infer<typeof gatewayOutboundIntentSchema>;

export type GatewayOutboundStatusEvent = z.infer<typeof gatewayOutboundStatusEventSchema>;

export type GatewayOutboundStatusAck = z.infer<typeof gatewayOutboundStatusAckSchema>;

export type BackendGatewayContractRouter = typeof backendGatewayContractRouter;
