//! Party rooms use the owner's real login, never a lobby placeholder.

use crate::state::{PartyState, Player, SocialState};

pub fn party_chat_channel(
    party: &PartyState,
    social: &SocialState,
    player: Option<&Player>,
) -> Option<String> {
    let owner = party.owner_id?;
    if party.members.len() < 2 || !party.members.iter().any(|member| member.player_id == owner) {
        return None;
    }
    let login = social
        .players
        .iter()
        .find(|profile| profile.id == owner)
        .map(|profile| profile.login.as_str())
        .filter(|login| !login.is_empty())
        .or_else(|| {
            player
                .filter(|player| player.id == owner)
                .map(|player| player.name.as_str())
        })?
        .trim();
    if login.is_empty()
        || login
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, ',' | ':'))
    {
        return None;
    }
    Some(format!("#{login}'sParty"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PartyMember, PlayerProfile};

    fn party(owner: i32) -> PartyState {
        PartyState {
            owner_id: Some(owner),
            members: [4, 7]
                .map(|player_id| PartyMember {
                    player_id,
                    name: format!("Player {player_id}"),
                    factions: vec![],
                })
                .into(),
        }
    }

    #[test]
    fn party_channel_uses_live_names_or_the_signed_in_owner() {
        let mut social = SocialState::default();
        social.players.push(PlayerProfile {
            id: 7,
            login: "Leader".into(),
            ..Default::default()
        });
        assert_eq!(
            party_chat_channel(&party(7), &social, None).as_deref(),
            Some("#Leader'sParty")
        );
        assert_eq!(
            party_chat_channel(
                &party(7),
                &SocialState::default(),
                Some(&Player::new(7, "Leader"))
            )
            .as_deref(),
            Some("#Leader'sParty")
        );
        assert!(party_chat_channel(
            &party(7),
            &SocialState::default(),
            Some(&Player::new(4, "Wingmate"))
        )
        .is_none());
    }

    #[test]
    fn party_channel_rejects_solo_incomplete_and_invalid_room_names() {
        let mut solo = party(7);
        solo.members.truncate(1);
        assert!(party_chat_channel(
            &solo,
            &SocialState::default(),
            Some(&Player::new(7, "Leader"))
        )
        .is_none());
        assert!(party_chat_channel(
            &party(99),
            &SocialState::default(),
            Some(&Player::new(99, "Leader"))
        )
        .is_none());
        for login in ["", "Two Words", "bad,name", "bad:name"] {
            assert!(party_chat_channel(
                &party(7),
                &SocialState::default(),
                Some(&Player::new(7, login))
            )
            .is_none());
        }
    }
}
