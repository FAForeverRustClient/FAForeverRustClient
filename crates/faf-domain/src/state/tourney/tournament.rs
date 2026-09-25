//! [`Tourney`] itself and the questions asked of it: who may do what, where
//! the bracket stands, what a round needs. Most of the domain's rules live in
//! its `impl`.

use super::*;

/// Where an event stands in its own lifecycle.
///
/// The server's own five values, not Challonge's. Anything unrecognised is
/// [`Self::Unknown`] rather than a guess, because the UI gates real actions on
/// this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyStatus {
    /// A captains draft is running: the teams exist, their captains are taking
    /// turns picking, and nobody else can do anything yet.
    ///
    /// Not "announced but not open", which is what this said until the draft was
    /// built and `lib/teams.js:53` was read: the service moves an event here
    /// from `signup` when `start_draft` runs.
    #[default]
    Draft,
    /// Taking signups.
    Signup,
    /// Signups closed and teams formed; seeds can still change, the bracket has
    /// not been drawn. A player can do nothing here but check in.
    Drafted,
    /// Bracket drawn, matches being played.
    Running,
    Finished,
    Unknown,
}

impl TourneyStatus {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "draft" => Self::Draft,
            "signup" => Self::Signup,
            "drafted" => Self::Drafted,
            "running" => Self::Running,
            "finished" => Self::Finished,
            _ => Self::Unknown,
        }
    }

    /// Whether the bracket exists and is being played or has been.
    pub fn has_bracket(self) -> bool {
        matches!(self, Self::Running | Self::Finished)
    }
}

/// Who runs the event, which decides whether FAF's rules articles apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyCategory {
    /// Run by FAF itself; the site-wide rules pages apply.
    Official,
    #[default]
    Community,
}

impl TourneyCategory {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "official" => Self::Official,
            _ => Self::Community,
        }
    }
}

