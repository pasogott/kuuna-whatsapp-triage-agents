"use client";

import { useEffect } from "react";
import { EventSourcePolyfill } from "event-source-polyfill";
import { createKuunaTrpcClient, type KuunaEventSource } from "@kuuna/api-client-ts";

type RealtimeProviderProps = {
  baseUrl: string;
  children: React.ReactNode;
};

export function RealtimeProvider({ baseUrl, children }: RealtimeProviderProps) {
  useEffect(() => {
    const client = createKuunaTrpcClient({
      baseUrl,
      withCredentials: true,
      eventSource: EventSourcePolyfill as unknown as KuunaEventSource,
    });
    const subscription = client.runtimeEvents.onEvent.subscribe(undefined, {
      onData(event) {
        window.dispatchEvent(new CustomEvent("kuuna:runtime-event", { detail: unwrapTrackedEvent(event) }));
      },
      onError(error) {
        console.warn("[kuuna-realtime] subscription failed", error);
      },
    });
    return () => {
      subscription.unsubscribe();
    };
  }, [baseUrl]);

  return children;
}

function unwrapTrackedEvent(event: unknown): unknown {
  if (
    event &&
    typeof event === "object" &&
    "data" in event &&
    typeof event.data === "object" &&
    event.data !== null
  ) {
    return event.data;
  }
  return event;
}
