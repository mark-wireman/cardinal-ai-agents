import { indexRepo } from "./indexer.js";

const force = process.argv.includes("--force");

indexRepo(force)
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`Indexing failed: ${err?.message ?? err}\n`);
    process.exit(1);
  });