/// A complete tournament, as `GET /api/t/{id}` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tourney {
    pub id: String,
    pub name: String,
    /// The briefing: rules, schedule, whatever the organiser wrote.
    ///
    /// Held as its **source**, not as plain text, which is a deliberate reversal
    /// of what this field used to do. The service's rich fields are markdown
    /// that a person typed into its own editor, not third-party HTML: `cleanName`
    /// deletes every `<` and `>` on the way in, so a tag cannot survive storage.
    /// The client's second guarantee is the renderer, which builds React elements
    /// out of the subset it understands and never `dangerouslySetInnerHTML`. Any
    /// markup that somehow got here therefore renders as the text it is.
    ///
    /// The same applies to [`Self::rewards`], [`Self::sponsors`],
    /// [`Self::lobby_options`] and [`Self::mods`].
    pub description: String,
    /// What the winners get, beyond the cash: avatars, credits, a trophy.
    pub rewards: String,
    /// Who paid for it, in the organiser's own words.
    pub sponsors: String,
    /// The headline cash prize, shown in its own box above the rewards.
    pub prize: Option<Prize>,
    /// Where to watch. Up to ten, in the order the organiser listed them.
    pub streams: Vec<Stream>,
    /// The lobby settings every host in the event is expected to set.
    pub lobby_options: String,
    /// Which mods are required, allowed or banned.
    pub mods: String,
    /// Images uploaded for the briefing, as bare file names.
    ///
    /// Referenced from the rich fields as `/desc-images/{name}`; any that no
    /// field mentions are drawn as a gallery underneath, which is how a
    /// pasted-in screenshot that never got placed still gets shown.
    pub desc_images: Vec<String>,
    pub status: TourneyStatus,
    pub category: TourneyCategory,
    pub competition: Competition,
    pub formation: Formation,
    pub bracket_kind: BracketKind,
    /// 1 to 6.
    pub team_size: i32,
    pub divisions: i32,
    /// The entrant cap the organiser set, or 0 for none.
    ///
    /// Read because the round projection needs it: before anybody has entered,
    /// a cap is the only thing that says how large the bracket will be, and
    /// preparing map pools during signups turns on knowing that.
    pub max_teams: i32,
    /// The number of entrants below which the organiser would call it off, or 0.
    /// Display only, on both sides: the service never enforces it.
    pub min_teams: i32,
    /// How the field is ordered when teams are locked.
    ///
    /// Read, which it was not before, and the reason is the trap this field is
    /// famous for here: `edit_format` treats a present key as an instruction, so
    /// a client that could not see the seeding policy had to either resend a
    /// guess or omit it. Now it can send back what is actually set.
    pub seeding: Seeding,
    /// The best-of template, where the event has one. Free-for-alls have none.
    pub plan: Option<MatchPlan>,
    /// Whether players may report their own results, or only organisers can.
    ///
    /// Read but never written as true: the client has no player reporting path,
    /// and both write bodies say so explicitly. It still matters on the way in,
    /// because a report raised on the *website* has to be answerable here.
    pub player_reporting: bool,
    /// How entrants get in.
    ///
    /// Sent with every answer and read for a concrete reason: the edit form
    /// resends it, so an event whose mode the client could not see would be
    /// reopened to everyone the first time somebody corrected its name.
    pub signup_mode: SignupMode,
    pub veto_enabled: bool,
    pub rating: RatingGate,
    /// Which FAF rating the event seeds and gates on, or [`RatingKind::None`].
    ///
    /// Sent with every answer, and worth reading for one concrete reason: an
    /// unrated event has no rating to fetch, so the organiser supplies one when
    /// adding an entrant. Without this the client cannot tell the two apart, and
    /// the field it needs stays hidden.
    pub rating_kind: RatingKind,
    /// The instant ratings were frozen at, in Unix seconds.
    ///
    /// What stops an entrant signing up on a peak rating and playing weeks later
    /// on a lower one: every rating in the event is the value as of this date.
    /// Shown rather than acted on: the server does the freezing.
    pub rating_date: Option<u32>,
    /// Unix seconds.
    pub created_at: Option<u32>,
    pub event_date: Option<u32>,
    pub signup_opens_at: Option<u32>,
    pub signup_closes_at: Option<u32>,
    pub check_in_opens_at: Option<u32>,
    pub check_in_deadline: Option<u32>,
    /// Whether posting is closed. Reading an old event's chat stays possible;
    /// the server locks writing two days after the event ends.
    pub chat_locked: bool,
    /// Whether this event bans and picks its maps, and how.
    pub veto: VetoConfig,
    /// How the free-for-all is run. `None` for a team event.
    pub ffa: Option<FfaConfig>,
    /// The captains draft, while one is running. `None` for every other
    /// formation and before it starts.
    pub draft: Option<Draft>,
    /// The entrants an organiser marked as captains before starting a draft.
    /// They become the captains of the teams the service creates.
    pub pending_captains: Vec<String>,
    /// Whether the draft order snakes back on every other pass, rather than
    /// running the same way each time.
    pub draft_snakes: bool,
    /// Whether this event's results came from somewhere else.
    ///
    /// An imported bracket carries its source's own final placings and often
    /// nothing else, so the standings are read off `final_rank` rather than
    /// worked out from the matches.
    pub imported: bool,
    /// Whether anyone but the organiser can see this event.
    ///
    /// `POST /api/tournaments` creates with this false, and the list endpoint
    /// then shows the row to its organisers alone. An event that is missing
    /// from the list for everybody else is not a bug in the list: it was never
    /// published, and only `publish` changes that.
    pub published: bool,
    /// When publication is scheduled for, in Unix seconds, or `None` for an
    /// event that is either already out or has no date set.
    pub publish_at: Option<u32>,
    /// How many have entered, and how many teams they formed.
    ///
    /// Held separately because the list endpoint sends only these numbers while
    /// the detail sends the people. One row type for both means the list can
    /// say "14 entrants" without a second request per tournament.
    pub player_count: i32,
    pub team_count: i32,
    pub players: Vec<TourneyPlayer>,
    pub teams: Vec<TourneyTeam>,
    /// Entrants who ended up without a team when the field was locked.
    ///
    /// The service calls them subs. They are the free agents: everyone whose
    /// team never filled up, plus the members of any team the entrant cap
    /// pushed out. Before that moment the same people are simply players with
    /// no `team_id`, so the Teams section works both out from the phase.
    pub subs: Vec<String>,
    pub matches: Vec<TourneyMatch>,
    pub map_db: Vec<TourneyMap>,
    pub map_pools: Vec<MapPool>,
    /// Which pool is played in which round, keyed by the server's round label.
    pub pool_assign: Vec<PoolAssignment>,
    pub organisers: Vec<String>,
    /// The organiser's announcements, newest first.
    pub news: Vec<NewsPost>,
    /// People the organiser invited. Empty for anyone who is not one: the
    /// server omits the field rather than trimming it.
    pub invites: Vec<TourneyInvite>,
    /// The organiser-only audit log, newest first. Empty for everyone else,
    /// because the service does not send it to them.
    pub audit_log: Vec<AuditEntry>,
    /// Every organiser, including any who hid themselves from the public list.
    /// Organiser-only, like the log.
    pub organiser_accounts: Vec<Organiser>,
    /// Accounts silenced in this event's chat. Organiser-only.
    pub chat_mutes: Vec<ChatMute>,
    /// Who is casting this event. Organiser-only, like the lists above.
    pub casters: Vec<Caster>,
    /// Called off rather than played: too few signups, usually.
    ///
    /// Distinct from archived, which hides the event. An abandoned one stays
    /// visible and finished-looking, and saying so is the whole point: an event
    /// with an empty bracket and no explanation reads as broken.
    pub abandoned: bool,
    /// Whether this account has been silenced in the event's chat.
    ///
    /// Read for one reason: a muted player's post is refused with a sentence
    /// they see only after typing it. Knowing beforehand turns that into a
    /// closed composer with a reason.
    pub chat_muted_me: bool,
    /// The series this edition belongs to, where it belongs to one.
    ///
    /// Three fields for one relationship because the service resolves it for
    /// us: the id is what `set_series` writes, and the name and colour are the
    /// series' own, sent alongside so a row can be labelled without a second
    /// request per tournament.
    pub series_id: Option<String>,
    pub series_name: String,
    pub series_colour: SeriesColour,
    /// Events whose results feed entrants into this one. Organiser-facing, but
    /// sent to everybody: who qualifies for a final is public information.
    pub qualifiers: Vec<Qualifier>,
    /// The event this one feeds, where it feeds one. Derived by the service
    /// from every other tournament's links, never stored on this side.
    pub feeds_into: Option<FeedsInto>,
    pub champion_team_id: Option<String>,
    /// What this account may do here, as the server sees it.
    pub viewer: TourneyViewer,
}

