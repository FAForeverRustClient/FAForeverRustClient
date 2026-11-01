//! What the client announces and how: a switch per kind, where a toast
//! appears, and the sound each kind plays, including the sounds a player added
//! and what becomes of the settings that name one when it is removed.

use super::*;

/// Which corner of the window a toast appears in.
///
/// Defaults to the corner the bell is in. The client drew its toasts top right
/// while the notification centre they belong to opens from the bottom left,
/// so the arrival and the place it is kept were at opposite ends of the
/// screen: a toast that slid away left nothing where the eye had learned to
/// look. The other three corners are here because the Java client offers the
/// choice and people are used to picking one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToastPosition {
    TopLeft,
    TopRight,
    #[default]
    BottomLeft,
    BottomRight,
}

/// Desktop delivery can use an independent client popup or the OS service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DesktopNotificationStyle {
    #[default]
    Popup,
    System,
}

/// Per-event delivery limits; absent entries inherit the global switches.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDelivery {
    pub sound: Option<bool>,
    pub popup: Option<bool>,
    pub desktop: Option<bool>,
}

preference_patch! {
    /// Only the delivery channels touched by one control.
    NotificationDeliveryPatch for NotificationDelivery {
        sound: Option<bool>, popup: Option<bool>, desktop: Option<bool>,
    }
}

/// Merge individual event/channel edits against the authoritative settings,
/// so quick edits do not replace one another with a stale renderer copy.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDeliveryPatches {
    #[serde(default)]
    #[specta(optional)]
    pub replace:
        Option<std::collections::BTreeMap<crate::state::NotificationKind, NotificationDelivery>>,
    pub events: std::collections::BTreeMap<
        crate::state::NotificationKind,
        Option<NotificationDeliveryPatch>,
    >,
}

impl NotificationDeliveryPatches {
    pub fn apply_to(
        self,
        mut base: std::collections::BTreeMap<crate::state::NotificationKind, NotificationDelivery>,
    ) -> std::collections::BTreeMap<crate::state::NotificationKind, NotificationDelivery> {
        if let Some(replace) = self.replace {
            base = replace;
        }
        for (kind, patch) in self.events {
            if let Some(patch) = patch {
                let prior = base.remove(&kind).unwrap_or_default();
                base.insert(kind, patch.apply_to(prior));
            } else {
                base.remove(&kind);
            }
        }
        base
    }
}

impl From<std::collections::BTreeMap<crate::state::NotificationKind, NotificationDelivery>>
    for NotificationDeliveryPatches
{
    fn from(
        base: std::collections::BTreeMap<crate::state::NotificationKind, NotificationDelivery>,
    ) -> Self {
        Self {
            replace: Some(base),
            events: Default::default(),
        }
    }
}

/// One of the tones the client ships with.
///
/// Synthesised rather than sampled: every one of these is a couple of sine
/// partials and an envelope, which is why "shipped with the client" costs no
/// files and no decoder. See `ui/src/features/notifications/notificationSound.ts`
/// for the plans themselves.
///
/// The set is deliberately small and ordered by how much attention it asks
/// for. [`Self::Silent`] is part of the set rather than a separate switch: the
/// request that started this was "visual notifications only for friend
/// connected, but a strong sound for game full", and a sound picker that can
/// say *nothing* answers the first half without a second control per row.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationSound {
    /// No tone. The notification still appears and still counts as unread.
    Silent,
    /// One quiet low note. For things worth knowing and not worth looking up
    /// for.
    Soft,
    /// The tone the client played for everything before this existed.
    #[default]
    Chime,
    /// Short and bright, for something addressed to you personally.
    Ping,
    /// Two rising notes. The loudest thing here, for something that expires.
    Alert,
    /// The sound the FAF Java client plays when it finds you a match.
    ///
    /// The one sample the client ships, and the only thing here that is not
    /// synthesised. It is included because "a match was found" is the
    /// notification people already know by ear from the other client, and no
    /// arrangement of sine partials is going to be that sound.
    ///
    /// Vendored from `FAForever/downlords-faf-client`, which carries it under
    /// the Pixabay licence: free for commercial use, modification allowed,
    /// attribution appreciated rather than required. See
    /// `THIRD_PARTY_NOTICES.md`.
    FafMatch,
    /// A file the player added, named by its stored file name.
    ///
    /// The name, not a path: the file lives in one directory the client owns
    /// (`sounds/` beside the settings), so a settings file stays portable
    /// between machines and a stored value cannot point anywhere else on disk.
    /// A name whose file has since been deleted plays nothing, which is the
    /// same as `Silent` and better than refusing to load the settings.
    ///
    /// This is the one variant with a payload, so serde writes the other five
    /// as the plain strings they have always been and only this one as
    /// `{"custom": "horn.wav"}`. Settings written by an older build load
    /// unchanged.
    Custom(String),
}

