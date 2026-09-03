import type { ChatChannel, ChatEvent, ChatState, ChatUser, Reaction } from "../../ipc/bindings";

const DEFAULT_CHANNEL = "#aeolus";
const MAX_MESSAGES = 500;
const MAX_RETAINED_HISTORIES = 20;
const MAX_AUTO_JOIN_CHANNELS = 20;
const MODERATOR_PREFIXES = ["~", "&", "@", "%"];

export const isModerator = (user: ChatUser): boolean =>
  MODERATOR_PREFIXES.some((prefix) => user.elevation.includes(prefix));

export const isPrivateChannel = (name: string): boolean => !name.startsWith("#");

/** Does `content` name `username`, bounded by non-word characters? */
export function mentions(content: string, username: string): boolean {
  if (!username) return false;
  const haystack = content.toLowerCase();
  const needle = username.toLowerCase();
  const isWord = (character: string | undefined) =>
    character !== undefined && /[\w[\]-]/.test(character);

  for (let from = 0; ; ) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) return false;
    const end = start + needle.length;
    if (!isWord(haystack[start - 1]) && !isWord(haystack[end])) return true;
    from = end;
  }
}

/**
 * ASCII-only case folding, matching Rust's `eq_ignore_ascii_case`.
 *
 * `toLowerCase()` would fold non-ASCII too, and language channel names are
 * exactly where non-ASCII shows up, so the twins would disagree on the one
 * input this function exists to handle.
 */
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());

/**
 * Twin of `normalize_channels` in `faf-domain`: add the `#` the lobby server
 * omits, drop blanks, de-duplicate case-insensitively, and cap the list.
 */
function normalizeChannels(channels: string[]): string[] {
  const normalized: string[] = [];
  for (const raw of channels) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const name = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    if (!normalized.some((known) => asciiLower(known) === asciiLower(name))) {
      normalized.push(name);
    }
    if (normalized.length === MAX_AUTO_JOIN_CHANNELS) break;
  }
  return normalized;
}

