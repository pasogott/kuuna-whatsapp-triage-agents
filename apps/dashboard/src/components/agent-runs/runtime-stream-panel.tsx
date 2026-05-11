"use client";

import { useEffect, useMemo, useState } from "react";

type RuntimeStreamPanelProps = {
  runId: string;
  initialText?: string;
};

type RuntimeEventDetail = {
  type?: string;
  entity_id?: string | null;
  payload?: Record<string, unknown>;
};

export function RuntimeStreamPanel({ runId, initialText }: RuntimeStreamPanelProps) {
  const [text, setText] = useState(initialText ?? "");
  const [events, setEvents] = useState<Array<{ type: string; label: string }>>([]);

  useEffect(() => {
    if (!initialText) return;
    setText((current) => (initialText.length > current.length ? initialText : current));
  }, [initialText]);

  useEffect(() => {
    const handleRuntimeEvent = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as RuntimeEventDetail | null) : null;
      if (!detail || detail.type !== "agent_run.stream" || detail.entity_id !== runId) return;
      const payload = detail.payload ?? {};
      const eventType = typeof payload.type === "string" ? payload.type : "unknown";
      if (eventType === "text_delta" && typeof payload.delta === "string") {
        setText((current) => current + payload.delta);
      }
      if (eventType.startsWith("tool_execution_")) {
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
        setEvents((current) => [...current.slice(-24), { type: eventType, label: toolName }]);
      }
    };

    window.addEventListener("kuuna:runtime-event", handleRuntimeEvent);
    return () => window.removeEventListener("kuuna:runtime-event", handleRuntimeEvent);
  }, [runId]);

  const eventSummary = useMemo(
    () => events.map((event) => `${event.type}: ${event.label}`).join("\n"),
    [events],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        {text ? (
          <pre className="max-h-[440px] overflow-auto rounded-md border border-border bg-muted/70 p-3 font-mono text-xs leading-relaxed text-foreground">
            <code>{text}</code>
          </pre>
        ) : (
          <p className="border-t border-border py-4 text-sm text-muted-foreground">
            Waiting for Pi stream deltas.
          </p>
        )}
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Stream events</h3>
        {eventSummary ? (
          <pre className="mt-2 max-h-[220px] overflow-auto rounded-md border border-border bg-muted/70 p-3 font-mono text-xs leading-relaxed text-foreground">
            <code>{eventSummary}</code>
          </pre>
        ) : (
          <p className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
            No tool stream events received for this open page.
          </p>
        )}
      </div>
    </div>
  );
}