/// Which tone each kind of notification plays.
///
/// One field per switch in the notification settings, so the dropdown sits
/// next to the switch it belongs to and no mapping has to be explained in the
/// UI. Everything without a switch of its own (server notices, errors, a
/// finished map, a new client version) shares [`Self::other`].
///
/// **Two rows are not [`NotificationSound::Chime`]: a found match plays
/// [`NotificationSound::FafMatch`] and a filled lobby plays
/// [`NotificationSound::Alert`].** Everything else keeps the tone the client
/// played before this existed, so installing an update changes those two
/// sounds and not the rest.
///
/// That is a reversal. The original note here argued that shipping choices
/// nobody made was the wrong answer to "all notifications sound the same", and
/// left every row on `Chime`. What that missed is that the rows are not equal:
/// a found match expires. Miss it and the match is gone, while a missed friend
/// notice costs nothing, and telling the two apart is not a preference so much
/// as the point of having a sound at all. Nobody who had not already opened
/// this page could tell them apart, and the report that followed said exactly
/// that. A lobby filling up expires the same way -- the game launches without
/// whoever was looking elsewhere -- and was asked for by name. The remaining
/// ten rows are still one tone and still a preference.
///
/// [`NotificationSound::Silent`] is available on every row, which is how a kind
/// is seen and not heard.
///
/// A changed default here only reaches existing installs through
/// [`NotificationPreferences::sound_choice_version`]; bump that when changing
/// one, or the change is invisible to everybody who has ever saved settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSoundChoices {
    pub match_found: NotificationSound,
    pub private_message: NotificationSound,
    pub mention: NotificationSound,
    pub friend_online: NotificationSound,
    pub friend_offline: NotificationSound,
    pub friend_playing: NotificationSound,
    pub friend_joined_game: NotificationSound,
    pub new_custom_game: NotificationSound,
    pub game_full: NotificationSound,
    pub game_launched: NotificationSound,
    pub review_reminder: NotificationSound,
    pub party_invite: NotificationSound,
    /// Every kind without a switch of its own.
    pub other: NotificationSound,
}

/// Bump when a default in [`NotificationSoundChoices`] changes and the change
/// should reach people whose settings already name the old one.
const NOTIFICATION_SOUND_CHOICE_VERSION: u8 = 2;

impl Default for NotificationSoundChoices {
    fn default() -> Self {
        // One value, deliberately: see the note on the struct.
        Self {
            // The one graded default: see the note on the struct.
            match_found: NotificationSound::FafMatch,
            private_message: NotificationSound::Chime,
            mention: NotificationSound::Chime,
            friend_online: NotificationSound::Chime,
            friend_offline: NotificationSound::Chime,
            friend_playing: NotificationSound::Chime,
            friend_joined_game: NotificationSound::Chime,
            new_custom_game: NotificationSound::Chime,
            // The second graded default. A lobby that has just filled is about
            // to launch with or without the person looking at another screen,
            // so this is the other row where a tone that can be told apart is
            // the point rather than a preference. The request asked for a
            // strong sound, and `Alert` is the strongest thing here.
            game_full: NotificationSound::Alert,
            game_launched: NotificationSound::Chime,
            review_reminder: NotificationSound::Chime,
            party_invite: NotificationSound::Chime,
            other: NotificationSound::Chime,
        }
    }
}

// Deserialised through a `default`-ing twin for the same reason
// `NotificationPreferences` below is: a settings file written by an older
// build gains the new field's default rather than failing to load, and the
// generated TypeScript still sees a required field rather than an optional
// one. `#[serde(default)]` on the struct itself would achieve the first and
// lose the second, because specta renders a defaulted field as `field?:`.
impl<'de> Deserialize<'de> for NotificationSoundChoices {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields {
            match_found: Option<NotificationSound>,
            private_message: Option<NotificationSound>,
            mention: Option<NotificationSound>,
            friend_online: Option<NotificationSound>,
            friend_offline: Option<NotificationSound>,
            friend_playing: Option<NotificationSound>,
            friend_joined_game: Option<NotificationSound>,
            new_custom_game: Option<NotificationSound>,
            game_full: Option<NotificationSound>,
            game_launched: Option<NotificationSound>,
            review_reminder: Option<NotificationSound>,
            party_invite: Option<NotificationSound>,
            other: Option<NotificationSound>,
        }

