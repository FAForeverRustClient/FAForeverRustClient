use super::*;

pub(super) fn decide(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    let mut effects = Vec::new();
    match line.command.as_str() {
        // RPL_NAMREPLY: the trailing param is a space-separated nick list.
        "353" => {
            let (Some(channel), Some(names)) = (line.params.get(2), line.params.last()) else {
                return effects;
            };
            let pending = state.pending_names.entry(channel.clone()).or_default();
            for entry in names.split_whitespace() {
                pending.insert(
                    irc::strip_nick_prefix(entry).to_string(),
                    irc::nick_prefix(entry).to_string(),
                );
            }
        }
        // RPL_ENDOFNAMES
        "366" => {
            let Some(channel) = line.params.get(1) else {
                return effects;
            };
            let roster = state.pending_names.remove(channel).unwrap_or_default();
            state.rosters.insert(channel.clone(), roster);
            effects.push(Effect::Emit(ChatUpdate::Users {
                channel: channel.clone(),
                users: state.visible_users(channel),
            }));
            // NAMES does not say who is away, and the players who
            // disconnected before we joined never send AWAY again. WHO does
            // (`H` here, `G` gone), and is only worth asking while AWAY lines
            // keep the answer current.
            if channel.starts_with('#') && state.caps.contains("away-notify") {
                effects.push(Effect::Send(irc::format_line("WHO", &[channel])));
            }
        }
        // RPL_WHOREPLY: `<me> <channel> <user> <host> <server> <nick> <flags>
        // :<hops> <realname>`. Recorded only: the roster is sent once the
        // list has ended, rather than one change per member.
        "352" => {
            let (Some(nick), Some(flags)) = (line.params.get(5), line.params.get(6)) else {
                return effects;
            };
            let key = nick.to_ascii_lowercase();
            if flags.starts_with('G') {
                state.away.insert(key);
            } else if flags.starts_with('H') {
                state.away.remove(&key);
            }
        }
        // RPL_ENDOFWHO: the channel's list again, without those found away.
        "315" => {
            let Some(channel) = line.params.get(1) else {
                return effects;
            };
            if state.rosters.contains_key(channel) {
                effects.push(Effect::Emit(ChatUpdate::Users {
                    channel: channel.clone(),
                    users: state.visible_users(channel),
                }));
            }
        }
        // away-notify: with a reason the user went away, without one they
        // are back. On FAF's server that is a disconnect and a reconnect.
        "AWAY" => {
            let Some(nick) = line.prefix_nick() else {
                return effects;
            };
            let away = line.params.first().is_some_and(|reason| !reason.is_empty());
            effects.extend(state.set_away(nick, away));
        }
        // RPL_TOPIC on join, and RPL_NOTOPIC.
        "332" | "331" => {
            let Some(channel) = line.params.get(1) else {
                return effects;
            };
            let topic = if line.command == "332" {
                line.params.last().cloned().unwrap_or_default()
            } else {
                String::new()
            };
            effects.push(Effect::Emit(ChatUpdate::Topic {
                channel: channel.clone(),
                topic,
            }));
        }
        "TOPIC" => {
            let (Some(channel), Some(topic)) = (line.params.first(), line.params.get(1)) else {
                return effects;
            };
            effects.push(Effect::Emit(ChatUpdate::Topic {
                channel: channel.clone(),
                topic: topic.clone(),
            }));
            if let Some(nick) = line.prefix_nick() {
                effects.push(Effect::info(
                    channel,
                    nick,
                    format!("changed the topic to: {topic}"),
                    line.server_time(),
                ));
            }
        }
        "MODE" => {
            let Some(channel) = line.params.first() else {
                return effects;
            };
            if !channel.starts_with('#') {
                return effects; // a user mode on ourselves: nothing to show
            }
            let Some(modes) = line.params.get(1) else {
                return effects;
            };
            for (nick, modes) in membership_mode_changes(modes, &line.params[2..]) {
                let current = state
                    .rosters
                    .get(channel)
                    .and_then(|r| r.get(&nick))
                    .cloned()
                    .unwrap_or_default();
                let elevation = irc::apply_mode(&current, &modes);
                if let Some(roster) = state.rosters.get_mut(channel) {
                    if let Some(slot) = roster.get_mut(&nick) {
                        *slot = elevation.clone();
                    }
                }
                effects.push(Effect::Emit(ChatUpdate::UserElevation {
                    channel: channel.clone(),
                    user: nick,
                    elevation,
                }));
            }
        }
        _ => {}
    }
    effects
}
