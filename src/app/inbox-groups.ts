import type { OrchestrationRole } from "../domain/orchestration.ts";
import type { AgentSessionKind } from "../domain/result.ts";
import type { InboxItem } from "./inbox-service.ts";

/** A header for all visible results claimed by one orchestration task. */
export interface OrchestrationHeader {
  kind: "orchestration";
  orchestrationId: string;
  orchestrationLabel: string | null;
  orchestrationRole: OrchestrationRole | null;
  /** Number of visible results in this orchestration. */
  count: number;
}

/** A header for one native agent session within an orchestration. */
export interface AgentSessionHeader {
  kind: "agent-session";
  agentSessionKind: AgentSessionKind | null;
  agentSessionValue: string | null;
  sessionShortId: string;
  /** Number of visible results in this session subgroup. */
  count: number;
}

/** A result item that is ready for a later view layer to render. */
export interface ResultRow {
  kind: "result";
  item: InboxItem;
}

/** The flat display rows consumed by a later inbox view. */
export type InboxDisplayRow = OrchestrationHeader | AgentSessionHeader | ResultRow;

export type InboxGrouping = InboxDisplayRow[];

interface SessionGroup {
  agentSessionKind: AgentSessionKind | null;
  agentSessionValue: string | null;
  sessionShortId: string;
  items: InboxItem[];
}

interface OrchestrationGroup {
  orchestrationId: string;
  orchestrationLabel: string | null;
  orchestrationRole: OrchestrationRole | null;
  sessions: SessionGroup[];
  sessionsByKind: Map<AgentSessionKind, Map<string, SessionGroup>>;
}

type TopLevelEntry =
  | { kind: "standalone"; row: ResultRow }
  | { kind: "orchestration"; group: OrchestrationGroup };

/**
 * Groups the visible inbox subset without changing item order within a group.
 * Orchestrations and their session subgroups are ordered by first occurrence;
 * results without an orchestration remain standalone rows.
 */
export function buildInboxGrouping(items: readonly InboxItem[]): InboxGrouping {
  const entries: TopLevelEntry[] = [];
  const orchestrations = new Map<string, OrchestrationGroup>();

  for (const item of items) {
    if (item.orchestrationId === null) {
      entries.push({ kind: "standalone", row: { kind: "result", item } });
      continue;
    }

    let group = orchestrations.get(item.orchestrationId);
    if (group === undefined) {
      group = createOrchestrationGroup(item);
      orchestrations.set(item.orchestrationId, group);
      entries.push({ kind: "orchestration", group });
    } else if (group.orchestrationRole === null && item.orchestrationRole !== null) {
      group.orchestrationRole = item.orchestrationRole;
    }

    addToSessionGroup(group, item);
  }

  return entries.flatMap((entry) => {
    if (entry.kind === "standalone") {
      return [entry.row];
    }
    return flattenOrchestrationGroup(entry.group);
  });
}

function createOrchestrationGroup(item: InboxItem): OrchestrationGroup {
  return {
    orchestrationId: item.orchestrationId as string,
    orchestrationLabel: item.orchestrationLabel,
    orchestrationRole: item.orchestrationRole,
    sessions: [],
    sessionsByKind: new Map(),
  };
}

function addToSessionGroup(group: OrchestrationGroup, item: InboxItem): void {
  const { agentSessionKind: kind, agentSessionValue: value } = item;
  if (kind === null || value === null || value.length === 0) {
    const session = createSessionGroup(item);
    group.sessions.push(session);
    session.items.push(item);
    return;
  }

  let sessionsByValue = group.sessionsByKind.get(kind);
  if (sessionsByValue === undefined) {
    sessionsByValue = new Map();
    group.sessionsByKind.set(kind, sessionsByValue);
  }

  let session = sessionsByValue.get(value);
  if (session === undefined) {
    session = createSessionGroup(item);
    sessionsByValue.set(value, session);
    group.sessions.push(session);
  }
  session.items.push(item);
}

function createSessionGroup(item: InboxItem): SessionGroup {
  return {
    agentSessionKind: item.agentSessionKind,
    agentSessionValue: item.agentSessionValue,
    sessionShortId: item.sessionShortId,
    items: [],
  };
}

function flattenOrchestrationGroup(group: OrchestrationGroup): InboxDisplayRow[] {
  const rows: InboxDisplayRow[] = [
    {
      kind: "orchestration",
      orchestrationId: group.orchestrationId,
      orchestrationLabel: group.orchestrationLabel,
      orchestrationRole: group.orchestrationRole,
      count: group.sessions.reduce((total, session) => total + session.items.length, 0),
    },
  ];

  for (const session of group.sessions) {
    rows.push({
      kind: "agent-session",
      agentSessionKind: session.agentSessionKind,
      agentSessionValue: session.agentSessionValue,
      sessionShortId: session.sessionShortId,
      count: session.items.length,
    });
    rows.push(...session.items.map((item): ResultRow => ({ kind: "result", item })));
  }

  return rows;
}