        let fields = Fields::deserialize(deserializer)?;
        let defaults = Self::default();
        Ok(Self {
            match_found: fields.match_found.unwrap_or(defaults.match_found),
            private_message: fields.private_message.unwrap_or(defaults.private_message),
            mention: fields.mention.unwrap_or(defaults.mention),
            friend_online: fields.friend_online.unwrap_or(defaults.friend_online),
            friend_offline: fields.friend_offline.unwrap_or(defaults.friend_offline),
            friend_playing: fields.friend_playing.unwrap_or(defaults.friend_playing),
            friend_joined_game: fields
                .friend_joined_game
                .unwrap_or(defaults.friend_joined_game),
            new_custom_game: fields.new_custom_game.unwrap_or(defaults.new_custom_game),
            game_full: fields.game_full.unwrap_or(defaults.game_full),
            game_launched: fields.game_launched.unwrap_or(defaults.game_launched),
            review_reminder: fields.review_reminder.unwrap_or(defaults.review_reminder),
            party_invite: fields.party_invite.unwrap_or(defaults.party_invite),
            other: fields.other.unwrap_or(defaults.other),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub enabled: bool,
    pub desktop: bool,
    /// Whether [`Self::desktop`] covers every notification kind, or only the
    /// few that cannot wait.
    ///
    /// Off, which is the default and the fix for the client having mirrored its
    /// whole notification stream to the operating system: see
    /// [`super::NotificationKind::raises_os_notification`] for the list and the
    /// reasoning. On restores the old behaviour for anyone who wants it.
    pub desktop_all_kinds: bool,
    pub sound: bool,
    /// Whether a new notification pops up in the corner as a toast (#644).
    ///
    /// Together with [`Self::sound`] it is the one choice the settings offer
    /// as "sound and pop-up", "pop-up only" or "sound only": somebody who
    /// wants to hear that a friend started a game without a card sliding in,
    /// or the reverse. The history and the desktop notification are not
    /// affected.
    pub popup: bool,
    /// Seconds after which a notification leaves the history by itself
    /// (#644). Zero, the default, keeps every one until it is cleared.
    ///
    /// Asked for by a player who wanted friends joining games announced but
    /// not collected: sixty-seven of them in the bell, burying the event
    /// reminders, each to be removed by hand.
    pub history_lifetime_seconds: u32,
    /// Which tone each kind plays, when [`Self::sound`] is on.
    pub sounds: NotificationSoundChoices,
    /// Version of the stored [`Self::sounds`], so a changed default can reach
    /// the people who never made a choice.
    ///
    /// Every row is written on every save, so a settings file from an older
    /// build carries `chime` in all twelve whether or not anybody picked it. A
    /// new default is therefore invisible to everyone who has ever opened the
    /// client, which is everyone: giving a found match its own sound would
    /// have reached nobody, least of all the players the report came from.
    ///
    /// Same shape as [`ConnectivityPreferences::selection_version`], and the
    /// same reasoning: a value written by an old default is not evidence of a
    /// choice. Version zero is any file written before this field existed.
    ///
    /// It lives here rather than inside [`NotificationSoundChoices`] because
    /// that struct is twelve fields of one type and several places walk it as
    /// such; a `u8` among them would be a row that is not a sound.
    pub sound_choice_version: u8,
    pub notify_when_focused: bool,
    /// Which corner a toast appears in. See [`ToastPosition`].
    pub toast_position: ToastPosition,
    pub delivery: std::collections::BTreeMap<
        crate::state::notifications::NotificationKind,
        NotificationDelivery,
    >,
    pub mentions_require_at: bool,
    pub toast_duration_seconds: u16,
    pub desktop_monitor: Option<String>,
    pub desktop_position: ToastPosition,
    pub desktop_style: DesktopNotificationStyle,
    pub match_found: bool,
    pub private_messages: bool,
    pub mentions: bool,
    pub friend_online: bool,
    pub friend_offline: bool,
    pub friend_playing: bool,
    pub friend_joined_game: bool,
    pub new_custom_games: bool,
    pub new_custom_games_friends_only: bool,
    pub game_full: bool,
    pub game_launched: bool,
    pub review_reminder: bool,
    pub party_invites: bool,
    /// Whether FAF's own Twitch and YouTube channels going live is announced.
    ///
    /// On, because it is the client telling people about the game the client is
    /// for, and somebody who has never heard of the streams will not go looking
    /// for a switch to turn them on. Off is one click, in the same list as every
    /// other kind, which is what was asked for in the thread.
    pub stream_live: bool,
    /// Whether a finished generated map is announced.
    ///
    /// On by default, because generation is slow and a lobby join waits on it.
    /// Off silences only the success: a generator that failed still says so,
    /// because a join blocked on a map that never arrives needs explaining.
    pub map_generated: bool,
    /// The matchmaker queues (`ladder1v1`, `tmm2v2`, ...) in which a new
    /// opponent within the player's rating range is announced. Empty, the
    /// default, announces nothing.
    ///
    /// A list rather than a switch because the request was "for all queues, or
    /// one queue": somebody who only plays 1v1 does not want to hear about 4v4.
    /// It is only asked while the player is not searching that queue, since a
    /// search that finds the same opponent says so itself.
    pub queue_opponent_queues: Vec<String>,
    /// Sound volume from 0 to 100.
    pub volume: u8,
    /// Seconds after one notification of a kind before another of the same
    /// kind toasts, sounds or reaches the desktop again (#382). Zero announces
    /// every one. The later ones still land in the notification history.
    pub repeat_cooldown_seconds: u16,
    /// The matchmaker queues whose new map pools are not announced (#406).
    ///
    /// The ones switched off rather than the ones switched on, so every queue
    /// is announced by default, a queue added later included, which is what
    /// the request asked for: a new pool is a reason to queue again.
    pub map_pool_muted_queues: Vec<String>,
}

/// The longest repeat cooldown a settings file may ask for: ten minutes.
pub const MAX_NOTIFICATION_REPEAT_COOLDOWN_SECONDS: u16 = 600;

/// The longest history lifetime a settings file may ask for: one day.
pub const MAX_NOTIFICATION_HISTORY_LIFETIME_SECONDS: u32 = 86_400;

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            desktop: true,
            desktop_all_kinds: false,
            sound: true,
            popup: true,
            history_lifetime_seconds: 0,
            sounds: NotificationSoundChoices::default(),
            sound_choice_version: NOTIFICATION_SOUND_CHOICE_VERSION,
            notify_when_focused: false,
            toast_position: ToastPosition::BottomLeft,
            delivery: Default::default(),
            mentions_require_at: false,
            toast_duration_seconds: 5,
            desktop_monitor: None,
            desktop_position: ToastPosition::BottomRight,
            desktop_style: DesktopNotificationStyle::Popup,
            match_found: true,
            private_messages: true,
            mentions: true,
            friend_online: true,
            friend_offline: true,
            friend_playing: true,
            friend_joined_game: true,
            new_custom_games: false,
            new_custom_games_friends_only: true,
            game_full: true,
            game_launched: true,
            review_reminder: true,
            party_invites: true,
            stream_live: true,
            map_generated: true,
            queue_opponent_queues: Vec::new(),
            volume: 70,
            // What the request asked for: a ping every two seconds at most.
            repeat_cooldown_seconds: 2,
            map_pool_muted_queues: Vec::new(),
        }
    }
}

