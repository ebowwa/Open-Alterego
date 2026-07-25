import { makeApp } from "./app";
import { loadConfig } from "./config";
import { CollectDb } from "./db";
import { makeAwsPresigner } from "./r2";
import { loadPromptSet } from "./prompts";

const config = loadConfig();

if (!config.relayToken) {
  console.error("fatal: ALTEREGO_RELAY_TOKEN is required");
  process.exit(1);
}

const db = new CollectDb(config.dbPath);
const promptSet = loadPromptSet(config.promptRev);
const presigner = makeAwsPresigner(config.r2);
const app = makeApp({ config, db, presigner, promptSet });

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  fetch: app.fetch,
});

console.log(
  `alterego-collect on http://${config.hostname}:${server.port} ` +
    `(prompts rev ${promptSet.prompt_rev}, ${promptSet.prompts.length} prompts)`,
);

process.on("SIGTERM", () => {
  server.stop(true);
  db.close();
  process.exit(0);
});