impl Tourney {
    pub fn team(&self, id: &str) -> Option<&TourneyTeam> {
        self.teams.iter().find(|team| team.id == id)
    }

    /// The team this account plays for, if any.
    pub fn my_team(&self) -> Option<&TourneyTeam> {
        self.team(self.viewer.member_team_id.as_deref()?)
    }

    /// Whether this account captains `team`.
    ///
    /// Captaincy is what the server checks for answering join requests and
    /// sending invites, and it moves on its own: when a captain leaves, the
    /// next member inherits it.
    pub fn is_captain_of(&self, team: &TourneyTeam) -> bool {
        let Some(mine) = self.viewer.signed_up_player_id.as_deref() else {
            return false;
        };
        team.captain_id.as_deref() == Some(mine)
    }

    pub fn team_is_full(&self, team: &TourneyTeam) -> bool {
        i32::try_from(team.player_ids.len()).unwrap_or(i32::MAX) >= self.team_size
    }

    /// A team's combined rating, which is what `maxTeamRating` is measured
    /// against.
    pub fn team_rating(&self, team: &TourneyTeam) -> i32 {
        team.player_ids
            .iter()
            .filter_map(|id| self.player(id))
            .filter_map(|player| player.rating)
            .sum()
    }

    /// Whether adding this account would put `team` over the organiser's
    /// combined-rating ceiling.
    ///
    /// Checked before offering the request, because the server's refusal is
    /// specific and a little humiliating to read after the fact: it names the
    /// number the team would reach.
    pub fn would_exceed_team_cap(&self, team: &TourneyTeam) -> bool {
        let (Some(cap), Some(mine)) = (self.rating.max_team, self.my_rating()) else {
            return false;
        };
        self.team_rating(team) + mine > cap
    }

    /// This account's rating in this tournament, as the server fetched it.
    pub fn my_rating(&self) -> Option<i32> {
        let mine = self.viewer.signed_up_player_id.as_deref()?;
        self.player(mine)?.rating
    }

    /// Whether the tab should offer forming a team at all.
    ///
    /// Only for events that have teams to form: a solo event's teams are made
    /// by the organiser at the phase change, and a draft event's by the
    /// captains, so in both a "create team" button would be a trap.
    pub fn teams_are_self_organised(&self) -> bool {
        self.formation == Formation::Open
            && self.team_size > 1
            && self.status == TourneyStatus::Signup
    }

    /// Whether this account may start a team of its own.
    pub fn may_create_team(&self) -> bool {
        self.teams_are_self_organised()
            && self.viewer.is_signed_up()
            && self.viewer.member_team_id.is_none()
    }

    /// Whether this account may ask to join `team`.
    pub fn may_request_join(&self, team: &TourneyTeam) -> bool {
        self.may_create_team()
            && !self.team_is_full(team)
            && !self.has_asked_to_join(team)
            && !self.would_exceed_team_cap(team)
    }

    pub fn has_asked_to_join(&self, team: &TourneyTeam) -> bool {
        let Some(mine) = self.viewer.signed_up_player_id.as_deref() else {
            return false;
        };
        team.join_requests
            .iter()
            .any(|asking| asking.player_id == mine)
    }

    /// The teams that have invited this account, newest last.
    ///
    /// Surfaced rather than buried in the team list: an invite is the one thing
    /// in this pane that is waiting on *you*.
    pub fn my_invites(&self) -> Vec<&TourneyTeam> {
        let Some(mine) = self.viewer.signed_up_player_id.as_deref() else {
            return Vec::new();
        };
        self.teams
            .iter()
            .filter(|team| team.invites.iter().any(|invite| invite.player_id == mine))
            .collect()
    }

    /// Signups waiting on the organiser, in request mode.
    ///
    /// The server shows a pending entry only to organisers and to the person
    /// who asked, so this is already the right list for whoever is looking.
    pub fn pending_signups(&self) -> Vec<&TourneyPlayer> {
        self.players
            .iter()
            .filter(|player| player.pending)
            .collect()
    }

    /// Whether seeds can still be changed.
    ///
    /// Only between forming teams and drawing the bracket. Before that there
    /// are no teams; after it the draw is fixed.
    pub fn may_reseed(&self) -> bool {
        self.status == TourneyStatus::Drafted && !self.teams.is_empty()
    }

    /// Entrants with no team yet, which is who a captain can invite.
    pub fn unteamed(&self) -> Vec<&TourneyPlayer> {
        self.players
            .iter()
            .filter(|player| player.team_id.is_none() && !player.pending)
            .collect()
    }

    pub fn player(&self, id: &str) -> Option<&TourneyPlayer> {
        self.players.iter().find(|player| player.id == id)
    }

