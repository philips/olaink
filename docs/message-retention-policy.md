# Ola Ink message retention policy

- A note not yet acknowledged by every device it was sent to is deleted
  automatically 14 days after it was sent, along with its encrypted content.
  There is no way to recover it after that, for support or otherwise.
- A note already acknowledged by every device in its recipient's directory is
  deleted immediately, well before the 14-day window would apply.
- The 14-day clock runs from send time (`prototype_notes.created_at`), not
  from when a recipient last checked their inbox.
- Deletion is per note, not per delivery: if a recipient has more than one
  paired device and only some of them poll before day 14, the note is still
  deleted for all of them at day 14 — including a device that never got a
  chance to receive it.
- Enforcement: the Worker runs the sweep on a Cron Trigger
  (`packages/server/wrangler.jsonc`, `triggers.crons`, every 6 hours); the
  standalone binary runs the same sweep on an in-process interval, or once via
  `olaink-server --retention-sweep-once` for operators who prefer an external
  cron/systemd timer. See [`plans/message-retention.md`](../plans/message-retention.md)
  for the design and [`packages/server/README.md`](../packages/server/README.md#data-retention-and-loss).
