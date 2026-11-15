use super::*;

pub(super) fn decide(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    let mut effects = Vec::new();
    match line.command.as_str() {
        "JOIN" => {
            let (Some(nick), Some(channel)) = (line.prefix_nick(), line.params.first()) else {
                return effects;
            };
            if state.is_me(nick) {
                effects.push(Effect::Emit(ChatUpdate::ChannelJoined(channel.clone())));
                state.rosters.entry(channel.clone()).or_default();
                // Backfill the conversation so the tab doesn't open empty.
                effects.extend(request_history(channel, state));
            } else {
                // Whoever joins is connected; an AWAY follows if not.
                state.away.remove(&nick.to_ascii_lowercase());
                state
                    .rosters
                    .entry(channel.clone())
                    .or_default()
                    .insert(nick.to_string(), String::new());
                effects.push(Effect::Emit(ChatUpdate::UserJoined {
                    channel: channel.clone(),
                    user: ChatUser::new(nick, ""),
                }));
                effects.push(Effect::info(
                    channel,
                    nick,
                    "joined the channel.",
                    line.server_time(),
                ));
            }
        }
        "PART" => {
            let (Some(nick), Some(channel)) = (line.prefix_nick(), line.params.first()) else {
                return effects;
            };
            if state.is_me(nick) {
                state.rosters.remove(channel);
                state.history_asked.remove(&channel.to_ascii_lowercase());
                effects.push(Effect::Emit(ChatUpdate::ChannelLeft(channel.clone())));
            } else {
                if let Some(roster) = state.rosters.get_mut(channel) {
                    roster.remove(nick);
                }
                effects.push(Effect::Emit(ChatUpdate::UserLeft {
                    channel: channel.clone(),
                    user: nick.to_string(),
                }));
                effects.push(Effect::info(
                    channel,
                    nick,
                    "left the channel.",
                    line.server_time(),
                ));
            }
        }
        "KICK" => {
            let (Some(channel), Some(nick)) = (line.params.first(), line.params.get(1)) else {
                return effects;
            };
            if state.is_me(nick) {
                state.rosters.remove(channel);
                state.history_asked.remove(&channel.to_ascii_lowercase());
                effects.push(Effect::ForgetChannel(channel.clone()));
                effects.push(Effect::Emit(ChatUpdate::ChannelLeft(channel.clone())));
            } else {
                if let Some(roster) = state.rosters.get_mut(channel) {
                    roster.remove(nick);
                }
                effects.push(Effect::Emit(ChatUpdate::UserLeft {
                    channel: channel.clone(),
                    user: nick.clone(),
                }));
                effects.push(Effect::info(
                    channel,
                    nick,
                    "was kicked from the channel.",
                    line.server_time(),
                ));
            }
        }
        "QUIT" => {
            let Some(nick) = line.prefix_nick() else {
                return effects;
            };
            let reason = line.params.first().cloned().unwrap_or_default();
            // The Python client silences the server's default "Quit: <nick>"
            // text, which carries no information.
            let text = if reason.is_empty() || reason.contains(nick) {
                "quit.".to_string()
            } else {
                format!("quit: {reason}")
            };
            state.away.remove(&nick.to_ascii_lowercase());
            for channel in state.channels_with(nick) {
                if let Some(roster) = state.rosters.get_mut(&channel) {
                    roster.remove(nick);
                }
                effects.push(Effect::Emit(ChatUpdate::UserLeft {
                    channel: channel.clone(),
                    user: nick.to_string(),
                }));
                effects.push(Effect::info(
                    &channel,
                    nick,
                    text.clone(),
                    line.server_time(),
                ));
            }
        }
        "NICK" => {
            let (Some(old), Some(new)) = (line.prefix_nick(), line.params.first()) else {
                return effects;
            };
            if state.is_me(old) {
                state.nick = new.clone();
                effects.push(Effect::NickChanged(new.clone()));
            }
            for roster in state.rosters.values_mut() {
                if let Some(elevation) = roster.remove(old) {
                    roster.insert(new.clone(), elevation);
                }
            }
            if state.away.remove(&old.to_ascii_lowercase()) {
                state.away.insert(new.to_ascii_lowercase());
            }
            effects.push(Effect::Emit(ChatUpdate::UserRenamed {
                old_name: old.to_string(),
                new_name: new.clone(),
            }));
        }
        _ => {}
    }
    effects
}
