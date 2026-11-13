# The web link

FAF's web client (webclient.faforever.com, repository FAForever/faf-webclient)
can steer this client: a player starts a matchmaker search from their phone,
walks away, and the phone tells them when the match is found. The game itself
always runs here.

Off until the player turns it on: Settings, Account, Web client, "Allow control
from the web client" (`settings.webLink.enabled`).

## How the two meet

```
phone browser ──wss──►  webclient /api/link  ◄──wss──  this client
              ◄─push─   (Web Push, when this client reports a match)
```

Both ends connect out to the web client's server, which pairs them only when
both are signed in to the same FAF account. Nothing on this computer listens
for a connection.

- This client says who it is with its OIDC ID token in the first message,
  never its access token. The server checks the signature against Hydra's
  published keys (`/.well-known/jwks.json`), the issuer, the expiry, and that
  the token was issued to this client's OAuth client (`aud`; the Python
  client's id is accepted too, since remembered logins from before the switch
  are still renewed under it, see `infra/oauth.rs`). An ID token names the
  player and nothing more: neither the API nor the lobby accepts it. The
  server does not store it. A fresh one comes with every token renewal
  (`infra/session.rs` keeps it beside the access token).
- Nothing about the computer itself is sent: only the client's name and
  version ("FAF Rust client 1.2.3"), which is how the browser tells the player
  which PC it is talking to.
- A browser says who it is with a ticket the web client's server signed when
  the player logged in there. Browsers always send an `Origin`; the server
  refuses one on this client's side, so a web page cannot pose as this client.
- One computer per account. A second one signing in takes the link over and the
  first is told (`replaced`); it waits ten minutes before trying again.

## What crosses it

`faf-domain/src/protocol/web_link.rs`, JSON text frames, version 1.

Out, while a browser is connected and only when it changed (at most every
750 ms): who is signed in, the lobby connection, the matchmaker queues with
their titles ("2 vs 2"), the search, the party, the game this client is in
(and, when a join stopped short, why), the friends list with who is online and
in which game, and the open lobbies.

Out, whether or not a browser is connected, the two events the server turns
into a push notification for the player's phone:

- `matchFound`, with the queue and its title;
- `attention`, with a sentence the player can read, when a search or join the
  web client started stops at a decision only the player at this PC can make
  (the lobby needs other versions of installed mods) or fails. Only for what
  the web client asked for: a player sitting at this PC gets no push for
  their own clicks.

In, four requests and nothing else:

| Request | Becomes |
|---|---|
| `startSearch { queues }` | `LobbyCommand::StartSearch` |
| `stopSearch { queues? }` | `LobbyCommand::Matchmake { start: false }` per running queue |
| `joinGame { gameId, password? }` | `LobbyCommand::Join` |
| `refresh` | everything sent again |

Each is read by `RemoteCommand::parse` (the server checked it too, but this
client does not take its word for it) and checked by `plan` against this
client's own state: the setting, the lobby connection, a search already
running, a game already running, the party leader, the queue sizes, the lobby
being open and its password. The lobby service then checks everything again as
it does for a click in the Play tab. Every request that runs leaves a
`WebLink` notification here, so a search nobody at this desk started is never a
mystery.

An accepted request means the PC was asked, not that it succeeded: a join can
still stop at the mod replacement prompt or be refused by the server, which is
what `attention` is for. The browser says "Asked your PC to join", nothing more.

## The other end

The two ends are written in different languages in different repositories, so
neither compiler sees the other. `docs/web-link-protocol.json` is the contract
between them, generated from the types in `web_link.rs` by
`faf-domain/tests/web_link_protocol.rs`: one of each message this client sends
and reads, the limits, and requests as a browser might send them with what
each becomes once read (the shape the server must pass on, or a refusal).

- Here, `cargo test -p faf-domain --test web_link_protocol` fails while the
  file is out of date; add `-- --ignored` to rewrite it.
- The web client keeps a copy pinned to a commit of this repository, and its
  tests check its server (`lib/link.js`) against it. A change to the protocol
  here is not done until the web client has taken the new file.

## The deployment

webclient.faforever.com is a deployment this client depends on for the link
and nothing else: with it down, the setting does nothing and the client works
as before.

| | |
|---|---|
| Source | FAForever/faf-webclient |
| Runs on | FAF's cluster (FAForever/gitops-stack), one replica |
| Released | an image built from `main` by the repository's workflow |
| Maintained by | Nuggets |

## Where it lives

| Path | What |
|---|---|
| `faf-domain/src/protocol/web_link.rs` | Messages, the snapshot, `parse`, `plan` and `attention`. Pure and unit tested. |
| `faf-domain/tests/web_link_protocol.rs` | Writes and checks `docs/web-link-protocol.json`. |
| `faf-domain/src/state/settings/integrations.rs` | `WebLinkPreferences`. |
| `faf-app/src/ports/web_link.rs` | `WebLinkPort`: one connection as a pair of channels. |
| `faf-app/src/infra/web_link.rs` | The WebSocket (`FAF_WEB_LINK_URL` overrides the address; `wss://` only, or `ws://` to this machine). |
| `faf-app/src/services/web_link.rs` | The loop: connect while wanted, publish, answer, report, reconnect. Started next to Rich Presence. |
| `faf-app/tests/web_link.rs` | The loop against a scripted socket and lobby. |
| `ui/src/features/settings/WebLinkSettingsSection.tsx` | The switch. |
