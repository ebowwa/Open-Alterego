import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Prompt {
  prompt_id: string;
  text: string;
}
export interface PromptSet {
  prompt_rev: string;
  count?: number;
  prompts: Prompt[];
}

const here = dirname(fileURLToPath(import.meta.url)); // .../cloud/relay/src
const promptsDir = resolve(here, "..", "prompts");

export function loadPromptSet(rev?: string): PromptSet {
  let file: string;
  if (rev) {
    file = join(promptsDir, `rev${rev}.json`);
  } else {
    const files = readdirSync(promptsDir).filter((f) => /^rev.+\.json$/.test(f)).sort();
    if (files.length === 0) throw new Error(`no prompt files found in ${promptsDir}`);
    file = join(promptsDir, files[files.length - 1]);
  }
  return JSON.parse(readFileSync(file, "utf8")) as PromptSet;
}
