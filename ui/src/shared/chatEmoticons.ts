// Wire aliases from the Java client's emoticon catalogue. Keep reactions in
// their original wire spelling, and render their meaning without embedding SVG.
const GROUPS: readonly [string, ...string[]][] = [
  ["🙂", ":)", "=)", ":slightly_smiling_face:"], ["😀", ":D", ":grinning:"],
  ["😃", ":smiley:"], ["😄", ":smile:"], ["😆", ":laughing:"], ["🤣", ":rofl:"],
  ["😉", ":wink:"], ["😘", ":kissing_heart:"], ["😛", ":stuck_out_tongue:"],
  ["🤔", ":thinking:"], ["😐", ":neutral_face:"], ["😔", ":pensive:"],
  ["😕", ":confused:"], ["🙁", ":(", "=(", ":slightly_frowning_face:"],
  ["😠", ":angry:"], ["❤️", ":heart:"], ["👍", ":+1:", ":thumbsup:"],
  ["👎", ":-1:", ":thumbsdown:"], ["😇", ":innocent:"], ["🥲", ":smiling_face_with_tear:"],
  ["🤫", ":shushing_face:"], ["🤨", ":raised_eyebrow:"], ["😏", ":smirk:"],
  ["😌", ":relieved:"], ["😵‍💫", ":face_with_spiral_eyes:"], ["🥳", ":partying_face:"],
  ["😎", ":sunglasses:"], ["😭", ":sob:"], ["😱", ":scream:"], ["😖", ":confounded:"],
  ["😩", ":weary:"], ["😤", ":triumph:"], ["🤬", ":cursing_face:"],
];

const GLYPHS = new Map(GROUPS.flatMap(([glyph, ...aliases]) => aliases.map((alias) => [alias, glyph] as const)));
const FACTIONS: Readonly<Record<string, number>> = { ":uef:": 1, ":aeon:": 2, ":cybran:": 3, ":seraphim:": 4 };

export const QUICK_REACTIONS = [":+1:", ":rofl:", ":heart:", ":thinking:", ":sunglasses:", ":weary:", ":uef:", ":cybran:", ":aeon:", ":seraphim:"] as const;
export const reactionGlyph = (value: string): string => GLYPHS.get(value) ?? value;
export const reactionFaction = (value: string): number | undefined => FACTIONS[value];
