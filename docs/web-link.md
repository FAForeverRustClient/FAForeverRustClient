# The web link

FAF's web client (webclient.faforever.com, repository FAForever/webclient) can
steer this client: a player starts a matchmaker search from their phone, walks
away, and the phone tells them when the match is found. The game itself always
runs here.

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

- This client says who it is with its own FAF access token in the first
  message. The server checks the signature against Hydra's published keys
  (`/.well-known/jwks.json`), the issuer, the expiry, and that the token was
  issued to this client's OAuth client (or the Python client's id, which
  remembered logins from before the switch are still renewed under; see
  `infra/oauth.rs`). The token is not stored there.
- A browser says who it is with a ticket the web client's server signed when
  the player logged in there. Browsers always send an `Origin`; the server
  refuses one on this client's side, so a web page cannot pose as this client.
- One computer per account. A second one signing in takes the link over and the
  first is told (`replaced`); it waits ten minutes before trying again.

## What crosses it

`faf-domain/src/protocol/web_link.rs`, JSON text frames, version 1.

Out, while a browser is connected and only when it changed (at most every
750 ms): who is signed in, the lobby connection, the matchmaker queues, the
search, the party, the game this client is in, the friends list with who is
online and in which game, and the open lobbies.

Out, whether or not a browser is connected: `matchFound`, which the server turns
into a push notification for the player's phone.

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

## Where it lives

| Path | What |
|---|---|
| `faf-domain/src/protocol/web_link.rs` | Messages, the snapshot, `parse` and `plan`. Pure and unit tested. |
| `faf-domain/src/state/settings/integrations.rs` | `WebLinkPreferences`. |
| `faf-app/src/ports/web_link.rs` | `WebLinkPort`: one connection as a pair of channels. |
| `faf-app/src/infra/web_link.rs` | The WebSocket (`FAF_WEB_LINK_URL` overrides the address; `wss://` only, or `ws://` to this machine). |
| `faf-app/src/services/web_link.rs` | The loop: connect while wanted, publish, answer, reconnect. Started next to Rich Presence. |
| `faf-app/tests/web_link.rs` | The loop against a scripted socket and lobby. |
| `ui/src/features/settings/WebLinkSettingsSection.tsx` | The switch. |