    /// Everyone on a team, in the order they joined.
    pub fn members(&self, team: &TourneyTeam) -> Vec<&TourneyPlayer> {
        team.player_ids
            .iter()
            .filter_map(|id| self.player(id))
            .collect()
    }

    /// The pool played in `round`, if the organiser bound one.
    pub fn pool_for_round(&self, round: &str) -> Option<&MapPool> {
        let assignment = self
            .pool_assign
            .iter()
            .find(|assignment| assignment.round == round)?;
        self.map_pools
            .iter()
            .find(|pool| pool.id == assignment.pool_id)
    }

    /// The maps in a pool, in the pool's own order.
    pub fn pool_maps(&self, pool: &MapPool) -> Vec<&TourneyMap> {
        pool.map_ids
            .iter()
            .filter_map(|id| self.map_db.iter().find(|map| &map.id == id))
            .collect()
    }

    /// Whether this account may record the result of `entry`.
    ///
    /// The organiser, and nobody else. That is a decision about this client, not
    /// a limit of the service: `report_submit` lets the two players agree a score
    /// between them, but it insists on one FAF replay id per game, and this client
    /// keeps result-entry with the person running the event.
    ///
    /// The server's own conditions for `report`, in its order: the bracket has to
    /// be running or finished, the caller has to be an organiser, and the match
    /// has to have two sides. A finished match stays reportable, because `report` is also
    /// the correction path, and it undoes the old result first.
    pub fn may_report(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.status.has_bracket()
            && entry.bracket != BracketSide::FreeForAll
            && entry.team1.is_some()
            && entry.team2.is_some()
    }

    /// Which standings table this event has, if any.
    ///
    /// An imported bracket answers with its source's placings even when it has
    /// no matches at all, which is the case `Elimination` cannot serve.
    pub fn standings_kind(&self) -> StandingsKind {
        if self.imported {
            return StandingsKind::Imported;
        }
        if !self.status.has_bracket() {
            return StandingsKind::None;
        }
        if self
            .ffa
            .as_ref()
            .is_some_and(|ffa| ffa.mode == FfaMode::Points)
        {
            return StandingsKind::Points;
        }
        if self.bracket_kind == BracketKind::Swiss {
            return StandingsKind::Swiss;
        }
        StandingsKind::Elimination
    }

    /// The standings, in the order they are shown.
    ///
    /// Worked out here rather than read from the service, because the service
    /// sends no table: the website recomputes it in the browser from the matches
    /// and each team's exit, and so does this. One implementation is what stops
    /// the bracket and the table disagreeing.
    ///
    /// Free-for-all points are not covered. That table is summed from a per
    /// match `points` object the client does not model yet, and inventing an
    /// order without it would be worse than showing none.
    pub fn standings(&self) -> Vec<Standing> {
        match self.standings_kind() {
            StandingsKind::None => Vec::new(),
            StandingsKind::Swiss => self.swiss_standings(),
            StandingsKind::Imported => self.imported_standings(),
            StandingsKind::Points => self.points_standings(),
            StandingsKind::Elimination => self.elimination_standings(),
        }
    }

    /// Wins, losses and game difference over the Swiss rounds.
    ///
    /// A bye counts as a win worth one game, as the service's own table does: a
    /// team that drew the odd number should not sit behind one that played.
    fn swiss_standings(&self) -> Vec<Standing> {
        let mut rows: Vec<Standing> = self
            .teams
            .iter()
            .map(|team| Standing {
                team_id: team.id.clone(),
                place: None,
                outcome: StandingOutcome::Swiss,
                wins: 0,
                losses: 0,
                game_diff: 0,
            })
            .collect();

        for entry in self
            .matches
            .iter()
            .filter(|entry| entry.bracket == BracketSide::Swiss)
        {
            match entry.status {
                MatchStatus::Bye => {
                    // The absent side is a placeholder rather than a team, so
                    // whichever of the two names a real one is who advanced.
                    let advanced = [entry.team1.as_deref(), entry.team2.as_deref()]
                        .into_iter()
                        .flatten()
                        .find_map(|id| rows.iter().position(|row| row.team_id == id));
                    if let Some(at) = advanced {
                        rows[at].wins += 1;
                        rows[at].game_diff += 1;
                    }
                }
                MatchStatus::Done => {
                    let (Some(winner), Some(loser)) = (&entry.winner, &entry.loser) else {
                        continue;
                    };
                    let won_by_first = Some(winner.as_str()) == entry.team1.as_deref();
                    let (high, low) = if won_by_first {
                        (entry.score1, entry.score2)
                    } else {
                        (entry.score2, entry.score1)
                    };
                    let margin = high.unwrap_or(0) - low.unwrap_or(0);
                    if let Some(at) = rows.iter().position(|row| &row.team_id == winner) {
                        rows[at].wins += 1;
                        rows[at].game_diff += margin;
                    }
                    if let Some(at) = rows.iter().position(|row| &row.team_id == loser) {
                        rows[at].losses += 1;
                        rows[at].game_diff -= margin;
                    }
                }
                _ => {}
            }
        }

        rows.sort_by(|left, right| {
            right
                .wins
                .cmp(&left.wins)
                .then(right.game_diff.cmp(&left.game_diff))
                .then(
                    self.seed_of(&left.team_id)
                        .cmp(&self.seed_of(&right.team_id)),
                )
        });
        for (position, row) in rows.iter_mut().enumerate() {
            row.place = Some(position as i32 + 1);
            if Some(row.team_id.as_str()) == self.champion_team_id.as_deref() {
                row.outcome = StandingOutcome::Champion;
            }
        }
        rows
    }

