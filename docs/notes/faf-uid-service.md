# The `faf-uid` service

What the mobile web client needs from the host that runs `faf-uid`, and what we
need to know back about it. Written to be handed to whoever operates that host.

---

## Why this exists

The FAF lobby handshake ends with `auth { token, unique_id, session }`.
`unique_id` is an anti-smurf machine proof produced by FAF's own `faf-uid`
binary, run against the session id the lobby server just issued. A browser
cannot run a binary, so the mobile client's backend obtains the proof over HTTP
from a host that can.

Every mobile player authenticates with **their own** FAF token. The only thing
shared between them is this proof: one machine, honestly identified as one
machine.

---

## The binary

The official release, not a rebuild:

```
https://github.com/FAForever/uid/releases/download/v4.0.7/faf-uid
```

`sha256 1136d0e1cd7e61682ad375043fdac4bae690bf63d7fdd98a7a3a1fb9ccac61da`

That is the Linux x86_64 asset, and v4.0.7 is the version this client pins
(`scripts/ensure-faf-uid.mjs`), kept in sync with the official Java client. It
needs the executable bit. If a newer release is deployed, we need to be told
which, because the desktop client pins a digest and the two should not drift
apart silently.

---

## The contract

```
POST /uid
Authorization: Bearer <shared secret>
Content-Type: application/json

{ "session": "1234567890" }
```

```
200 OK
{ "uid": "<the blob faf-uid printed on stdout>" }
```

Implementation is `faf-uid <session>`, with the session id as a single plain
string argument, and stdout returned verbatim apart from trimming whitespace.

On failure, a non-2xx status and `faf-uid`'s **stderr** in the body. Its own
complaint is usually the only thing that says what went wrong, and we have
already been burned once by losing it: a helper error passed through as if it
were a proof reaches the lobby server as a credential, which answers with a bare
`{"command": "invalid"}` and drops the connection, naming neither the helper nor
the reason. Never return stderr in the success field.

---

## Six things that matter

**1. Per session, never cached.** The proof is computed over the session id, and
the lobby server sends both the proof and the session to the policy service. A
cached blob is not a valid proof for a different session. Every call runs the
binary.

**2. It is slow.** Measured in the desktop client: ~15 s on a cold first run,
~2.4 s warm. Worth measuring on that host, but plan for seconds, not
milliseconds, and for several calls in flight at once, since every mobile
player opening the Play tab produces one. Please do not serialise them behind a
single lock: a queue of 2-second runs becomes a login timeout. Request timeout
should sit above 20 s.

**3. The fingerprint must be stable.** All mobile players will present the same
proof, and that is the honest thing for them to present, because there genuinely
is one machine behind them. If the service runs in throwaway containers whose
machine identifiers change per call, it would instead look like many machines to
FAF's anti-smurf system, which is the opposite of what we want. Run it on the
host, or in a long-lived container, and tell us which, and whether the value
survives a restart.

**4. It must not be open to the internet.** Anything that can call this endpoint
can mint lobby-valid machine proofs carrying *your* host's identity, and
whatever is then done with them is associated with your machine. A shared secret
in an `Authorization` header is the minimum; an IP allowlist on top is better,
since exactly one backend will ever call it.

**5. Do not log the proofs.** They are credentials. Session ids are short-lived
and fine to log; the blob is not.

**6. No console suppression needed.** The desktop client hides the helper's
console window on Windows. On a Linux server there is nothing to hide.

---

## One check to run once it stands

Run `faf-uid` on that host once and keep the output. FAF's moderator client can
search the decrypted proof by *Device Id*, *CPU Name*, *Manufacturer*, *Bios
Version*, *Serial Number*, *Volume Serial Number* and *Memory Serial Number*, so
what the binary reports there is what a moderator will see next to every mobile
player's account. A datacenter host should not read like a gaming PC, and if
some fields come back empty or synthetic on that hardware, that is worth knowing
before anyone else notices it rather than after.

---

## Where it can live

Either on the same host as the mobile backend or somewhere else entirely. The
lobby server never correlates the proof with the address the connection comes
from: the policy payload it sends is `player_id`, `uid_hash` and `session`, and
carries no address at all. So the service may sit behind a private network,
a VPN, or a firewall rule, and the backend may be hosted anywhere.

---

## What we need back

1. The base URL and the auth scheme, plus the secret through a channel that is
   not this document.
2. The `faf-uid` version actually deployed.
3. Host or container, and whether the proof is stable across restarts.
4. How many concurrent calls it will tolerate, and its timeout.
5. Who to contact when it stops answering, because a mobile player's Play tab
   stops working the moment it does.
6. Under what terms this is offered: who operates the host, and whether FAF is
   aware it serves this purpose. This is asked because the project does not add
   a dependency it cannot identify, not because anything is suspected.
