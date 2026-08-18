# FAForever Client: design philosophy

v1 · July 2026

> **I know where everything is.**

The FAForever client is a precision instrument for people who spend thousands of hours in it.
Every design decision is measured against one sentence: **the user must never have to guess where
something is, what it means, or what happens next.**

---

## 1. North star and order of priorities

The client's target feeling is **precision**: orientation without searching, action without
hesitation. Not calm as emptiness, but calm as the absence of noise. The client combines the UX
substance of the Java client with the performance of the Python client, and beats both on clarity.

When two goals collide, this ranking decides. It is absolute: a lower rank may never make a higher
one worse.

| Rank | Goal | The question |
|---|---|---|
| 1 | **Function** | Can the user get their task done? |
| 2 | **Legibility** | Do they understand the screen in under a second? |
| 3 | **Performance** | Does everything respond at once, and does running in the background cost nothing? |
| 4 | **Calm** | Is everything visible necessary? Is nothing shouting? |
| 5 | **Aesthetics** | Only once 1 to 4 hold do we go for maximum quality. |

"Luxurious" is not a style in this client, it is a by-product. It comes out of precision: exact
alignment, consistent typography, disciplined colour. Not out of decoration.

---

## 2. The nine principles

### P1. Function beats aesthetics

No visual effect may make legibility, hit area, response time or legibility worse. Beauty that
costs usability is discarded, without discussion.

**Test:** does any user complete any task more slowly because of this change? Then it is wrong, no
matter how good it looks.

### P2. Spatial stability

Every function has a fixed place that never moves. All tabs are always visible: spatial stability
beats tidiness. No element appears, disappears or shifts without the user doing something. Muscle
memory is a feature.

**Test:** could a regular user hit this target blind? Does the click point stay in the same place
in every state (empty, full, loading, error)?

**Deliberate exception:** live lists (open games) always show the freshest state, even when rows
jump. Owner decision, consistent with the Java client. The safeguard: a click is always validated
against the row's game id, never against its position. A misclick caused by a jumping row has to be
technically impossible.

### P3. Two densities: a calm frame, dense content

Navigation, title bar, headers and detail views breathe: generous negative space orients the user
before they read. Lists and tables (games, replays, vault, leaderboard) are compact and scannable,
because power users scan rather than read. White space is a hierarchy tool, never an end in itself.

**Test:** frame, can you make out the structure of the screen with your eyes squinted? Content, can
you see at least 15 to 20 rows of a list without scrolling (at 1080p)?

### P4. Colour is semantics, never decoration

Greyscale carries the entire structure. Orange `#FF8C00` means exactly one thing, "this is the way
forward": primary actions, active states, links, focus. Red is errors and nothing else. Green is
online or ready and nothing else. A colour that means nothing does not appear.

**Test:** can you say what every coloured pixel means? Does the screen work completely in greyscale
(colour blindness)?

### P5. Depth is focus

The base state is flat: one plane, surface steps and hairline rules instead of shadows. The only
real depth layer is an overlay for a task that demands focus right now (hosting a lobby, uploading
a map, a critical error): background dimmed, one task, one way out. Critical errors **always**
appear as an overlay, so the layer itself says "important" rather than the colour alone. That is
also the safeguard for colour blindness.

**Test:** are there ever more than two layers at once? Can every overlay be closed with Escape
(except critical errors with an explicit action)?

### P6. Performance is a design material

The client runs for hours in the background while the game needs every resource. Targets: cold
start under 2 s to usable, feedback under 100 ms for every interaction, near-zero CPU and GPU load
in the background. Animations may be decorative, but never blocking, never in front of an input,
always interruptible, cheap on the GPU (transform and opacity only) and paused in the background.

**Test:** does the user ever wait for an animation? Does anything move while the window is
unfocused?

### P7. State is visible, language is terse

System state (connection, login, running game) can be read at a fixed place at any time: the user
must never have to check whether "everything still works". When something takes time, the skeleton
of the screen is there immediately (filters, sorting, structure) and only the content loads, with a
restrained animation. All text is terse and technically precise: state plus way out, never
apologetic prose. The UI language is English.

**Test:** does every error message answer, in one sentence, what happened and what to do now? Does
the layout stay put while loading?

### P8. Opinionated core, configurable behaviour

Structure, hierarchy, places and density are decisions of the design: not configurable. Behaviour
belongs to the user: notifications, sorting, column choice, sounds. That keeps every FAForever
client recognisable (streams, support, screenshots) without patronising the power user.

**Test:** does the option change WHERE something is or HOW it looks? Then it does not belong in
settings. Does it change WHEN and WHETHER something happens? Then it does.

### P9. Growth in depth, not in width

The skeleton of tabs is fixed and capped. New capabilities become depth inside existing tabs:
ladder views in the games tab, clickable player names with a detail panel in the leaderboard,
filters and sorting everywhere following the same grammar. A new top-level tab has to prove the
function belongs in no existing place. That makes the Java client's sprawl of vault filters
structurally impossible: **one** filter and sort grammar for every list in the whole client.