    /// Points summed over every free-for-all lobby.
    ///
    /// The champion is pinned to the top regardless of the total, because the
    /// final decides the event and a points lead going into it does not.
    fn points_standings(&self) -> Vec<Standing> {
        let mut rows: Vec<Standing> = self
            .teams
            .iter()
            .map(|team| Standing {
                team_id: team.id.clone(),
                place: None,
                outcome: if Some(team.id.as_str()) == self.champion_team_id.as_deref() {
                    StandingOutcome::Champion
                } else if team.out.is_some() {
                    StandingOutcome::OutIn {
                        bracket: BracketSide::FreeForAll,
                        round: team.out.as_ref().map_or(0, |exit| exit.round),
                    }
                } else {
                    StandingOutcome::StillIn
                },
                wins: 0,
                losses: 0,
                game_diff: 0,
            })
            .collect();

        for entry in self
            .matches
            .iter()
            .filter(|entry| entry.bracket == BracketSide::FreeForAll)
        {
            for scored in &entry.points {
                if let Some(row) = rows.iter_mut().find(|row| row.team_id == scored.team_id) {
                    // `wins` carries the total: one shape for every table, and
                    // the pane labels the column by the format.
                    row.wins += scored.points;
                }
            }
        }

        let champion = self.champion_team_id.as_deref();
        rows.sort_by(|left, right| {
            let crowned = |row: &Standing| i32::from(Some(row.team_id.as_str()) == champion);
            crowned(right)
                .cmp(&crowned(left))
                .then(right.wins.cmp(&left.wins))
                .then(
                    self.seed_of(&left.team_id)
                        .cmp(&self.seed_of(&right.team_id)),
                )
        });
        for (position, row) in rows.iter_mut().enumerate() {
            row.place = Some(position as i32 + 1);
        }
        rows
    }

    /// The placings an import brought with it. Unplaced teams sort last.
    fn imported_standings(&self) -> Vec<Standing> {
        let mut teams: Vec<&TourneyTeam> = self.teams.iter().collect();
        teams.sort_by_key(|team| (team.final_rank.unwrap_or(i32::MAX), team.seed));
        teams
            .into_iter()
            .map(|team| Standing {
                team_id: team.id.clone(),
                place: team.final_rank,
                outcome: if Some(team.id.as_str()) == self.champion_team_id.as_deref() {
                    StandingOutcome::Champion
                } else {
                    StandingOutcome::Placed
                },
                wins: 0,
                losses: 0,
                game_diff: 0,
            })
            .collect()
    }

    /// Rank by how far each run got, champion first.
    ///
    /// Teams knocked out at the same depth share a place, so a four-team double
    /// elimination reads 1, 2, 3, 3 rather than inventing an order between two
    /// teams that never played each other.
    fn elimination_standings(&self) -> Vec<Standing> {
        let mut teams: Vec<&TourneyTeam> = self.teams.iter().collect();
        teams.sort_by(|left, right| {
            self.depth_of(right)
                .cmp(&self.depth_of(left))
                .then(left.seed.cmp(&right.seed))
        });

        let mut rows = Vec::with_capacity(teams.len());
        let mut previous: Option<i64> = None;
        let mut place = 0;
        for (position, team) in teams.iter().enumerate() {
            let depth = self.depth_of(team);
            if previous != Some(depth) {
                place = position as i32 + 1;
                previous = Some(depth);
            }
            let champion = Some(team.id.as_str()) == self.champion_team_id.as_deref();
            let outcome = match (champion, &team.out) {
                (true, _) => StandingOutcome::Champion,
                (false, None) => StandingOutcome::StillIn,
                (false, Some(exit)) if exit.bracket == BracketSide::GrandFinal => {
                    StandingOutcome::LostFinal
                }
                (false, Some(exit)) => StandingOutcome::OutIn {
                    bracket: exit.bracket,
                    round: exit.round,
                },
            };
            rows.push(Standing {
                team_id: team.id.clone(),
                // Still in it means no place yet: calling somebody fourth while
                // they might still win it is worse than leaving it blank.
                place: if champion {
                    Some(1)
                } else if team.out.is_none() {
                    None
                } else {
                    Some(place)
                },
                outcome,
                wins: 0,
                losses: 0,
                game_diff: 0,
            });
        }
        rows
    }

    /// How far a run got, as one comparable number. Bigger is further.
    ///
    /// The bands sit far apart on purpose: losing the grand final beats any
    /// number of lower-bracket rounds, and being alive beats having lost at all.
    fn depth_of(&self, team: &TourneyTeam) -> i64 {
        if Some(team.id.as_str()) == self.champion_team_id.as_deref() {
            return 1_000_000_000;
        }
        let Some(exit) = &team.out else {
            return 100_000_000;
        };
        match exit.bracket {
            BracketSide::GrandFinal => 1_000_000,
            BracketSide::Losers => 1_000 + i64::from(exit.round),
            _ => i64::from(exit.round),
        }
    }

