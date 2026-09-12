# Notification sounds

## What ships

Five tones, synthesised rather than sampled: each is a few sine partials and an
envelope, built in `ui/src/features/notifications/notificationSound.ts`. A tone
made that way costs no audio file and no decoder.

Plus **one sample**: `fafMatch`, the sound the FAF Java client plays when the
matchmaker finds you a game. It is the only audio file the client ships. It is
here because "a match was found" is a sound people already know by ear from the
other client, and no arrangement of sine partials is going to be that sound.
Vendored from `FAForever/downlords-faf-client`, which carries it under the
Pixabay licence; see `THIRD_PARTY_NOTICES.md`.

Each of the twelve notification kinds picks one, in Settings, Notifications.
Eleven default to `chime`, the tone the client played for everything before the
picker existed. **A found match defaults to `fafMatch`**, because it is the one
notification that expires: miss it and the match is gone.

### Changing a default later

A settings file stores all twelve rows on every save, so changing a default in
`NotificationSoundChoices` reaches nobody who has ever opened the client: their
file already names the old value. `NotificationPreferences::sound_choice_version`
is how a change gets through. Bump `NOTIFICATION_SOUND_CHOICE_VERSION`, and give
the deserializer a rule for which stored value counts as "written by the old
default" rather than chosen.

The rule for version 1 is `chime` in the match-found row: every file written
before this had it, and nobody could have meant it, because it was what all
twelve said. Anything else there -- including a deliberate `silent` -- is a
choice and is left alone.

## Sounds a player adds

The five cannot answer "I want *this* sound". So the dropdown also offers
**Add a sound file...**, which opens a picker, copies the chosen file into
`sounds/` under the client's data directory, and selects it in the row that
asked.

A copy, not a reference. A path into somebody's Downloads folder stops working
the first time they tidy up, and a settings file naming a file inside the
client's own directory travels with that directory to another machine.

What the settings store is therefore a **file name**, never a path:
`{"custom": "horn.wav"}`. `crates/faf-app/src/infra/notification_sounds.rs` is
the only thing that turns one back into a location on disk, and it refuses any
name with a separator or a parent component in it, because a settings file is
editable text and a name out of one is untrusted input.

- Formats: WAV, MP3, OGG, FLAC, M4A, capped at 5 MB.
- A second file whose name is already taken gets a numbered suffix rather than
  replacing a sound somebody had already set up.
- Decoding happens once per file per session and is cached.
- A file that has been deleted plays nothing and its rows read "(missing)".

Removing one is under **Your sounds**, below the volume slider, rather than in
the dropdowns: a dropdown sets a value, while this deletes a file that up to
twelve rows may point at. Those rows are put back on `chime` before the file
goes, so no row is ever left naming something that is not there.

## Adding another shipped sample

There is one, and that is deliberate. Every sample is a binary in the tree, a
licence to keep track of and a decision made on everybody's behalf; the custom
picker above is how anybody gets the sound they actually want. `fafMatch` earns
its place by being the sound this event already has, for the people coming from
the other client.

If a second one is ever worth it: drop the file beside `match-found.mp3`, add a
variant to `NotificationSound`, add it to `SAMPLES` and to the `SOUNDS` record
in the settings section, and write the licence down in
`THIRD_PARTY_NOTICES.md`. The typechecker will name every place that needs it,
because both records are exhaustive over the type.
