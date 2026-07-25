/**
 * Generate the versioned prompt set for personalization data collection.
 *
 * Run:  bun cloud/relay/prompts/generate.ts [--count N] [--rev YYYY-MM-DD]
 * Writes: cloud/relay/prompts/rev<rev>.json
 *
 * Prompts are ASCII, letters + spaces only (digits spelled out), so they
 * tokenize cleanly through the Auto-AVSR SentencePiece vocab after
 * `prepare_dataset.py` uppercases them. Output order is deterministic (seeded
 * shuffle) so the same rev reproduces byte-for-byte.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REV_DEFAULT = "2026-07-25";

// --- curated pools -----------------------------------------------------------
const GREETINGS = [
  "hey how is everyone today",
  "good morning what is on the agenda",
  "hello there nice to see you",
  "hey did you sleep well",
  "good afternoon let us get started",
  "what is up my friend",
  "long time no see how have you been",
  "hey welcome back",
  "good evening everyone",
  "howdy partner how goes it",
  "morning sunshine ready to go",
  "hey there thanks for coming",
];

const SOCIAL = [
  "i had a really good day",
  "the weather is nice today",
  "let us grab lunch soon",
  "can you believe it is already july",
  "i am feeling great today",
  "that movie was so good",
  "we should hang out this weekend",
  "thank you so much for the help",
  "i really appreciate it",
  "sorry i am running a few minutes late",
  "it was nice talking to you",
  "let me know what you think",
  "i could not agree more",
  "that sounds like a plan",
  "we will figure it out together",
  "i am excited about this",
  "that is a great idea",
  "no worries at all",
  "sounds good to me",
  "talk to you later",
];

const COMMANDS = [
  "set a timer for ten minutes",
  "remind me to call mom at noon",
  "play some focus music",
  "turn the volume down a little",
  "pause the video please",
  "skip to the next song",
  "send a text to alex",
  "open my calendar",
  "start a new note",
  "turn off the living room light",
  "set an alarm for six am",
  "navigate home",
  "call my brother on speaker",
  "read my last message",
  "take a photo",
  "start recording",
  "stop recording now",
  "mute the microphone",
  "share my location with sam",
  "add milk to the grocery list",
  "what is on my schedule today",
  "show me my reminders",
  "translate that to spanish",
  "set the thermostat to seventy",
  "lock the front door",
  "dim the lights to fifty percent",
  "shuffle my workout playlist",
  "mark this task as done",
  "create a meeting for tomorrow at two",
  "find my keys",
];

const QUESTIONS = [
  "what time is my next meeting",
  "how long will it take to get there",
  "where did i leave my phone",
  "who won the game last night",
  "when does the store close",
  "what is the weather like tomorrow",
  "how much does this cost",
  "can you check the mail",
  "do you know the wifi password",
  "what is the capital of texas",
  "how many calories in an apple",
  "where is the nearest coffee shop",
  "what day is it",
  "how are you doing",
  "is it going to rain later",
  "what should we have for dinner",
  "can we reschedule our call",
  "where are my glasses",
  "what time does the movie start",
  "how do i get to the airport",
];

const STATEMENTS = [
  "the build is green and deployed",
  "i will send the file after lunch",
  "the package arrives on friday",
  "we finished the report on time",
  "the server is back online",
  "i updated the document this morning",
  "the test failed on the new branch",
  "we merged the pull request",
  "the deploy took about five minutes",
  "i fixed the bug in the parser",
  "the model trained overnight",
  "we need more training data",
  "accuracy improved by three percent",
  "the cache cleared successfully",
  "i pushed the code to main",
  "the database backup is done",
  "we shipped the new release",
  "the meeting moved to thursday",
  "i reordered the queue",
  "the logs show no errors",
];

// phonetically loaded / varied mouth shapes
const PHONETIC = [
  "she sells sea shells by the seashore",
  "red lorry yellow lorry",
  "unique new york",
  "toy boat toy boat toy boat",
  "irish wristwatch",
  "the sixth sheikhs sixth sheep is sick",
  "five frantic frogs fled from the furies",
  "betty bought a bit of butter",
  "peter piper picked a peck of pickled peppers",
  "how much wood would a woodchuck chuck",
  "strict strong steve stretches stiff strings",
  "the quick brown fox jumps over the lazy dog",
  "crazy kittens crave cold creamy cake",
  "seven serious scientists study space",
  "thirty three thirsty thieves",
  "mixed biscuits mixed biscuits",
  "a proper cup of coffee from a proper copper pot",
  "eleven benevolent elephants",
  "truly rural truly rural",
  "ed had edited it",
];

// numbers spelled out — strong lipreading signal
const NUMBERS = [
  "one two three four five",
  "two four six eight ten",
  "three five seven nine eleven",
  "the code is seven three nine two",
  "my pin is four zero eight one",
  "count down from ten to one",
  "add five and seven",
  "multiply three by four",
  "the year is twenty twenty six",
  "ten twenty thirty forty fifty",
  "one hundred and twenty five",
  "call five five five zero one two three",
  "the temperature is sixty eight degrees",
  "channel eight is on",
  "give me two percent more",
];

const POOLS = [
  ...GREETINGS,
  ...SOCIAL,
  ...COMMANDS,
  ...QUESTIONS,
  ...STATEMENTS,
  ...PHONETIC,
  ...NUMBERS,
];

// --- templated generators (broaden to a large unique set) -------------------
const NAMES = ["alex", "sam", "jordan", "taylor", "morgan", "casey", "riley", "jamie"];
const TIMES = ["nine am", "noon", "three pm", "five thirty", "eight", "ten fifteen", "two forty five", "seven pm"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const VERBS = ["call", "email", "text", "message", "ping", "remind", "thank", "follow up with"];
const ITEMS = ["milk", "bread", "eggs", "coffee", "paper towels", "batteries", "soap", "rice"];
const SUBJECTS = [
  "the report", "the invoice", "the design", "the deploy", "the meeting notes",
  "the dataset", "the pull request", "the bug fix", "the release notes", "the contract",
];
const ACTIONS = [
  "is ready for review", "needs another pass", "looks good to me", "is blocked on testing",
  "was approved today", "is on hold", "shipped this morning", "failed in ci",
  "needs your sign off", "is scheduled for friday",
];

function templates(): string[] {
  const out: string[] = [];
  for (const v of VERBS) for (const n of NAMES) out.push(`${v} ${n} about the update`);
  for (const t of TIMES) out.push(`set an alarm for ${t}`);
  for (const t of TIMES) for (const d of DAYS) out.push(`remind me on ${d} at ${t}`);
  for (const i of ITEMS) out.push(`add ${i} to the list`);
  for (const s of SUBJECTS) for (const a of ACTIONS) out.push(`${s} ${a}`);
  for (const n of NAMES) out.push(`send ${n} the latest numbers`);
  for (const n of NAMES) out.push(`tell ${n} i will be late`);
  for (const d of DAYS) out.push(`let us sync on ${d}`);
  return out;
}

// --- sanitize + dedupe ------------------------------------------------------
function clean(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = () => {
    // mulberry32
    s |= 0;
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

// --- main -------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const COUNT = Number(arg("count", "300"));
const REV = arg("rev", REV_DEFAULT);
const SEED = Number(arg("seed", "20260725"));

const seen = new Set<string>();
const unique: string[] = [];
for (const raw of [...POOLS, ...templates()]) {
  const c = clean(raw);
  if (c && c.split(" ").length <= 12 && !seen.has(c)) {
    seen.add(c);
    unique.push(c);
  }
}

const picked = seededShuffle(unique, SEED).slice(0, COUNT);
const prompts = picked.map((text, i) => ({
  prompt_id: `p${String(i + 1).padStart(4, "0")}`,
  text,
}));

const doc = { prompt_rev: REV, count: prompts.length, prompts };
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, `rev${REV}.json`);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");

const byWords: Record<string, number> = {};
for (const p of prompts) byWords[String(p.text.split(" ").length)] = (byWords[String(p.text.split(" ").length)] ?? 0) + 1;
console.log(`wrote ${outPath}`);
console.log(`  rev=${REV} prompts=${prompts.length} (unique_pool=${unique.length})`);
console.log(`  length distribution: ${JSON.stringify(byWords)}`);