    fn seed_of(&self, team_id: &str) -> i32 {
        self.team(team_id).map_or(i32::MAX, |team| team.seed)
    }

    /// Whether this account may take the veto step that is due.
    ///
    /// The service allows two people: the captain of the team whose turn it is,
    /// and an organiser acting on their behalf. Everyone else is refused, and a
    /// map grid offered to them would be a grid of buttons that all fail.
    pub fn may_veto(&self, entry: &TourneyMatch) -> bool {
        let Some(veto) = &entry.veto else {
            return false;
        };
        if !self.veto.enabled || entry.status == MatchStatus::Done {
            return false;
        }
        let Some(turn) = veto.current_turn() else {
            return false;
        };
        if self.viewer.organiser {
            return true;
        }
        // Captaincy, not membership: the service checks the captain token or the
        // captain's own session, and a team-mate is refused.
        self.team(&turn.team_id)
            .is_some_and(|team| self.is_captain_of(team))
    }

    /// Whether an organiser may still choose which team is A for this match.
    pub fn may_set_veto_sides(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.veto.enabled
            && entry
                .veto
                .as_ref()
                .is_some_and(|veto| veto.may_set_sides() && veto.team_a.is_none())
    }

    /// How many winners the service wants for this free-for-all lobby.
    ///
    /// One in a final, and otherwise the smaller of the configured `advance`
    /// and one short of the field: a lobby cannot advance everybody in it. The
    /// service refuses any other count with the number it wanted, so the form
    /// asks for exactly this many rather than finding out afterwards.
    pub fn ffa_winners_needed(&self, entry: &TourneyMatch) -> i32 {
        let Some(ffa) = &self.ffa else {
            return 0;
        };
        let in_lobby = entry.entrants.len() as i32;
        // A round with one lobby left is the final whether or not it says so.
        let only_lobby = self
            .matches
            .iter()
            .filter(|other| other.bracket == BracketSide::FreeForAll && other.round == entry.round)
            .count()
            == 1;
        if entry.is_final || only_lobby {
            return 1;
        }
        ffa.advance.min((in_lobby - 1).max(0))
    }

    /// Whether this lobby is scored rather than won.
    ///
    /// Points mode still decides its final by a winner, which is the one case
    /// where the two paths meet.
    pub fn ffa_is_scored(&self, entry: &TourneyMatch) -> bool {
        self.ffa
            .as_ref()
            .is_some_and(|ffa| ffa.mode == FfaMode::Points)
            && !entry.is_final
    }

    /// Whether this account may record a free-for-all lobby's result.
    ///
    /// Same answer as `may_report` for a two-sided match, and separate only
    /// because `may_report` excludes free-for-all rounds: their body is a
    /// different shape and the ordinary report dialog cannot build it.
    pub fn may_report_ffa(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.status.has_bracket()
            && entry.bracket == BracketSide::FreeForAll
            && !entry.entrants.is_empty()
    }

    /// The team whose draft pick is due.
    pub fn draft_turn(&self) -> Option<&str> {
        if self.status != TourneyStatus::Draft {
            return None;
        }
        self.draft.as_ref()?.turn()
    }

    /// Whether this account may make the pick that is due.
    ///
    /// The captain of the team on the clock, or an organiser picking for them.
    /// Same shape as `may_veto`, and for the same reason: the service checks
    /// captaincy, so offering the list to a team-mate is offering a refusal.
    pub fn may_pick(&self) -> bool {
        let Some(turn) = self.draft_turn() else {
            return false;
        };
        if self.viewer.organiser {
            return true;
        }
        self.team(turn).is_some_and(|team| self.is_captain_of(team))
    }

    /// Whether this account may take back the last pick.
    ///
    /// An organiser may, at any point. A captain may take back only their own,
    /// and only while nobody has picked after them: once the next captain has
    /// gone, undoing would rewrite somebody else's turn.
    pub fn may_undo_pick(&self) -> bool {
        if !matches!(self.status, TourneyStatus::Draft | TourneyStatus::Drafted) {
            return false;
        }
        let Some(draft) = &self.draft else {
            return false;
        };
        let Some(last) = &draft.last_pick else {
            return false;
        };
        if self.viewer.organiser {
            return true;
        }
        draft.current == last.at_index + 1
            && self
                .team(&last.team_id)
                .is_some_and(|team| self.is_captain_of(team))
    }

    /// Entrants still waiting to be picked.
    ///
    /// A pending signup is not in the pool: the organiser has not accepted them
    /// yet, and the service refuses a pick naming one.
    pub fn undrafted(&self) -> Vec<&TourneyPlayer> {
        self.players
            .iter()
            .filter(|player| !player.pending && player.team_id.is_none())
            .collect()
    }

    /// Whether this event is still waiting to be made visible.
    ///
    /// The one control an organiser cannot do without: the service creates every
    /// tournament unpublished, so an event created here and left alone is a
    /// draft that only its own organiser can find.
    pub fn may_publish(&self) -> bool {
        self.viewer.organiser && !self.published
    }

