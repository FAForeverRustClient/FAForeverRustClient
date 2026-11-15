use super::*;

pub(super) fn decide(
    line: &irc::IrcLine,
    state: &mut SessionState,
    ctx: &SessionContext,
) -> Vec<Effect> {
    let mut effects = Vec::new();
    match line.command.as_str() {
        "PING" => {
            let payload = line.params.first().cloned().unwrap_or_default();
            effects.push(Effect::Send(irc::format_line("PONG", &[&payload])));
        }
        "PONG" => {}
        "CAP" => match line.params.get(1).map(String::as_str) {
            Some("LS") => {
                // `CAP * LS * :<caps>` means more lines follow; the final line
                // omits the `*`. The capability list is always the trailing param.
                let more = line.params.get(2).map(String::as_str) == Some("*");
                if let Some(caps) = line.params.last() {
                    state.offered_caps.extend(capability_names(caps));
                }
                if more {
                    return effects;
                }
                if !state.offered_caps.contains("sasl") {
                    effects.push(Effect::Stop(SessionEnd::AuthFailed));
                    return effects;
                }
                let requested: Vec<&str> = WANTED_CAPS
                    .iter()
                    .copied()
                    .filter(|c| state.offered_caps.contains(*c))
                    .collect();
                effects.push(Effect::Send(irc::format_line(
                    "CAP",
                    &["REQ", &requested.join(" ")],
                )));
            }
            Some("ACK") => {
                if let Some(caps) = line.params.last() {
                    state.caps.extend(capability_names(caps));
                }
                effects.push(Effect::TagsEnabled(state.caps.contains("message-tags")));
                effects.push(Effect::EchoEnabled(state.caps.contains("echo-message")));
                effects.push(Effect::Send("AUTHENTICATE PLAIN".to_string()));
            }
            Some("NAK") => {
                // An optional capability must never cost us the connection:
                // drop back to the bare `sasl` request the client used before
                // it negotiated anything else. Only a second NAK is fatal.
                if state.sasl_only_retry {
                    effects.push(Effect::Stop(SessionEnd::AuthFailed));
                    return effects;
                }
                state.sasl_only_retry = true;
                effects.push(Effect::Send(irc::format_line("CAP", &["REQ", "sasl"])));
            }
            _ => {}
        },
        "AUTHENTICATE" => {
            if line.params.first().map(String::as_str) == Some("+") {
                let payload = irc::sasl_plain_payload(
                    "",
                    &ctx.username,
                    &format!("token:{}", ctx.sasl_token),
                );
                effects.push(Effect::Send(irc::format_line("AUTHENTICATE", &[&payload])));
            }
        }
        // RPL_SASLSUCCESS
        "903" => {
            effects.push(Effect::Send("CAP END".to_string()));
            effects.push(Effect::Send(irc::format_line("NICK", &[&state.nick])));
            effects.push(Effect::Send(irc::format_line(
                "USER",
                &[&state.nick, "0", "*", &state.nick],
            )));
        }
        "904" | "905" => {
            effects.push(Effect::Stop(SessionEnd::AuthFailed));
        }
        // ERR_NICKNAMEINUSE: take the same escape hatch as the Python client.
        "433" => {
            state.nick.push('_');
            effects.push(Effect::NickChanged(state.nick.clone()));
            effects.push(Effect::Send(irc::format_line("NICK", &[&state.nick])));
        }
        // RPL_WELCOME: registered. The server's idea of our nick wins.
        "001" => {
            if let Some(nick) = line.params.first() {
                state.nick = nick.clone();
                effects.push(Effect::NickChanged(nick.clone()));
            }
            state.registered = true;
            effects.push(Effect::Emit(ChatUpdate::Status(
                ChatStatus::Connected,
                state.nick.clone(),
            )));
            for channel in &ctx.wanted_channels {
                if channel.starts_with('#') {
                    effects.push(Effect::Send(irc::format_line("JOIN", &[channel])));
                } else {
                    effects.extend(request_history(channel, state));
                }
            }
        }
        _ => {}
    }
    effects
}