// Notification preferences are persisted as one complete object. Keep new
// event switches backwards-compatible without making the generated IPC type
// optional: older files gain only the newly introduced defaults.
impl<'de> Deserialize<'de> for NotificationPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            enabled: bool,
            desktop: bool,
            desktop_all_kinds: bool,
            sound: bool,
            popup: bool,
            history_lifetime_seconds: u32,
            sounds: NotificationSoundChoices,
            sound_choice_version: u8,
            notify_when_focused: bool,
            toast_position: ToastPosition,
            delivery: std::collections::BTreeMap<
                crate::state::notifications::NotificationKind,
                NotificationDelivery,
            >,
            mentions_require_at: bool,
            toast_duration_seconds: u16,
            desktop_monitor: Option<String>,
            desktop_position: ToastPosition,
            desktop_style: DesktopNotificationStyle,
            match_found: bool,
            private_messages: bool,
            mentions: bool,
            friend_online: bool,
            friend_offline: bool,
            friend_playing: bool,
            friend_joined_game: bool,
            new_custom_games: bool,
            new_custom_games_friends_only: bool,
            game_full: bool,
            game_launched: bool,
            review_reminder: bool,
            party_invites: bool,
            stream_live: bool,
            map_generated: bool,
            queue_opponent_queues: Vec<String>,
            volume: u8,
            repeat_cooldown_seconds: u16,
            map_pool_muted_queues: Vec<String>,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = NotificationPreferences::default();
                Self {
                    enabled: defaults.enabled,
                    desktop: defaults.desktop,
                    desktop_all_kinds: defaults.desktop_all_kinds,
                    sound: defaults.sound,
                    popup: defaults.popup,
                    history_lifetime_seconds: defaults.history_lifetime_seconds,
                    sounds: defaults.sounds,
                    // Zero, not the current version: this is what a file that
                    // does not mention the field reads as, and that is exactly
                    // the file the migration below is for.
                    sound_choice_version: 0,
                    notify_when_focused: defaults.notify_when_focused,
                    toast_position: defaults.toast_position,
                    delivery: defaults.delivery,
                    mentions_require_at: defaults.mentions_require_at,
                    toast_duration_seconds: defaults.toast_duration_seconds,
                    desktop_monitor: defaults.desktop_monitor,
                    desktop_position: defaults.desktop_position,
                    desktop_style: defaults.desktop_style,
                    match_found: defaults.match_found,
                    private_messages: defaults.private_messages,
                    mentions: defaults.mentions,
                    friend_online: defaults.friend_online,
                    friend_offline: defaults.friend_offline,
                    friend_playing: defaults.friend_playing,
                    friend_joined_game: defaults.friend_joined_game,
                    new_custom_games: defaults.new_custom_games,
                    new_custom_games_friends_only: defaults.new_custom_games_friends_only,
                    game_full: defaults.game_full,
                    game_launched: defaults.game_launched,
                    review_reminder: defaults.review_reminder,
                    party_invites: defaults.party_invites,
                    stream_live: defaults.stream_live,
                    map_generated: defaults.map_generated,
                    queue_opponent_queues: defaults.queue_opponent_queues,
                    volume: defaults.volume,
                    repeat_cooldown_seconds: defaults.repeat_cooldown_seconds,
                    map_pool_muted_queues: defaults.map_pool_muted_queues,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        // A file written before a version bump has `chime` in the row that
        // bump changed, put there by the old default rather than by anybody.
        // Move that row onto the new default; anything else is a choice
        // somebody made, including a deliberate silence, and is left alone.
        // One clause per version, because somebody who saved settings between
        // the two has to be caught by the second and not the first.
        let mut sounds = wire.sounds;
        let graded = NotificationSoundChoices::default();
        if wire.sound_choice_version < 1 && sounds.match_found == NotificationSound::Chime {
            sounds.match_found = graded.match_found;
        }
        if wire.sound_choice_version < 2 && sounds.game_full == NotificationSound::Chime {
            sounds.game_full = graded.game_full;
        }
        Ok(Self {
            enabled: wire.enabled,
            desktop: wire.desktop,
            desktop_all_kinds: wire.desktop_all_kinds,
            sound: wire.sound,
            popup: wire.popup,
            history_lifetime_seconds: wire.history_lifetime_seconds,
            sounds,
            sound_choice_version: NOTIFICATION_SOUND_CHOICE_VERSION,
            notify_when_focused: wire.notify_when_focused,
            toast_position: wire.toast_position,
            delivery: wire.delivery,
            mentions_require_at: wire.mentions_require_at,
            toast_duration_seconds: wire.toast_duration_seconds,
            desktop_monitor: wire.desktop_monitor,
            desktop_position: wire.desktop_position,
            desktop_style: wire.desktop_style,
            match_found: wire.match_found,
            private_messages: wire.private_messages,
            mentions: wire.mentions,
            friend_online: wire.friend_online,
            friend_offline: wire.friend_offline,
            friend_playing: wire.friend_playing,
            friend_joined_game: wire.friend_joined_game,
            new_custom_games: wire.new_custom_games,
            new_custom_games_friends_only: wire.new_custom_games_friends_only,
            game_full: wire.game_full,
            game_launched: wire.game_launched,
            review_reminder: wire.review_reminder,
            party_invites: wire.party_invites,
            stream_live: wire.stream_live,
            map_generated: wire.map_generated,
            queue_opponent_queues: wire.queue_opponent_queues,
            volume: wire.volume,
            repeat_cooldown_seconds: wire.repeat_cooldown_seconds,
            map_pool_muted_queues: wire.map_pool_muted_queues,
        })
    }
}