function sortChannels(channels: ChatChannel[]): ChatChannel[] {
  const rank = (channel: ChatChannel) =>
    channel.name === DEFAULT_CHANNEL ? 0 : isPrivateChannel(channel.name) ? 2 : 1;
  return [...channels].sort(
    (a, b) => rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

/**
 * Roster order: case-insensitive by name. Twin of `sort_users`.
 *
 * The key once per user, not twice per comparison, and code-unit comparison
 * rather than `localeCompare`, which matches Rust's `String::cmp` and skips the
 * collator entirely. Measured on a 1500 user channel, which is what `#aeolus`
 * is: 4.4ms per resort before, 0.67ms after.
 */
const sortUsers = (users: ChatUser[]): ChatUser[] => {
  const keyed = users.map((user) => ({ key: user.name.toLowerCase(), user }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return keyed.map((entry) => entry.user);
};

/**
 * Put `user` in an already sorted roster. Twin of `insert_user`.
 *
 * Past every entry whose key compares less or equal, which is where a push
 * followed by a stable sort would have left it: identical order, but a join in
 * a busy channel costs a binary search instead of a full resort. That resort
 * was the client's most expensive routine while `#aeolus` was open, running
 * once per join and once per part.
 */
const insertUser = (users: ChatUser[], user: ChatUser): ChatUser[] => {
  const key = user.name.toLowerCase();
  let low = 0;
  let high = users.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (users[mid].name.toLowerCase() <= key) low = mid + 1;
    else high = mid;
  }
  const next = users.slice();
  next.splice(low, 0, user);
  return next;
};

const emptyChannel = (name: string): ChatChannel => ({
  name,
  topic: "",
  messages: [],
  users: [],
  unread: 0,
  unreadMentions: 0,
  typing: [],
  reactions: [],
});

/** Mirrors `TYPING_TIMEOUT_SECONDS` in crates/faf-domain/src/state/chat.rs. */
export const TYPING_TIMEOUT_SECONDS = 6;

/**
 * Who is still composing in `channel` as of `now` (Unix seconds), excluding
 * `viewer`. Twin of `ChatChannel::typists_at`.
 *
 * Filtering at read time rather than expiring on a timer: the state records
 * what the server said and when, and only the reader's clock can say whether
 * that is still true.
 */
export function typistsAt(channel: ChatChannel, now: number, viewer: string): string[] {
  return (channel.typing ?? [])
    .filter((notice) => now - notice.atSeconds < TYPING_TIMEOUT_SECONDS)
    .filter((notice) => asciiLower(notice.nickname) !== asciiLower(viewer))
    .map((notice) => notice.nickname);
}

/** The reactions on one message. Twin of `ChatChannel::reactions_for`. */
export function reactionsFor(channel: ChatChannel, msgid: string): Reaction[] {
  return (channel.reactions ?? []).find((entry) => entry.msgid === msgid)?.entries ?? [];
}

function withChannel(state: ChatState, name: string): ChatState {
  if (state.channels.some((channel) => channel.name === name)) return state;
  const retained = state.retainedHistories.find((history) => history.channel === name);
  const restored = retained
    ? { ...emptyChannel(name), messages: retained.messages }
    : emptyChannel(name);
  return {
    ...state,
    channels: sortChannels([...state.channels, restored]),
    retainedHistories: retained
      ? state.retainedHistories.filter((history) => history.channel !== name)
      : state.retainedHistories,
  };
}

/** Update a channel, creating it first if we have not seen it before. */
function mapChannel(
  state: ChatState,
  name: string,
  update: (channel: ChatChannel) => ChatChannel,
): ChatState {
  const ensured = withChannel(state, name);
  return {
    ...ensured,
    channels: ensured.channels.map((channel) =>
      channel.name === name ? update(channel) : channel,
    ),
  };
}

/**
 * Update a channel only if it already exists.
 *
 * The twin of Rust's `channel_mut`, as opposed to `ensure_channel`. Roster
 * bookkeeping for a channel we are not in must be dropped, not treated as a
 * reason to create one: a `userLeft` that arrives just after `channelLeft`,
 * an in-flight QUIT while we were being kicked, would otherwise resurrect the
 * channel we just left as an empty ghost in the sidebar. The backend does not
 * do that, and nothing would reconcile the two until the event bus happened to
 * lag (`src-tauri` only re-sends a snapshot on `Lagged`).
 */
function mapExistingChannel(
  state: ChatState,
  name: string,
  update: (channel: ChatChannel) => ChatChannel,
): ChatState {
  if (!state.channels.some((channel) => channel.name === name)) return state;
  return {
    ...state,
    channels: state.channels.map((channel) => (channel.name === name ? update(channel) : channel)),
  };
}

export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: "connecting" };
    case "connected":
      return { ...state, status: "connected", username: event.payload.username };
    case "channelJoined": {
      const { channel } = event.payload;
      const next = withChannel(state, channel);
      const takeFocus = !next.activeChannel || channel === DEFAULT_CHANNEL;
      return takeFocus ? { ...next, activeChannel: channel } : next;
    }
    case "channelLeft": {
      const left = state.channels.find((channel) => channel.name === event.payload.channel);
      const channels = state.channels.filter((channel) => channel.name !== event.payload.channel);
      const withoutPrevious = state.retainedHistories.filter(
        (history) => history.channel !== event.payload.channel,
      );
      const retainedHistories = left && left.messages.length > 0
        ? [...withoutPrevious, { channel: left.name, messages: left.messages }].slice(
            -MAX_RETAINED_HISTORIES,
          )
        : withoutPrevious;
      const activeChannel =
        state.activeChannel === event.payload.channel
          ? (channels[0]?.name ?? "")
          : state.activeChannel;
      return { ...state, channels, retainedHistories, activeChannel };
    }
    case "channelSelected": {
      const { channel } = event.payload;
      if (!state.channels.some((candidate) => candidate.name === channel)) return state;
      return {
        ...state,
        activeChannel: channel,
        channels: state.channels.map((candidate) =>
          candidate.name === channel ? { ...candidate, unread: 0, unreadMentions: 0 } : candidate,
        ),
      };
    }
    case "topicChanged":
      return mapChannel(state, event.payload.channel, (channel) => ({
        ...channel,
        topic: event.payload.topic,
      }));
    case "messageReceived": {
      const { channel, message } = event.payload;
      const isActive = state.activeChannel === channel;
      return mapChannel(state, channel, (current) => {
        const messages = [...current.messages, message].slice(-MAX_MESSAGES);
        // Sending is the loudest possible "done typing". Waiting for the
        // sender's own `done` would leave the indicator up for every client
        // that never sends one, which is most of them.
        const typing = (current.typing ?? []).filter(
          (notice) => asciiLower(notice.nickname) !== asciiLower(message.sender),
        );
        const counts =
          !isActive &&
          message.sender !== state.username &&
          message.kind !== "info" &&
          message.kind !== "error";
        if (!counts) return { ...current, messages, typing };
        const loud = isPrivateChannel(current.name) || mentions(message.content, state.username);
        return {
          ...current,
          messages,
          typing,
          unread: current.unread + 1,
          unreadMentions: current.unreadMentions + (loud ? 1 : 0),
        };
      });
    }
    case "messageReceivedQuietly": {
      const { channel, message } = event.payload;
      return mapChannel(state, channel, (current) => ({
        ...current,
        messages: [...current.messages, message].slice(-MAX_MESSAGES),
      }));
    }
    case "usersUpdated":
      return mapChannel(state, event.payload.channel, (channel) => ({
        ...channel,
        users: sortUsers(event.payload.users),
      }));
    case "userJoined":
      return mapChannel(state, event.payload.channel, (channel) => {
        const { user } = event.payload;
        const known = channel.users.some((candidate) => candidate.name === user.name);
        return {
          ...channel,
          users: known
            ? channel.users.map((candidate) => (candidate.name === user.name ? user : candidate))
            : insertUser(channel.users, user),
        };
      });
    case "userLeft":
      return mapExistingChannel(state, event.payload.channel, (channel) => ({
        ...channel,
        users: channel.users.filter((user) => user.name !== event.payload.user),
      }));
    case "userElevationChanged":
      return mapExistingChannel(state, event.payload.channel, (channel) => ({
        ...channel,
        users: channel.users.map((user) =>
          user.name === event.payload.user
            ? { ...user, elevation: event.payload.elevation }
            : user,
        ),
      }));
    case "userRenamed": {
      const { oldName, newName } = event.payload;
      return {
        ...state,
        username: state.username === oldName ? newName : state.username,
        channels: state.channels.map((channel) => {
          // Out and back in rather than renamed in place and resorted: the new
          // name belongs somewhere else in the order, and that is one binary
          // search rather than a pass over the whole roster.
          const renamed = channel.users.find((user) => user.name === oldName);
          if (!renamed) return channel;
          return {
            ...channel,
            users: insertUser(
              channel.users.filter((user) => user.name !== oldName),
              { ...renamed, name: newName },
            ),
          };
        }),
      };
    }
    case "joinsPartsToggled":
      return { ...state, showJoinsParts: event.payload.enabled };
    case "autoJoinAnnounced":
      return { ...state, serverAutoJoin: normalizeChannels(event.payload.channels) };
    case "typingChanged": {
      const { channel, nickname, composing, atSeconds } = event.payload;
      // Only an existing channel: a notice for one we are not in has nowhere
      // to live, and creating a channel from it would invent membership.
      if (!state.channels.some((c) => c.name === channel)) return state;
      return mapChannel(state, channel, (current) => {
        const kept = (current.typing ?? [])
          .filter((notice) => asciiLower(notice.nickname) !== asciiLower(nickname))
          // Anything already aged out goes while we are here, so an abandoned
          // notice cannot outlive the next event in the channel.
          .filter((notice) => atSeconds - notice.atSeconds < TYPING_TIMEOUT_SECONDS);
        return {
          ...current,
          typing: composing ? [...kept, { nickname, atSeconds }] : kept,
        };
      });
    }
    case "reactionRemoved": {
      const { channel, msgid, emoji, sender } = event.payload;
      if (!state.channels.some((c) => c.name === channel)) return state;
      return mapChannel(state, channel, (current) => {
        const reactions = (current.reactions ?? [])
          .map((entry) => {
            if (entry.msgid !== msgid) return entry;
            return {
              ...entry,
              entries: entry.entries
                .map((reaction) =>
                  reaction.emoji === emoji
                    ? {
                        ...reaction,
                        senders: reaction.senders.filter(
                          (s) => asciiLower(s) !== asciiLower(sender),
                        ),
                      }
                    : reaction,
                )
                // An emoji nobody stands behind is not a zero, it is gone.
                .filter((reaction) => reaction.senders.length > 0),
            };
          })
          .filter((entry) => entry.entries.length > 0);
        return { ...current, reactions };
      });
    }
    case "reactionReceived": {
      const { channel, msgid, emoji, sender } = event.payload;
      // A reaction with no anchor cannot be placed against a message.
      if (msgid === "") return state;
      if (!state.channels.some((c) => c.name === channel)) return state;
      return mapChannel(state, channel, (current) => {
        const reactions = current.reactions ?? [];
        const existing = reactions.find((entry) => entry.msgid === msgid);
        const entries = existing ? existing.entries : [];
        const reaction = entries.find((entry) => entry.emoji === emoji);
        // The draft spec defines no retraction, so a repeat is a duplicate to
        // swallow rather than a toggle to honour.
        const alreadyReacted = reaction?.senders.some((s) => asciiLower(s) === asciiLower(sender));
        const nextEntries = reaction
          ? entries.map((entry) =>
              entry.emoji === emoji && !alreadyReacted
                ? { ...entry, senders: [...entry.senders, sender] }
                : entry,
            )
          : [...entries, { emoji, senders: [sender] }];
        const next = { msgid, entries: nextEntries };
        return {
          ...current,
          reactions: existing
            ? reactions.map((entry) => (entry.msgid === msgid ? next : entry))
            : [...reactions, next],
        };
      });
    }
    case "disconnected":
      return {
        ...state,
        status: "disconnected",
        channels: state.channels.map((channel) => ({ ...channel, users: [] })),
      };
  }
}
