CREATE INDEX IF NOT EXISTS ix_outbound_intents_group_dispatch_provider_message
  ON outbound_intents (
    provider_group_id,
    ((payload->'_dispatch'->>'provider_message_id'))
  )
  WHERE (payload->'_dispatch'->>'provider_message_id') IS NOT NULL;