**Test:** does the new feature use the existing list, filter and detail grammar? If it invents a
new interaction: why can the other ten screens not use it too?

---

## 3. Derivations

Concrete rules that follow directly from the principles. They bind the design system, not
individual screens.

### Colour

| Token | Meaning |
|---|---|
| **Greyscale ramp** | carries 100 % of the structure: surfaces, lines, text hierarchy through white alpha |
| **Accent `#FF8C00`** | "the way forward": primary action, active state, link, focus. Nothing else |
| **Error `#FF5B5B`** | errors only; critical errors additionally as an overlay (P5) |
| **OK `#2ECC8F`** | online / ready / connected. Status, never action |
| **Warnings** | have no colour of their own: icon plus precise text, and a border if needed. Orange is taken as the accent and may never mean "caution" |

### Typography

One typeface: **Geist** (OFL-licensed and therefore contributor-safe; Suisse Int'l is out on
licence, Inter on being unremarkable). Weights 400/500/600. All numbers in data contexts use
`tabular-nums`, so ratings, times and player counts line up exactly in lists. Hierarchy comes from
size, weight and opacity, never from additional typefaces.

| Size / weight | Use |
|---|---|
| 28 / 600 | screen title |
| 18 / 600 | section or card |
| 15 / 400 | body text, forms |
| 14 / 400 | list rows (dense content) |
| 13 / 500 | LABELS, COLUMN HEADS, META |

### Space and form

- A 4 px grid, scale 4 / 8 / 12 / 16 / 24 / 32 / 48. No value outside the scale.
- Two density contexts (P3): the **frame** uses 16 to 48, **lists** use 4 to 12 with row heights of
  32 to 40 px.
- Radius 3 to 4 px everywhere: technical, not friendly-round. Hairline borders (white alpha 8 to
  14 %) instead of shadows.
- Alignment is absolute: everything sits on shared sight lines. A column that is off by 1 px is a
  bug.

### Motion

- State changes 100 to 150 ms, overlays 180 to 220 ms, ease-out. Nothing longer.
- Feedback comes **before** the animation: the new state is valid immediately, the movement only
  explains it.
- Decorative motion is allowed (P6): transform and opacity only, only while the window is focused,
  and it respects `prefers-reduced-motion`.
- Microinteractions confirm precision: hover shows interactivity in 50 ms or less, pressed states
  are palpable, success is visible without a toast.

### Icons

- One style only: line icons, uniform stroke width (1.5 px), monochrome in the text colour around
  them.
- Always with a label in navigation: an icon alone never carries meaning (legibility beats space).
- Icons follow the colour semantics: orange only when active or actionable, red only on error.

### States and language

Every view defines four states before it counts as finished: loaded, loading, empty, error.

- **Loading:** the structure (filters, columns, sorting) is there at once and usable; the content
  area shows a restrained loading animation. Under roughly 300 ms nothing is shown at all.
- **Empty:** one sentence and one action. No illustration theatre.
- **Error:** state plus way out in one sentence, terse and technical.

| Not this | But this |
|---|---|
| "Oops! Something went wrong :( Please try again later." | Connection lost. **Reconnect** |
| "Looks like there are no replays here yet!" | No replays match these filters. **Clear filters** |

### Window and platform

- A custom title bar (the Discord/Steam category), carrying connection status and identity.
  Condition: native window behaviour, snap, drag, double-click to maximise, stays 100 % intact,
  otherwise back to native.
- Desktop first: right-click context menus, hover states, multi-select and drag and drop are
  expected tools, not extras.
- Full keyboard operability is declared debt, not a blocker: focus rings (orange, P4) are built in
  from the start so that it costs nothing later.

---

## 4. The decision checklist

Every UI decision, whether a new feature, a new component or a redesign, has to pass all eight
questions. One "no" means back to the drawing board.

| # | Question | Principle |
|---|---|---|
| 1 | Does this make any task slower? | P1 |
| 2 | Does anything move that the user expects blind? | P2 |
| 3 | Is it frame (breathes) or content (dense), and does it behave that way? | P3 |
| 4 | Does every coloured pixel mean something? | P4 |
| 5 | Does it really need a new layer, or will the surface do? | P5 |
| 6 | Does feedback stay under 100 ms and background load at zero? | P6 |
| 7 | Are all four states defined, and is every text state plus way out? | P7 |
| 8 | Does it use the existing grammar (lists, filters, details) rather than a new one? | P8/P9 |

---

## 5. Deliberate exceptions and open points

- **Live list freshness** contradicts P2 and is documented as an owner decision. Condition:
  click-validated game ids. To be reviewed after real user testing.
- **Final typeface:** Geist is set as the recommendation; Inter stays as an alternative.
- **Notification defaults:** configurable is decided (P8). The default matrix (what is on out of
  the box?) is decided with the chat feature. Proposal: quiet by default, everything off while a
  game is running.
- **forgeLight and legacy themes** are out of scope. P1 to P3 and P5 to P9 apply across themes;
  P4 (colour semantics) is reassigned per theme.
- **Contributor and dev surfaces** follow the same rules: there is no "internal second-class UI".
