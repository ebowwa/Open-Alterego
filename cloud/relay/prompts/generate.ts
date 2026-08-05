/**
 * Coverage-guaranteed prompt generator for personalization data collection.
 *
 * Run:  bun cloud/relay/prompts/generate.ts [--count N] [--rev YYYY-MM-DD] [--seed N]
 * Writes: cloud/relay/prompts/rev<rev>.json   + prints a coverage report.
 *
 * Coverage is enforced BY CONSTRUCTION, not hoped for:
 *   - Each viseme group has a dedicated pool of minimal-pair / target sentences
 *     (these are where lip-reading fails), included before any fill.
 *   - A digit pool covers spelled-out numerals and code sequences.
 *   - Hybrid vocabulary = assistant commands + general/dictation sentences.
 * Sentences are ASCII, letters + spaces only (numerals spelled out) so they
 * tokenize cleanly after prepare_dataset.py uppercases them.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REV_DEFAULT = "2026-07-25";

// ── viseme-group pools (the coverage backbone) ───────────────────────────────
// Each entry is a visible mouth-shape class with contrastive sentences.
type Tagged = { text: string; group: string };
const VIS: Record<string, string[]> = {
  bilabial: [ // p b m
    "pat bat mat", "pin bin mint", "map nap tap", "big pig mix", "cape came game",
    "pamper bumper map", "mop pop bob", "bump pump mime", "tab dab cab", "prime brime crime",
    "apple maple simple", "open up my map", "please bring more paper",
  ],
  labiodental: [ // f v
    "fan van", "fine vine", "safe save", "feel veal", "ferry very",
    "fife five", "leaf leave", "faux vault", "fibre viper", "view the photo",
    "save the file", "find my van", "five free forks",
  ],
  dental: [ // th
    "think that", "bath bathe", "thumb thump", "thin this", "worth wreath",
    "thirty thirteen", "thumb through the book", "both methods work", "thank the team",
    "path past the tree", "thaw the broth", "theater theory",
  ],
  alveolar: [ // t d n l s z
    "ten den men", "sat sad", "light night", "nod rod", "ten net",
    "daze lays", "tone lone", "star tar", "doll tall null", "least list lost",
    "send the note", "close the lid", "lesson last listed", "stony lonely",
  ],
  postalveolar: [ // sh ch j zh
    "ship chip", "wash watch", "share chair", "wish witch", "jug chuck",
    "judge fudge", "shoe chew", "measure treasure", "azure pleasure",
    "choose the shoe", "fresh peach", "watch the match",
  ],
  r_l: [ // r vs l
    "ray lay", "grass glass", "red led", "right light", "grow glow",
    "crew clue", "pray play", "pride plied", "crab club", "collect correct",
    "long song wrong", "flower lower", "light the lamp",
  ],
  velar: [ // k g ng h (low visibility)
    "cap gap", "call hall", "kite height", "coat goat", "back bag",
    "king ring", "lock log", "hung hung", "cold gold", "hack hag",
    "packing backing", "talking walking", "cut the cake",
  ],
  vowel_front: [ // i ɪ eɪ ɛ æ
    "beat bit bait bet bat", "seat sit set sat", "deed did dead dad",
    "heal hell hall", "feast fist fest fast", "peel pel pal",
    "keep the step", "send the mail", "ten red pens", "leave the lake",
  ],
  vowel_back: [ // ɑ ɔ oʊ ʊ u ʌ
    "cot caught coat cut", "not note nut", "boat boot book", "pool pull pole",
    "soothe sooth soot", "stall stole stool", "row raw rue", "code could cud",
    "home hum hall", "load loud lord",
  ],
  diphthong: [ // aɪ aʊ ɔɪ
    "my now boy", "right out toy", "fly cloud enjoy", "find house join",
    "time loud voice", "buy cow joy", "nine down choice", "ride round noise",
    "tie town oil", "mile mouth boil",
  ],
};

// ── digit / number pool ──────────────────────────────────────────────────────
const DIGITS = [
  "one two three four five", "two four six eight", "three five seven nine",
  "the code is seven three nine two", "my pin is four zero eight one",
  "count down from ten to one", "ten twenty thirty forty", "one hundred and twenty five",
  "set a timer for nine minutes", "call five five five zero one two three",
  "add two and seven", "the year is twenty twenty six", "channel eight is on",
  "half past eleven", "quarter to nine", "ten percent more", "three dozen eggs",
  "page forty two", "first second third fourth", "nine ninety nine",
  "twelve twelve twelve", "sixty seven sixty eight", "the temperature is sixty eight",
  "two thousand and twenty four", "fifty fifty split", "seventy seven",
  "dial eight zero zero", "the zip is nine four one one zero", "born in nineteen ninety",
  "one in a million", "forty acres",
];

// ── assistant command pool ───────────────────────────────────────────────────
const ASSISTANT = [
  "set a timer for ten minutes", "remind me to call mom at noon", "play some focus music",
  "turn the volume down a little", "pause the video please", "skip to the next song",
  "send a text to alex", "open my calendar", "start a new note", "turn off the living room light",
  "set an alarm for six am", "navigate home", "call my brother on speaker", "read my last message",
  "take a photo", "start recording", "stop recording now", "mute the microphone",
  "share my location with sam", "add milk to the grocery list", "what is on my schedule today",
  "show me my reminders", "translate that to spanish", "set the thermostat to seventy",
  "lock the front door", "dim the lights to fifty percent", "shuffle my workout playlist",
  "mark this task as done", "create a meeting for tomorrow at two", "find my keys",
  "send the email now", "cancel my next alarm", "play the podcast from where i left off",
  "order my usual coffee", "what is the traffic like home", "read the headline news",
  "make a grocery list", "call me an uber", "set a reminder for friday morning",
  "turn on do not disturb", "log my weight as one eighty", "start a focus session",
  "play white noise", "check the weather hourly", "add this event to my calendar",
  "text the group i am running late", "open the garage door", "find a nearby pharmacy",
  "spell the word necessary", "convert one hundred dollars to euros",
];

// ── general conversation / dictation pool ────────────────────────────────────
const GENERAL = [
  "i had a really good day", "the weather is nice today", "let us grab lunch soon",
  "can you believe it is already july", "i am feeling great today", "that movie was so good",
  "we should hang out this weekend", "thank you so much for the help", "i really appreciate it",
  "sorry i am running a few minutes late", "it was nice talking to you", "let me know what you think",
  "i could not agree more", "that sounds like a plan", "we will figure it out together",
  "i am excited about this", "that is a great idea", "no worries at all", "sounds good to me",
  "talk to you later", "the package arrives on friday", "we finished the report on time",
  "the server is back online", "i updated the document this morning", "the test failed on the new branch",
  "we merged the pull request", "i pushed the code to main", "the database backup is done",
  "we shipped the new release", "the meeting moved to thursday", "the logs show no errors",
  "i think we should pivot the strategy", "the numbers look strong this quarter", "let us revisit this next week",
  "i need more time to decide", "can you send over the slides", "the design needs another pass",
  "where did i leave my phone", "what time does the movie start", "how do i get to the airport",
  "is it going to rain later", "what should we have for dinner", "the build is green and deployed",
  "i will send the file after lunch", "accuracy improved by three percent", "the cache cleared successfully",
  "she sells sea shells by the seashore", "red lorry yellow lorry", "unique new york",
  "the quick brown fox jumps over the lazy dog", "how much wood would a woodchuck chuck",
  "peter piper picked a peck of pickled peppers", "betty bought a bit of butter",
  "eleven benevolent elephants", "a proper cup of coffee from a proper copper pot",
  "i prefer tea over coffee in the morning", "the train arrives at platform three",
  "my flight lands around seven pm", "we are meeting at the usual spot", "the dog needs a walk",
  "did you watch the game last night", "i am thinking about a career change",
  "the garden is finally blooming", "we booked the trip to the coast", "i need to renew my license",
  "the kitchen sink is leaking again", "please water the plants while i am away",
  "i will grab the tickets on my way", "the kids are asleep upstairs", "turn the music down a bit",
  "what is the wifi password", "let me check my schedule first", "i can be there in twenty minutes",
  "the report is due end of day", "we are ahead of schedule", "that feature ships next sprint",
  "i left my charger at home", "the coffee shop closes at eight", "please reply when you can",
  "i am proud of the team", "let us keep this simple", "the fix is already in review",
  "we should document the process", "i will follow up by email", "the demo went really well",
];

// ── templated expansion (grammatical verb/object/place frames) ───────────────
// Lip-reading data needs mouth-shape + vocabulary variety; semantic sense is
// secondary, so these frames generate many natural, grammatical sentences.
const VERBS2 = [
  "send", "find", "open", "check", "start", "finish", "review", "share",
  "update", "read", "write", "book", "cancel", "schedule", "fix", "build",
  "test", "deploy", "print", "sign", "download", "upload", "rename", "delete",
];
const OBJECTS2 = [
  "the report", "the email", "the file", "the invoice", "the meeting", "the ticket",
  "the contract", "the design", "the document", "the order", "the payment", "the plan",
  "the draft", "the release",
];
const PLACES = [
  "the store", "the office", "the airport", "the station", "the gym", "the park",
  "the cafe", "the hotel", "the hospital", "the school", "the library", "the garage",
];
const EVENTS = ["my flight", "the meeting", "the train", "the appointment", "the game", "the concert", "the deadline"];
const NAMES = ["alex", "sam", "jordan", "taylor", "morgan", "casey", "riley", "jamie"];
const TIMES = ["nine am", "noon", "three pm", "five thirty", "eight", "ten fifteen", "two forty five", "seven pm"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
function templates(): string[] {
  const out: string[] = [];
  const frames = [
    "i need to VERB OBJECT", "can you VERB OBJECT", "let us VERB OBJECT tomorrow",
    "i forgot to VERB OBJECT", "please VERB OBJECT now", "remind me to VERB OBJECT",
    "did you VERB OBJECT", "i have to VERB OBJECT", "help me VERB OBJECT",
    "OBJECT looks good", "VERB OBJECT for me", "where did i put OBJECT",
    "after lunch i will VERB OBJECT", "please make sure to VERB OBJECT",
    "once you VERB OBJECT let me know",
  ];
  for (const f of frames) {
    for (const v of VERBS2) {
      for (const o of OBJECTS2) out.push(f.replace("VERB", v).replace("OBJECT", o));
    }
  }
  for (const p of PLACES) {
    out.push(`where is ${p}`, `how do i get to ${p}`, `i am heading to ${p}`);
  }
  for (const e of EVENTS) out.push(`what time is ${e}`);
  for (const n of NAMES) out.push(`call ${n}`, `text ${n}`, `tell ${n} i will be late`);
  for (const t of TIMES) out.push(`set an alarm for ${t}`, `remind me at ${t}`);
  for (const d of DAYS) out.push(`what is on my calendar on ${d}`);
  return out;
}

// ── sanitize + shuffle ───────────────────────────────────────────────────────
function clean(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const COUNT = Number(arg("count", "750"));
const REV = arg("rev", REV_DEFAULT);
const SEED = Number(arg("seed", "20260725"));

// 1) Build pools with a "guaranteed" flag: viseme backbone, digits, and curated
//    pools are guaranteed to survive the count cap; templates only fill.
type Item = Tagged & { guaranteed: boolean };
const items: Item[] = [];
const pushPool = (pool: string[], group: string, guaranteed: boolean) => {
  for (const text of pool) items.push({ text, group, guaranteed });
};
for (const [group, list] of Object.entries(VIS)) pushPool(list, group, true);
pushPool(DIGITS, "digits", true);
pushPool(ASSISTANT, "assistant", true);
pushPool(GENERAL, "general", true);
pushPool(templates(), "assistant", false);

// 2) Dedupe (case-insensitive), preserve first occurrence + its guaranteed flag.
const seen = new Set<string>();
const unique: Item[] = [];
for (const t of items) {
  const c = clean(t.text);
  if (!c || c.split(" ").length > 12 || seen.has(c)) continue;
  seen.add(c);
  unique.push({ text: c, group: t.group, guaranteed: t.guaranteed });
}

// 3) Guarantee: backbone + all digits + all curated first; templates fill the rest.
const visGroups = Object.keys(VIS);
const guaranteed = unique.filter((t) => t.guaranteed);
const fill = seededShuffle(unique.filter((t) => !t.guaranteed), SEED + 1);
const remaining = Math.max(0, COUNT - guaranteed.length);
let picked: Item[] = [...guaranteed, ...fill.slice(0, remaining)];
picked = seededShuffle(picked, SEED + 2); // final mixed order

const prompts = picked.map((t, i) => ({ prompt_id: `p${String(i + 1).padStart(4, "0")}`, text: t.text }));
const doc = { prompt_rev: REV, count: prompts.length, prompts };
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, `rev${REV}.json`);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");

// ── coverage report ──────────────────────────────────────────────────────────
const groupCounts = new Map<string, number>();
const lenHist: Record<string, number> = {};
const words = new Map<string, number>();
for (const t of picked) {
  groupCounts.set(t.group, (groupCounts.get(t.group) ?? 0) + 1);
  const w = t.text.split(" ").length;
  lenHist[w] = (lenHist[w] ?? 0) + 1;
  for (const word of t.text.split(" ")) words.set(word, (words.get(word) ?? 0) + 1);
}
console.log(`wrote ${outPath}`);
console.log(`  rev=${REV}  prompts=${prompts.length}  unique_pool=${unique.length}  unique_words=${words.size}`);
console.log("  by group:");
for (const g of [...visGroups, "digits", "assistant", "general"]) {
  const n = groupCounts.get(g) ?? 0;
  const flag = visGroups.includes(g) ? (n > 0 ? "✓" : "✗ MISSING") : "";
  console.log(`    ${g.padEnd(14)} ${String(n).padStart(4)} ${flag}`);
}
console.log("  length histogram (words→count): " + Object.keys(lenHist).sort((a, b) => +a - +b).map((k) => `${k}:${lenHist[k]}`).join(" "));
console.log("  top 12 words: " + [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => `${w}(${n})`).join(" "));