impl NotificationPreferences {
    pub(super) fn normalized(mut self) -> Self {
        self.volume = self.volume.min(100);
        self.toast_duration_seconds = self.toast_duration_seconds.clamp(2, 60);
        self.desktop_monitor = self
            .desktop_monitor
            .filter(|name| !name.is_empty() && name.len() <= 256);
        self.repeat_cooldown_seconds = self
            .repeat_cooldown_seconds
            .min(MAX_NOTIFICATION_REPEAT_COOLDOWN_SECONDS);
        self.history_lifetime_seconds = self
            .history_lifetime_seconds
            .min(MAX_NOTIFICATION_HISTORY_LIFETIME_SECONDS);
        self
    }
}

preference_patch! {
    /// A change to some of the per-kind tones in [`NotificationSoundChoices`].
    NotificationSoundChoicesPatch for NotificationSoundChoices {
        match_found: NotificationSound,
        private_message: NotificationSound,
        mention: NotificationSound,
        friend_online: NotificationSound,
        friend_offline: NotificationSound,
        friend_playing: NotificationSound,
        friend_joined_game: NotificationSound,
        new_custom_game: NotificationSound,
        game_full: NotificationSound,
        game_launched: NotificationSound,
        review_reminder: NotificationSound,
        party_invite: NotificationSound,
        other: NotificationSound,
    }
}

