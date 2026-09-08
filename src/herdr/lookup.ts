import type { HerdrClient } from "@j1nn0/herdr-plugin-sdk";
import { isHerdrCliError } from "@j1nn0/herdr-plugin-sdk";
import { agentTargetInfo, paneTargetInfo } from "./adapt.ts";
import type { HerdrTargetInfo } from "./types.ts";

export async function getAgentInfo(
  client: HerdrClient,
  target: string,
): Promise<HerdrTargetInfo | null> {
  try {
    return agentTargetInfo(await client.agent.get(target));
  } catch (error) {
    if (isHerdrCliError(error, "agent_not_found")) {
      return null;
    }
    throw error;
  }
}

export async function getPaneInfo(
  client: HerdrClient,
  paneId: string,
): Promise<HerdrTargetInfo | null> {
  try {
    return paneTargetInfo(await client.pane.get(paneId));
  } catch (error) {
    if (isHerdrCliError(error, "pane_not_found")) {
      return null;
    }
    throw error;
  }
}
