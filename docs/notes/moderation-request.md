# Moderation request: mobile web client

Text for the ticket to the FAF moderation team. Written for readers who work
with the moderation tools but do not necessarily work on the server, so it says
what they will *see* rather than how it happens. The mechanism is in the
appendix, and in `mobile-web-app.md` section 5 for us.

---

## Mobile web client: a lot of players would show up on one machine

We are planning a mobile web client for FAF, and one part of it would change
what you see in your tools. We would rather have your decision before we build
it than explain it afterwards.

### What it is

A version of FAF for your phone, in the browser. News, chat, maps, mods, the
leaderboard, tournaments, events, training, the unit database, and a view of
the open lobbies that you can only *look* at. You cannot launch a game, join
one, host one, queue for matchmaking, watch a replay or download anything. It is
built on the Rust client, which may already appear in your data as
`faf-rust-client`.

Everyone signs in with their own FAF account. There is no shared account, no
bot, nobody playing on anyone else's behalf.

### What you would see

Because a web page cannot do the anti-smurf machine check by itself, the app
needs a server, and that one server does the check for everybody. So to FAF, all
of these players look like they are sitting at **the same computer, on the same
internet connection**: ours.

In practice, three things:

**1. One machine with hundreds of players on it.** Look up any player who uses
the app and check which machines they have been seen on: you will find their own
PC, and next to it our server. Search that server the way you would when
checking for ban evasion (*who else is on this machine*) and you get hundreds
of unrelated people. That query is the one this really costs you, which is why
we are asking rather than announcing.

**2. The wrong IP address, temporarily.** After someone uses the phone app, the
address shown for them is our server's, not theirs. FAF only stores the most
recent one, so their real address is not sitting behind it somewhere: it comes
back the next time they sign in from their PC. If you look someone up shortly
after they used their phone, the address you see is not where they are.

**3. People signing themselves out.** FAF allows one connection per account, so
opening the lobby view on the phone signs out the FAF client on that player's
PC, and if a game is running there, that game loses its connection. The app
warns them clearly before it happens and it only happens if they agree. You will
probably still be asked about it.

### How you can tell this apart from a smurf ring

- **A ring is accounts that have only ever been seen on one machine.** These
  players each have their own PC as well; our server is an extra entry next to
  it, not their only one. The exception is someone who uses the phone app and
  never plays on a PC at all: they would carry only ours.
- **Every one of these logins is labelled `faf-rust-client-mobile`** where you
  normally see which client someone used. That label and the IP address are
  recorded in the same place at the same time, so wherever you see the label,
  the address beside it is ours rather than the player's.
- **The machine details read like a server**, not like a gaming PC.

We also want to say plainly: we could have made every phone session look like a
different computer. That is easy to do, and it is what somebody with something
to hide would do. We are not doing it. There is one computer behind all of this
and it should appear as one computer.

### What we are asking

1. **Is this acceptable to you at all?** If it is not, we will drop the lobby
   part of the app rather than argue about it. The rest of it does not touch you.
2. **Can our server's machine entry be marked or excluded**, so it stops
   cluttering your searches?
3. **Is there anything you would want done differently**: a different label, the
   IP left alone, a note on the affected accounts, or something we have not
   thought of?

We will tell you the server and its address once that is settled, before
anything goes live.

### Appendix, if anyone wants the mechanism

Skippable. The lobby sign-in requires a `unique_id` from FAF's own `faf-uid`
program, which a browser cannot run, so our backend runs one instance for all
users. The lobby server sends that id to the policy service on every login; it
currently passes `ignore_result=True`, so nothing is enforced today, but the
association is recorded. The `login` table keeps one row per account with a
single `ip` and `user_agent` column and is updated, not appended, which is why
the address is replaced rather than added. The sign-out is the one-session-per-
account rule in `on_player_login`. We are happy to walk through any of it.