    /// Whether the organiser may still shuffle who is on which team.
    ///
    /// `move_player` and `set_captain` are refused once the bracket is drawn: the
    /// draw is made from the teams, so changing them afterwards would leave the
    /// bracket describing an event that no longer exists. Before that, while
    /// signups run and after teams are formed, it is the organiser's main tool
    /// for fixing a no-show or an uneven field.
    pub fn may_shuffle_teams(&self) -> bool {
        self.viewer.organiser && !self.status.has_bracket() && self.team_size > 1
    }

    /// Whether the organiser may type a rating for an entrant.
    ///
    /// Only an unrated event. Everywhere else the server fetches the rating as of
    /// the event's rating date and refuses a typed one with "Ratings are fetched
    /// from FAF for this tournament and cannot be edited", so the field is not
    /// offered rather than offered and refused.
    pub fn may_set_rating(&self) -> bool {
        self.viewer.organiser && self.rating_kind == RatingKind::None
    }

    /// Whether this account may rename or take apart `team`.
    ///
    /// An organiser may rename any team as often as needed. A captain gets one
    /// rename, and only where teams have more than one player: the server counts
    /// it in `captainRenamed` and refuses the second.
    pub fn may_rename(&self, team: &TourneyTeam) -> bool {
        if self.viewer.organiser {
            return true;
        }
        self.is_captain_of(team) && self.team_size > 1 && !team.captain_renamed
    }

    /// Whether this account is the side that has to agree to a pending result.
    ///
    /// Only the *other* team confirms: the submitting team agreeing with itself
    /// would make the second signature worthless.
    pub fn may_confirm(&self, entry: &TourneyMatch) -> bool {
        let (Some(mine), Some(pending)) = (
            self.viewer.member_team_id.as_deref(),
            entry.pending_report.as_ref(),
        ) else {
            return false;
        };
        self.status.has_bracket() && entry.opponent_of(mine).is_some() && pending.by_team != mine
    }

    /// Whether entering is worth offering: signups are open and this account is
    /// not in already.
    ///
    /// The rating gates and the entrant cap are deliberately *not* checked here.
    /// The server owns those and explains them far better than a hidden button
    /// would. "Your rating (1420) is below this tournament's minimum of 1500"
    /// is the answer a player needs, and they only get it by being allowed to
    /// try.
    pub fn may_sign_up(&self) -> bool {
        self.viewer.logged_in && !self.viewer.is_signed_up() && self.status == TourneyStatus::Signup
    }

    /// Whether withdrawing is possible: signed up, and signups still open.
    ///
    /// After that the organiser has to remove the entry, because a bracket that
    /// has been drawn cannot lose an entrant quietly.
    pub fn may_withdraw(&self) -> bool {
        self.viewer.is_signed_up() && self.status == TourneyStatus::Signup
    }

    /// Why a qualifier link to `candidate` would be refused.
    ///
    /// Three of the service's four checks can be made from what a list row
    /// carries; the fourth needs the candidate's own links and stays there. The
    /// last arm is not one of its checks at all: a points rule against an
    /// elimination bracket is *accepted* and then qualifies nobody, which is
    /// the one refusal worth adding rather than mirroring.
    pub fn qualifier_rejection(
        &self,
        candidate: &Tourney,
        rule: QualifierRule,
    ) -> Option<QualifierRejection> {
        if candidate.id == self.id {
            return Some(QualifierRejection::SameEvent);
        }
        if self
            .qualifiers
            .iter()
            .any(|link| link.tournament_id == candidate.id)
        {
            return Some(QualifierRejection::AlreadyLinked);
        }
        if rule.n < 1 {
            return Some(QualifierRejection::CutoffTooLow);
        }
        if !rule
            .kind
            .suits(candidate.competition, candidate.bracket_kind)
        {
            return Some(QualifierRejection::PointsWithoutScores);
        }
        None
    }

    /// Whether the format can still be changed at all.
    ///
    /// The service locks it once the bracket exists, and says so: "The format
    /// is locked once the bracket has started". The draw was made from the
    /// format, so changing it afterwards would leave a bracket describing an
    /// event that no longer exists.
    pub fn may_edit_format(&self) -> bool {
        self.viewer.organiser
            && matches!(
                self.status,
                TourneyStatus::Signup | TourneyStatus::Draft | TourneyStatus::Drafted
            )
    }

    /// Whether the *structural* half of the format can still be changed.
    ///
    /// Narrower again: the competition, the team size, the formation and the
    /// draft order decide what a team is, so the service takes them only while
    /// signups are open. Offering them later produces "Reopen signups to change
    /// the team setup", which reads as a broken control rather than a locked
    /// one.
    pub fn may_edit_team_setup(&self) -> bool {
        self.viewer.organiser && self.status == TourneyStatus::Signup
    }

    /// Whether this account can write in the event's chat.
    ///
    /// Two separate reasons it might not, and they are told apart because the
    /// composer has to say which: the room locks two days after the event, and
    /// an organiser can silence one account.
    pub fn may_post_chat(&self) -> bool {
        self.viewer.logged_in && !self.chat_locked && !self.chat_muted_me
    }

