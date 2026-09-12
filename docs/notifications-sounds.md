# Notification sounds

## What ships

Five tones, synthesised rather than sampled: each is a few sine partials and an
envelope, built in `ui/src/features/notifications/notificationSound.ts`. That is
why "packaged sounds" costs no audio files, no decoder and no licence question.

Each of the twelve notification kinds picks one, in Settings, Notifications.
Eleven default to `chime`, the tone the client played for everything before the
picker existed. **A found match defaults to `alert`**, because it is the one
notification that expires: miss it and the match is gone.

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

## The Java client's match sound

Not shipped. The request asked for the Java client's own match-found sample as
the default, and that is an audio asset from another repository with its own
licence: it is not something this repository can vendor on its own account.
Anybody who wants exactly that sound can add the file through the picker above,
and the distinct `alert` default means the tone is at least not the same one a
friend coming online plays.
