import { tracked, TRPCError } from "@trpc/server";
import { z } from "zod";

import { runtimeEventTypeSchema, subscribeRuntimeEvents } from "../../runtime/events.js";
import { authenticatedProcedure, createTRPCRouter } from "../init.js";

const subscriptionInputSchema = z.object({
  providerGroupId: z.string().nullable().optional(),
  types: z.array(runtimeEventTypeSchema).optional(),
}).optional();

export const runtimeEventsRouter = createTRPCRouter({
  onEvent: authenticatedProcedure
    .input(subscriptionInputSchema)
    .subscription(async function* ({ ctx, input, signal }) {
      const providerGroupId = input?.providerGroupId ?? null;
      const types = input?.types ? new Set(input.types) : null;
      const isPrivileged = ctx.auth?.role === "owner" || ctx.auth?.role === "admin";
      const allowedGroups = new Set(ctx.auth?.groupScope ?? []);

      if (
        providerGroupId &&
        !isPrivileged &&
        !allowedGroups.has(providerGroupId)
      ) {
        throw new TRPCError({ code: "FORBIDDEN", message: "group outside auth scope" });
      }

      const subscriptionSignal: AbortSignal = signal ?? new AbortController().signal;
      for await (const event of subscribeRuntimeEvents(subscriptionSignal)) {
        if (ctx.auth && ctx.auth.sessionExpiresAt.getTime() <= Date.now()) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "token expired" });
        }
        if (providerGroupId && event.provider_group_id !== providerGroupId) continue;
        if (!providerGroupId && !isPrivileged && (!event.provider_group_id || !allowedGroups.has(event.provider_group_id))) continue;
        if (types && !types.has(event.type)) continue;
        yield tracked(event.id, event);
      }
    }),
});