    /// Announcements posted since this account last read them.
    ///
    /// Zero for a reader who is not signed in: the service remembers nothing
    /// for them, and a badge that never cleared would be worse than none.
    pub fn unread_news(&self) -> i32 {
        if !self.viewer.logged_in {
            return 0;
        }
        let read_at = self.viewer.news_read_at.unwrap_or(0);
        self.news
            .iter()
            .filter(|post| post.at.unwrap_or(0) > read_at)
            .count() as i32
    }

    /// How many teams this event expects to draw with.
    ///
    /// The teams once they are formed; otherwise the entrant cap, if one was
    /// set; otherwise the signups divided by the team size. The service's own
    /// order, and the reason the middle one is there: an organiser who has set
    /// a cap has told us the answer before anybody has entered.
    pub fn projected_team_count(&self) -> i32 {
        if !self.teams.is_empty() {
            return self.teams.len() as i32;
        }
        if self.max_teams > 0 {
            return self.max_teams;
        }
        let size = if self.competition == Competition::FreeForAll {
            1
        } else {
            self.team_size.max(1)
        };
        self.players.len() as i32 / size
    }

    /// The rounds a map pool can be bound to.
    ///
    /// Read off the bracket once it exists; projected from the expected team
    /// count before that. The projection is the whole point: pools are prepared
    /// while signups run, and a client that offered nothing until the draw
    /// would force every organiser back to the website for the one step that
    /// has to happen first.
    ///
    /// A free-for-all has no ban/pick rounds at all, so it answers empty rather
    /// than projecting a bracket it will never draw.
    pub fn round_plan(&self) -> RoundPlan {
        let mut real: Vec<(BracketSide, i32)> = Vec::new();
        for entry in &self.matches {
            if entry.bracket == BracketSide::FreeForAll {
                continue;
            }
            let pair = (entry.bracket, entry.round);
            if !real.contains(&pair) {
                real.push(pair);
            }
        }
        if !real.is_empty() {
            return RoundPlan {
                keys: round_keys(&real),
                projected: false,
                teams: self.teams.len() as i32,
            };
        }

        let teams = self.projected_team_count();
        if teams < 2 || self.competition == Competition::FreeForAll {
            return RoundPlan {
                keys: Vec::new(),
                projected: true,
                teams,
            };
        }
        // `ceil(log2(teams))`: the number of rounds a bracket of this size
        // takes. The service picks a Swiss round count at start-up and defaults
        // to the same number.
        let rounds = rounds_for(teams);
        let mut pairs = Vec::new();
        if self.bracket_kind == BracketKind::Swiss {
            for round in 1..=rounds.max(1) {
                pairs.push((BracketSide::Swiss, round));
            }
            // A Swiss event plays a final unless its plan turns one off. The
            // plan is not modelled here, and its default is on.
            pairs.push((BracketSide::GrandFinal, 1));
        } else {
            for round in 1..=rounds {
                pairs.push((BracketSide::Winners, round));
            }
            if self.bracket_kind == BracketKind::Double {
                for round in 1..=(2 * rounds - 2).max(0) {
                    pairs.push((BracketSide::Losers, round));
                }
                pairs.push((BracketSide::GrandFinal, 1));
            }
        }
        RoundPlan {
            keys: round_keys(&pairs),
            projected: true,
            teams,
        }
    }

    /// Whether the organiser may attach this event to a series, or link a
    /// qualifier into it.
    ///
    /// Both are `canOrganize` writes with no status gate of their own: a
    /// finished event can still be filed under its series, and a parent can
    /// still take a late qualifier.
    pub fn may_edit_series(&self) -> bool {
        self.viewer.organiser
    }
}

/// A step the organiser takes to move the event along.
///
/// Named rather than a free string because each one is refused in its own way
/// and from its own status, and the UI has to offer exactly the one that is
/// legal now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyPhase {
    /// Close signups and lock the entrants into teams.
    FormTeams,
    /// Draw the bracket. Legal only once teams exist.
    StartBracket,
    /// Undo both, back to taking signups. Destroys the teams, which is why the
    /// UI confirms before sending it.
    ReopenSignups,
    /// Fix the list of captains, before a draft starts.
    SetCaptains,
    /// Build the pick order and hand the first pick out.
    StartDraft,
}

impl TourneyPhase {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::FormTeams => "form_teams",
            Self::StartBracket => "start_bracket",
            Self::ReopenSignups => "reopen_signups",
            Self::SetCaptains => "set_captains",
            Self::StartDraft => "start_draft",
        }
    }

    /// Whether this step is legal from `status`.
    ///
    /// The server's own gate, mirrored so a button that will be refused is not
    /// drawn at all.
    pub fn is_legal_from(self, status: TourneyStatus) -> bool {
        match self {
            // Both draft steps run from signups: captains are marked while the
            // field is still open, and starting closes it.
            Self::SetCaptains | Self::StartDraft => status == TourneyStatus::Signup,
            Self::FormTeams => status == TourneyStatus::Signup,
            Self::StartBracket => status == TourneyStatus::Drafted,
            Self::ReopenSignups => matches!(
                status,
                TourneyStatus::Signup | TourneyStatus::Draft | TourneyStatus::Drafted
            ),
        }
    }
}
