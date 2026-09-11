# FAF Live: announcing the stream

The client tells players when FAF's own Twitch channel goes live. This page is
the whole operational story, because the feature has one prerequisite that is
not in this repository and cannot be.

## What the client does

- Checks every five minutes whether the configured channels are broadcasting.
- Raises **one notification per broadcast**, in the notification list. Not a
  toast over a running game, not a strip across the top of the window, and
  nothing in the sidebar: `NotificationKind::StreamLive` is deliberately absent
  from the list of kinds that reach the operating system.
- Marks the channel **LIVE** on the External links page while it is, with the
  broadcaster's own stream title and the viewer count.
- Turns off with one switch, under Settings, Notifications, "FAF goes live".
  On by default.

A channel that has been live for three hours is announced once. The key is the
platform's id for the *broadcast*, not for the channel, so going live again is
news again. Going off air and coming back is a second announcement; reloading
the page is not.

## What it needs, and why it is not here

Twitch does not tell anybody whether a channel is live without an application's
own credentials. There is no unauthenticated endpoint, no feed, and no page a
client can read that answers it reliably. Helix wants a client id and a client
secret, exchanged for an application token under the client-credentials grant.

A client secret in a public repository is not a secret, so **this build ships
without one**, and that is not a broken state: `StreamsPort::can_check` answers
`false`, the five-minute ticker never starts, no request is ever made, and the
feature is silently absent. One line at startup says so, so that an operator
wondering why it is quiet has something to read.

## Configuring it

1. Register an application at <https://dev.twitch.tv/console/apps>. Any
   redirect URI will do: the client-credentials grant never uses one. The
   token this produces grants access to public information and belongs to the
   application, not to any player.
2. Put the two values in the environment the client is built or run with:

```powershell
$env:TWITCH_CLIENT_ID = "<the application's client id>"
$env:TWITCH_CLIENT_SECRET = "<the application's client secret>"
pnpm tauri dev
```

3. Optionally override which channels are watched. The default is FAF's own:

```powershell
$env:FAF_TWITCH_CHANNELS = "faflive, stellartactician"
```

Comma or whitespace separated, case-insensitive, deduplicated.

### A note on rate limits

Twitch's rate limit is **per application**, not per client. Every copy of the
client that shares one set of credentials shares one budget, which is why the
poll is five minutes rather than thirty seconds, and why raising it should be
thought about rather than typed. A stream runs for hours; hearing about it four
minutes in costs nobody anything.

## YouTube

Not implemented, and it is a second adapter rather than a flag on this one.
YouTube's Data API needs a key of its own, and it answers a differently shaped
question: a channel's current live broadcast is a `search` call rather than a
field, which is both more quota-expensive and less precise.
`StreamPlatform::YouTube` already exists, `StreamsPort` is the boundary it would
be implemented behind, and nothing above this line would change.

## Where the code is

| Piece | File |
| --- | --- |
| The slice, and what "already announced" means | `crates/faf-domain/src/state/streams.rs` |
| The boundary, including why an empty answer is normal | `crates/faf-app/src/ports/streams.rs` |
| Twitch, the token cache, and the inert mode | `crates/faf-app/src/infra/streams.rs` |
| The ticker and the announcement | `crates/faf-app/src/services/streams.rs` |
| The LIVE badge | `ui/src/features/links/LinksView.tsx` |
| The switch | `ui/src/features/settings/NotificationsSettingsSection.tsx` |
