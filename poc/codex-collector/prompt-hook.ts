#!/usr/bin/env -S node --experimental-strip-types
import { runHookReceiver } from "./receiver.ts";

process.exitCode = await runHookReceiver("UserPromptSubmit");
