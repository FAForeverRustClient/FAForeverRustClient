//! Chat service tests: drive the streaming port end-to-end against the fake.
//!
//! The unit tests in `faf-domain` cover the reducer and the input grammar in
//! isolation; these cover the wiring between them, which is where a
//! multi-channel client can plausibly go wrong: does a slash command reach the
//! right port method, and does the resulting update land in the right channel?

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::SettingsPort;
use faf_app::{App, Ports};
use faf_domain::state::{
    ChatCommand, ChatMessageKind, ChatStatus, LobbyCommand, SettingsCommand, SettingsState,
    DEFAULT_CHANNEL,
};
use faf_domain::AppState;

#[derive(Default)]
struct RecordingSettings {
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> SettingsState {
        SettingsState::default()
    }

    async fn save(&self, settings: &SettingsState) {
        self.saved.lock().unwrap().push(settings.clone());
    }
}

/// Poll the snapshot until `predicate` holds, so a test never depends on how
/// many events a command happens to produce.
async fn until(app: &App, predicate: impl Fn(&AppState) -> bool) -> AppState {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = app.snapshot();
        if predicate(&snapshot) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out; last snapshot: {:?}",
            snapshot.chat
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn connected() -> App {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    app.dispatch(
        ChatCommand::Connect {
            username: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |s| s.chat.status == ChatStatus::Connected).await;
    app
}

#[tokio::test]
async fn connect_joins_the_default_channel_with_a_roster_and_history() {
    let app = connected().await;
    let state = until(&app, |s| {
        s.chat
            .channel(DEFAULT_CHANNEL)
            .is_some_and(|c| !c.messages.is_empty() && !c.users.is_empty())
    })
    .await;

    assert_eq!(state.chat.username, "Aurora");
    assert_eq!(state.chat.active_channel, DEFAULT_CHANNEL);
    let channel = state.chat.channel(DEFAULT_CHANNEL).unwrap();
    assert!(
        !channel.topic.is_empty(),
        "topic should be published on join"
    );
    assert!(channel.users.iter().any(|u| u.name == "Aurora"));
    assert!(channel.users.iter().any(|u| u.is_moderator()));
    // The active channel accrues no unread badge.
    assert_eq!(channel.unread, 0);
}

#[tokio::test]
async fn a_plain_line_is_echoed_into_its_channel() {
    let app = connected().await;
    app.dispatch(
        ChatCommand::SendMessage {
            channel: DEFAULT_CHANNEL.into(),
            content: "hello everyone".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = until(&app, |s| {
        s.chat
            .channel(DEFAULT_CHANNEL)
            .is_some_and(|c| c.messages.iter().any(|m| m.content == "hello everyone"))
    })
    .await;
    let echo = state
        .chat
        .channel(DEFAULT_CHANNEL)
        .unwrap()
        .messages
        .iter()
        .find(|m| m.content == "hello everyone")
        .unwrap();
    assert_eq!(echo.sender, "Aurora");
    assert_eq!(echo.kind, ChatMessageKind::Message);
}

#[tokio::test]
async fn me_becomes_an_action_line() {
    let app = connected().await;
    app.dispatch(
        ChatCommand::SendMessage {
            channel: DEFAULT_CHANNEL.into(),
            content: "/me waves".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = until(&app, |s| {
        s.chat
            .channel(DEFAULT_CHANNEL)
            .is_some_and(|c| c.messages.iter().any(|m| m.kind == ChatMessageKind::Action))
    })
    .await;
    let action = state
        .chat
        .channel(DEFAULT_CHANNEL)
        .unwrap()
        .messages
        .iter()
        .find(|m| m.kind == ChatMessageKind::Action)
        .unwrap();
    assert_eq!(action.content, "waves");
}

#[tokio::test]
async fn join_opens_a_second_channel_without_stealing_focus() {
    let app = connected().await;
    app.dispatch(
        ChatCommand::SendMessage {
            channel: DEFAULT_CHANNEL.into(),
            content: "/join newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = until(&app, |s| s.chat.channel("#newbie").is_some()).await;
    // `/join newbie` must be normalised to `#newbie`, and reading position
    // stays where the user left it.
    assert_eq!(state.chat.active_channel, DEFAULT_CHANNEL);
    assert_eq!(state.chat.channels.len(), 2);
}

#[tokio::test]
async fn msg_opens_a_private_conversation_and_sends_into_it() {
    let app = connected().await;
    app.dispatch(
        ChatCommand::SendMessage {
            channel: DEFAULT_CHANNEL.into(),
            content: "/msg Stormlord good game".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = until(&app, |s| {
        s.chat
            .channel("Stormlord")
            .is_some_and(|c| !c.messages.is_empty())
    })
    .await;
    let conversation = state.chat.channel("Stormlord").unwrap();
    assert!(conversation.is_private());
    assert_eq!(conversation.messages[0].content, "good game");
    // Our own line never marks the conversation unread.
    assert_eq!(conversation.unread, 0);
}

#[tokio::test]
async fn an_unknown_command_reports_locally_instead_of_being_sent() {
    let app = connected().await;
    app.dispatch(
        ChatCommand::SendMessage {
            channel: DEFAULT_CHANNEL.into(),
            content: "/kick Stormlord".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = until(&app, |s| {
        s.chat
            .channel(DEFAULT_CHANNEL)
            .is_some_and(|c| c.messages.iter().any(|m| m.kind == ChatMessageKind::Error))
    })
    .await;
    let messages = &state.chat.channel(DEFAULT_CHANNEL).unwrap().messages;
    assert!(
        !messages
            .iter()
            .any(|m| m.content.contains("/kick Stormlord")),
        "the raw command must not be sent to the channel"
    );
    assert!(messages
        .iter()
        .any(|m| m.kind == ChatMessageKind::Error && m.content.contains("/kick")));
}

#[tokio::test]
async fn selecting_a_channel_moves_the_reading_position() {
    // (That selecting also clears the unread counters is covered by the
    // reducer's own tests, which can synthesise foreign traffic; the fake only
    // ever echoes our own lines, which never count as unread.)
    let app = connected().await;
    app.dispatch(
        ChatCommand::JoinChannel {
            channel: "#newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |s| s.chat.channel("#newbie").is_some()).await;
    assert_eq!(app.snapshot().chat.active_channel, DEFAULT_CHANNEL);

    app.dispatch(
        ChatCommand::SelectChannel {
            channel: "#newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |s| s.chat.active_channel == "#newbie").await;
}

#[tokio::test]
async fn rapid_channel_selection_batches_read_marker_persistence() {
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(RecordingSettings {
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app.dispatch(
        ChatCommand::Connect {
            username: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |state| state.chat.status == ChatStatus::Connected).await;
    app.dispatch(
        ChatCommand::JoinChannel {
            channel: "#newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    app.dispatch(
        ChatCommand::SendMessage {
            channel: "#newbie".into(),
            content: "hello newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |state| {
        state
            .chat
            .channel("#newbie")
            .is_some_and(|channel| !channel.messages.is_empty())
    })
    .await;

    for channel in ["#newbie", DEFAULT_CHANNEL, "#newbie"] {
        app.dispatch(
            ChatCommand::SelectChannel {
                channel: channel.into(),
            }
            .into(),
        )
        .await
        .unwrap();
        until(&app, |state| state.chat.active_channel == channel).await;
    }

    tokio::time::sleep(Duration::from_millis(550)).await;
    let saved = saved.lock().unwrap();
    assert_eq!(
        saved.len(),
        1,
        "the selection burst should produce one write"
    );
    assert_eq!(saved[0].chat.read_markers.len(), 2);
}

#[tokio::test]
async fn leaving_a_channel_closes_it_and_falls_back() {
    let app = connected().await;
    app.dispatch(
        ChatCommand::JoinChannel {
            channel: "#newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |s| s.chat.channel("#newbie").is_some()).await;

    app.dispatch(
        ChatCommand::SelectChannel {
            channel: "#newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |s| s.chat.active_channel == "#newbie").await;

    app.dispatch(
        ChatCommand::LeaveChannel {
            channel: "#newbie".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = until(&app, |s| s.chat.channel("#newbie").is_none()).await;
    assert_eq!(state.chat.active_channel, DEFAULT_CHANNEL);
}

#[tokio::test]
async fn the_joins_parts_preference_round_trips_through_the_loop() {
    let app = connected().await;
    app.dispatch(ChatCommand::SetShowJoinsParts { enabled: true }.into())
        .await
        .unwrap();
    until(&app, |s| s.chat.show_joins_parts).await;
}

#[tokio::test]
async fn disconnect_clears_rosters_but_keeps_the_scrollback() {
    let app = connected().await;
    until(&app, |s| {
        s.chat
            .channel(DEFAULT_CHANNEL)
            .is_some_and(|c| !c.messages.is_empty())
    })
    .await;

    app.dispatch(ChatCommand::Disconnect.into()).await.unwrap();

    let state = until(&app, |s| s.chat.status == ChatStatus::Disconnected).await;
    let channel = state.chat.channel(DEFAULT_CHANNEL).unwrap();
    assert!(channel.users.is_empty(), "roster goes stale on disconnect");
    assert!(!channel.messages.is_empty(), "scrollback survives");
}

/// The lobby announces the account's channels before chat is up.
///
/// This is the usual ordering: the lobby socket connects at login, chat some
/// time after. The announcement has to survive the gap, which is why the list
/// lives in state instead of being acted on where it arrives.
#[tokio::test]
async fn channels_announced_by_the_lobby_are_joined_when_chat_connects() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    until(&app, |state| !state.chat.server_auto_join.is_empty()).await;
    // The lobby sends bare names; the domain adds the prefix.
    assert_eq!(
        app.snapshot().chat.server_auto_join,
        vec!["#aeolus", "#clan_bc"]
    );

    app.dispatch(
        ChatCommand::Connect {
            username: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |state| state.chat.channel("#clan_bc").is_some()).await;
}

/// The reverse ordering: chat is already connected when the announcement lands,
/// so nothing later will re-read the list and it has to be acted on at once.
#[tokio::test]
async fn channels_announced_while_chat_is_connected_are_joined_immediately() {
    let app = connected().await;

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    until(&app, |state| state.chat.channel("#clan_bc").is_some()).await;
}

/// The reported bug: the language channel is derived from the account's country
/// flag, and that country arrives on the lobby socket *after* chat has already
/// connected. Nothing re-ran the derivation, so the channel was never joined.
///
/// The fake profile for "Aurora" carries country `fr`, so the expected channel
/// is `#french`.
#[tokio::test]
async fn the_language_channel_is_joined_once_our_country_is_known() {
    let app = connected().await;
    assert!(
        app.snapshot().chat.channel("#french").is_none(),
        "nothing knows our country yet"
    );

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    until(&app, |state| state.chat.channel("#french").is_some()).await;
}

#[tokio::test]
async fn the_language_channel_is_not_joined_when_the_preference_is_off() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut preferences = app.snapshot().settings.chat;
    preferences.auto_join_language_channel = false;
    app.dispatch(SettingsCommand::SetChat { preferences }.into())
        .await
        .unwrap();
    until(&app, |state| {
        !state.settings.chat.auto_join_language_channel
    })
    .await;

    app.dispatch(
        ChatCommand::Connect {
            username: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    // The server's list still lands, which is what makes this a real assertion
    // rather than a race the test wins by being fast.
    until(&app, |state| state.chat.channel("#clan_bc").is_some()).await;
    assert!(app.snapshot().chat.channel("#french").is_none());
}

#[tokio::test]
async fn muted_players_are_filtered_before_messages_enter_state() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut preferences = app.snapshot().settings.chat;
    preferences.muted_players.push("stormlord".into());
    app.dispatch(SettingsCommand::SetChat { preferences }.into())
        .await
        .unwrap();
    until(&app, |state| !state.settings.chat.muted_players.is_empty()).await;

    app.dispatch(
        ChatCommand::Connect {
            username: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    let state = until(&app, |state| {
        state.chat.channel(DEFAULT_CHANNEL).is_some_and(|channel| {
            channel
                .messages
                .iter()
                .any(|message| message.sender == "Aurora")
        })
    })
    .await;
    let messages = &state.chat.channel(DEFAULT_CHANNEL).unwrap().messages;
    assert!(messages
        .iter()
        .all(|message| !message.sender.eq_ignore_ascii_case("Stormlord")));
}
