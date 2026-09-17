#!/usr/bin/env node
import { readRecordedEvents } from "./record-event.mjs";
import { collectInteractions } from "./contract.mjs";

const root = process.argv[2];
if (typeof root !== "string") {
  console.error("usage: node report.mjs <collector-directory>");
  process.exitCode = 2;
} else {
  const result = collectInteractions(await readRecordedEvents(root));
  const reasons = Object.groupBy(result.failures, (failure) => failure.reason ?? "rejected");
  // Summaries intentionally omit prompt and response bodies.
  console.log(
    JSON.stringify({
      interactions: result.interactions.length,
      failures: result.failures.length,
      failure_reasons: Object.fromEntries(
        Object.entries(reasons).map(([reason, values]) => [reason, values.length]),
      ),
    }),
  );
}
