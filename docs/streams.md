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

## What it needs

Twitch does not tell anybody whether a channel is live without an application's
own credentials. There is no unauthenticated endpoint, no feed, and no page a
client can read that answers it reliably. Helix wants a client id and a client
secret, exchanged for an application token under the client-credentials grant.

A client secret in a public repository is not a secret, so **the repository
does not contain one**. A build is given them from the environment instead, and
a build that was not is not in a broken state: `StreamsPort::can_check` answers
`false`, the five-minute ticker never starts, no request is ever made, and the
feature is silently absent. One line at startup says so, so that an operator
wondering why it is quiet has something to read.

Which means an official release announces streams and a build from a clone of
this repository does not, without the two differing by a line of code.

## Configuring it

1. Register an application at <https://dev.twitch.tv/console/apps>. The token
   this produces grants access to public information and belongs to the
   application, not to any player.

   Set **Client Type** to *Confidential*: that is the only setting that gives
   you a client secret, and the grant does not work without one. The **OAuth
   Redirect URL** field is mandatory in the form and never used by this flow;
   `http://localhost:3000` is what Twitch's own examples use. If the console
   rejects it with "must use the HTTPS protocol", the cause is usually a blank
   second redirect row being validated rather than the value you typed: remove
   it and press Save rather than Add.

2. **To try it locally**, put the two values in your shell and run the client:

```powershell
$env:TWITCH_CLIENT_ID = "<the application's client id>"
$env:TWITCH_CLIENT_SECRET = "<the application's client secret>"
pnpm tauri dev
```

3. **To ship it**, add the same two values as repository secrets named
   `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` (Settings, Secrets and
   variables, Actions). The release workflow passes them to the build, and
   `option_env!` bakes them in; a release built without them behaves exactly as
   it does today, with the feature silently off.

   The runtime environment still wins where both exist, so a shell variable
   overrides a baked-in value and a local check of a release build is possible.

4. Optionally override which channels are watched. The default is FAF's own:

```powershell
$env:FAF_TWITCH_CHANNELS = "faflive, stellartactician"
```

Comma or whitespace separated, case-insensitive, deduplicated.

### What "not in the repository" does and does not buy

A string compiled into a binary is a string anybody can read out of it, and no
encoding changes that while the key to decode it ships alongside. So this is
not a way to keep the secret from the people running the client, and it is not
meant to be.

What it does buy is the thing worth buying: the secret is not in the repository
and not in its git history, which is the leak that actually costs something.
The token reads public "is this channel live" information and nothing else, so
the worst an extracted copy can do is spend the rate limit, and the answer to
that is to rotate it.

The only design that keeps the secret genuinely secret is a small FAF-hosted
endpoint that holds it and answers the same question, leaving the client with
no credentials at all. `StreamsPort` is the boundary that would be implemented
behind, and nothing above this line would change.

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