preference_patch! {
    /// A change to [`NotificationPreferences`].
    NotificationPreferencesPatch for NotificationPreferences {
        enabled: bool,
        desktop: bool,
        desktop_all_kinds: bool,
        sound: bool,
        popup: bool,
        history_lifetime_seconds: u32,
        sound_choice_version: u8,
        notify_when_focused: bool,
        toast_position: ToastPosition,
        desktop_style: DesktopNotificationStyle,
        desktop_position: ToastPosition,
        desktop_monitor: Option<String>,
        toast_duration_seconds: u16,
        mentions_require_at: bool,
        match_found: bool,
        private_messages: bool,
        mentions: bool,
        friend_online: bool,
        friend_offline: bool,
        friend_playing: bool,
        friend_joined_game: bool,
        new_custom_games: bool,
        new_custom_games_friends_only: bool,
        game_full: bool,
        game_launched: bool,
        review_reminder: bool,
        party_invites: bool,
        stream_live: bool,
        map_generated: bool,
        queue_opponent_queues: Vec<String>,
        volume: u8,
        repeat_cooldown_seconds: u16,
        map_pool_muted_queues: Vec<String>,
    }
    nested {
        sounds: NotificationSoundChoicesPatch,
        delivery: NotificationDeliveryPatches,
    }
}

/// Point every notification tone that plays a removed sound back at a shipped
/// one. `None` when nothing named it, so a removal that touches no setting
/// does not write the settings file for nothing.
///
/// The shipped default rather than silence: a row that was set to play
/// something keeps playing something.
pub fn without_custom_sound(
    sounds: &NotificationSoundChoices,
    name: &str,
) -> Option<NotificationSoundChoices> {
    let mut next = sounds.clone();
    let mut changed = false;
    for sound in [
        &mut next.match_found,
        &mut next.private_message,
        &mut next.mention,
        &mut next.friend_online,
        &mut next.friend_offline,
        &mut next.friend_playing,
        &mut next.friend_joined_game,
        &mut next.new_custom_game,
        &mut next.game_full,
        &mut next.game_launched,
        &mut next.review_reminder,
        &mut next.party_invite,
        &mut next.other,
    ] {
        if matches!(sound, NotificationSound::Custom(stored) if stored == name) {
            *sound = NotificationSound::Chime;
            changed = true;
        }
    }
    changed.then_some(next)
}

