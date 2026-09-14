import { publishRuntimeLocator } from "../runtime/locator.ts";

// Runs once for each enabled plugin after Herdr restores its session and API
// socket; the event hook refreshes the same locator on every event. Publication
// is best effort and this command must always exit zero, so a missing
// prerequisite or an unwritable config directory cannot break plugin
// registration. The single report line states the published path or the reason
// publication was skipped.
const publication = publishRuntimeLocator(process.env);

if (publication.published) {
  process.stdout.write(
    `Harvest runtime locator published: ${publication.path ?? "(unknown path)"}\n`,
  );
} else {
  process.stderr.write(
    `Harvest runtime locator not published: ${publication.reason ?? "unknown reason"}\n`,
  );
}

process.exitCode = 0;