/// Put back every slot that `next` newly points at a refused added sound.
///
/// "Newly" is the point: a slot that already named the sound before this
/// change is left as it was, so changing one row never rewrites another that
/// happens to name a file that has since gone. Returns whether anything was
/// put back. The settings service refuses a sound that is being removed or
/// whose file no longer exists, so a dropdown that still listed it cannot
/// leave a saved setting naming a deleted file.
pub fn refuse_new_custom_sounds(
    previous: &NotificationSoundChoices,
    next: &mut NotificationSoundChoices,
    refused: impl Fn(&str) -> bool,
) -> bool {
    let mut put_back = false;
    for (before, after) in [
        (&previous.match_found, &mut next.match_found),
        (&previous.private_message, &mut next.private_message),
        (&previous.mention, &mut next.mention),
        (&previous.friend_online, &mut next.friend_online),
        (&previous.friend_offline, &mut next.friend_offline),
        (&previous.friend_playing, &mut next.friend_playing),
        (&previous.new_custom_game, &mut next.new_custom_game),
        (&previous.game_full, &mut next.game_full),
        (&previous.game_launched, &mut next.game_launched),
        (&previous.review_reminder, &mut next.review_reminder),
        (&previous.party_invite, &mut next.party_invite),
        (&previous.other, &mut next.other),
    ] {
        if after != before {
            if let NotificationSound::Custom(name) = &*after {
                if refused(name) {
                    *after = before.clone();
                    put_back = true;
                }
            }
        }
    }
    put_back
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_from_before_644_pops_up_and_keeps_its_history() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"notifications":{"sound":false}}"#).unwrap();
        assert!(settings.notifications.popup);
        assert!(!settings.notifications.sound);
        assert_eq!(settings.notifications.history_lifetime_seconds, 0);
    }

    #[test]
    fn a_history_lifetime_is_held_to_one_day() {
        let preferences = NotificationPreferences {
            history_lifetime_seconds: u32::MAX,
            ..NotificationPreferences::default()
        }
        .normalized();
        assert_eq!(
            preferences.history_lifetime_seconds,
            MAX_NOTIFICATION_HISTORY_LIFETIME_SECONDS
        );
    }

    #[test]
    fn a_chime_written_by_the_old_default_moves_to_the_faf_match_sound() {
        // Every settings file written before this existed says `chime` in all
        // twelve rows, because every save writes every field. Without the
        // version that made the new default unreachable for everybody who had
        // ever opened the client.
        let settings: SettingsState =
            serde_json::from_str(r#"{"notifications":{"sounds":{"matchFound":"chime"}}}"#).unwrap();

        assert_eq!(
            settings.notifications.sounds.match_found,
            NotificationSound::FafMatch
        );
        assert_eq!(
            settings.notifications.sound_choice_version,
            NOTIFICATION_SOUND_CHOICE_VERSION
        );
    }

    #[test]
    fn a_chime_chosen_since_the_migration_is_left_alone() {
        let settings: SettingsState = serde_json::from_str(
            r#"{"notifications":{"soundChoiceVersion":1,"sounds":{"matchFound":"chime"}}}"#,
        )
        .unwrap();

        assert_eq!(
            settings.notifications.sounds.match_found,
            NotificationSound::Chime
        );
    }

    #[test]
    fn the_migration_only_touches_the_row_the_old_default_wrote() {
        // Anything that is not `chime` is a choice somebody made, including a
        // deliberate silence, and the migration must not overwrite it.
        for stored in ["silent", "soft", "ping", "alert"] {
            let json = format!(r#"{{"notifications":{{"sounds":{{"matchFound":"{stored}"}}}}}}"#);
            let settings: SettingsState = serde_json::from_str(&json).unwrap();
            assert_ne!(
                settings.notifications.sounds.match_found,
                NotificationSound::FafMatch,
                "{stored} should have been left alone"
            );
        }

        // And it leaves the other ten rows on chime.
        let settings: SettingsState =
            serde_json::from_str(r#"{"notifications":{"sounds":{"matchFound":"chime"}}}"#).unwrap();
        assert_eq!(
            settings.notifications.sounds.mention,
            NotificationSound::Chime
        );
        assert_eq!(
            settings.notifications.sounds.friend_online,
            NotificationSound::Chime
        );
    }

    #[test]
    fn a_chime_written_by_the_old_default_moves_to_the_full_lobby_alert() {
        // Version 1 is a file saved after the match sound landed and before
        // the full-lobby one did: its `gameFull` row is the old default and
        // nobody's choice, so it moves, and a row somebody did choose does
        // not.
        let settings: SettingsState = serde_json::from_str(
            r#"{"notifications":{"soundChoiceVersion":1,"sounds":{"gameFull":"chime"}}}"#,
        )
        .unwrap();
        assert_eq!(
            settings.notifications.sounds.game_full,
            NotificationSound::Alert
        );

        let settings: SettingsState = serde_json::from_str(
            r#"{"notifications":{"soundChoiceVersion":2,"sounds":{"gameFull":"chime"}}}"#,
        )
        .unwrap();
        assert_eq!(
            settings.notifications.sounds.game_full,
            NotificationSound::Chime
        );
    }

    #[test]
    fn a_custom_file_chosen_for_a_match_survives_the_migration() {
        let settings: SettingsState = serde_json::from_str(
            r#"{"notifications":{"sounds":{"matchFound":{"custom":"horn.wav"}}}}"#,
        )
        .unwrap();

        assert_eq!(
            settings.notifications.sounds.match_found,
            NotificationSound::Custom("horn.wav".into())
        );
    }

    #[test]
    fn existing_notification_preferences_gain_new_event_defaults() {
        let settings: SettingsState = serde_json::from_str(
            r#"{
                "notifications": {
                    "enabled": true,
                    "desktop": false,
                    "sound": false,
                    "notifyWhenFocused": true,
                    "matchFound": false,
                    "privateMessages": true,
                    "mentions": false,
                    "friendOnline": false,
                    "partyInvites": false,
                    "volume": 22
                }
            }"#,
        )
        .unwrap();

        assert!(!settings.notifications.desktop);
        assert!(!settings.notifications.match_found);
        assert_eq!(settings.notifications.volume, 22);
        assert!(settings.notifications.friend_offline);
        assert!(settings.notifications.friend_playing);
        assert!(!settings.notifications.new_custom_games);
        assert!(settings.notifications.new_custom_games_friends_only);
        assert!(settings.notifications.game_full);
        assert!(settings.notifications.game_launched);
        assert!(settings.notifications.review_reminder);
    }

    #[test]
    fn removing_a_custom_sound_repoints_only_the_rows_that_played_it() {
        let sounds = NotificationSoundChoices {
            mention: NotificationSound::Custom("horn.wav".into()),
            other: NotificationSound::Custom("horn.wav".into()),
            game_full: NotificationSound::Custom("bell.wav".into()),
            ..NotificationSoundChoices::default()
        };
        let next = without_custom_sound(&sounds, "horn.wav").expect("two rows named it");
        assert_eq!(next.mention, NotificationSound::Chime);
        assert_eq!(next.other, NotificationSound::Chime);
        assert_eq!(next.game_full, NotificationSound::Custom("bell.wav".into()));
        assert_eq!(next.match_found, sounds.match_found);

        // Nothing named it: nothing to write.
        assert_eq!(without_custom_sound(&sounds, "absent.wav"), None);
    }

    #[test]
    fn a_refused_sound_is_put_back_only_where_this_change_chose_it() {
        let previous = NotificationSoundChoices {
            // Already named before the change: left alone even though refused.
            other: NotificationSound::Custom("gone.wav".into()),
            ..NotificationSoundChoices::default()
        };
        let mut next = NotificationSoundChoices {
            mention: NotificationSound::Custom("gone.wav".into()),
            game_full: NotificationSound::Custom("bell.wav".into()),
            ..previous.clone()
        };
        let refused = |name: &str| name == "gone.wav";

        assert!(refuse_new_custom_sounds(&previous, &mut next, refused));
        assert_eq!(
            next.mention, previous.mention,
            "the new choice was put back"
        );
        assert_eq!(next.game_full, NotificationSound::Custom("bell.wav".into()));
        assert_eq!(next.other, NotificationSound::Custom("gone.wav".into()));

        let mut unchanged = previous.clone();
        assert!(!refuse_new_custom_sounds(
            &previous,
            &mut unchanged,
            refused
        ));
    }
}

#[cfg(test)]
mod desktop_tests {
    use super::*;
    #[test]
    fn old_preferences_gain_popup_defaults_without_changing_saved_delivery() {
        let stored = serde_json::json!({"desktop": false, "popup": false, "sound": false,
            "toastPosition": "topLeft", "sounds": {"privateMessage": "silent"}});
        let preferences: NotificationPreferences = serde_json::from_value(stored).unwrap();
        assert!(!preferences.desktop && !preferences.popup && !preferences.sound);
        assert_eq!(preferences.toast_position, ToastPosition::TopLeft);
        assert_eq!(preferences.desktop_position, ToastPosition::BottomRight);
        assert_eq!(preferences.desktop_style, DesktopNotificationStyle::Popup);
        assert_eq!(preferences.toast_duration_seconds, 5);
        assert!(preferences.delivery.is_empty());
        assert_eq!(
            preferences.sounds.private_message,
            NotificationSound::Silent
        );
    }
    #[test]
    fn delivery_edits_merge_per_channel_and_reset_to_inherited_values() {
        let first: NotificationPreferencesPatch = serde_json::from_value(
            serde_json::json!({"delivery": {"events": {"friendOnline": {"sound": false}}}}),
        )
        .unwrap();
        let second: NotificationPreferencesPatch = serde_json::from_value(
            serde_json::json!({"delivery": {"events": {"friendOnline": {"popup": false}}}}),
        )
        .unwrap();
        let preferences = second.apply_to(first.apply_to(NotificationPreferences::default()));
        let delivery = &preferences.delivery[&crate::state::NotificationKind::FriendOnline];
        assert_eq!(delivery.sound, Some(false));
        assert_eq!(delivery.popup, Some(false));
        assert_eq!(delivery.desktop, None);
        let reset: NotificationPreferencesPatch = serde_json::from_value(
            serde_json::json!({"delivery": {"events": {"friendOnline": null}}}),
        )
        .unwrap();
        assert!(reset.apply_to(preferences).delivery.is_empty());
    }

    #[test]
    fn desktop_duration_is_bounded_and_monitor_can_be_cleared() {
        let preferences = NotificationPreferences {
            toast_duration_seconds: 0,
            desktop_monitor: Some("display".into()),
            ..Default::default()
        }
        .normalized();
        assert_eq!(preferences.toast_duration_seconds, 2);
        let patch: NotificationPreferencesPatch = serde_json::from_value(
            serde_json::json!({"desktopMonitor": null, "toastDurationSeconds": 65535}),
        )
        .unwrap();
        let preferences = patch.apply_to(preferences).normalized();
        assert!(preferences.desktop_monitor.is_none());
        assert_eq!(preferences.toast_duration_seconds, 60);
    }
}
