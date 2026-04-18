import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const DIFFLOOP_AUDIT_CUSTOM_TYPE = "diffloop-audit";

type DiffloopAuditBase = {
  version: 1;
  timestamp: number;
};

type DiffloopToggleAudit = DiffloopAuditBase & {
  kind: "toggle";
  enabled: boolean;
};

type DiffloopDecisionAudit = DiffloopAuditBase & {
  kind: "decision";
  action: "approve" | "deny" | "steer" | "edit";
  toolName: "write" | "edit";
  path: string;
  reason?: string;
};

type DiffloopBlockedAudit = DiffloopAuditBase & {
  kind: "blocked";
  code: string;
  toolName?: "write" | "edit";
  path?: string;
  reason: string;
};

type DiffloopRecoveryAudit = DiffloopAuditBase & {
  kind: "recovery";
  toolName: "write" | "edit";
  path: string;
  isError: boolean;
};

export type DiffloopAuditEntry = DiffloopToggleAudit | DiffloopDecisionAudit | DiffloopBlockedAudit | DiffloopRecoveryAudit;
type DiffloopAuditPayload =
  | Omit<DiffloopToggleAudit, keyof DiffloopAuditBase>
  | Omit<DiffloopDecisionAudit, keyof DiffloopAuditBase>
  | Omit<DiffloopBlockedAudit, keyof DiffloopAuditBase>
  | Omit<DiffloopRecoveryAudit, keyof DiffloopAuditBase>;

export type DiffloopAuditStats = {
  decisions: number;
  blocked: number;
  recoveries: number;
};

export function appendDiffloopAudit(pi: ExtensionAPI, entry: DiffloopAuditPayload): void {
  const api = pi as Partial<Pick<ExtensionAPI, "appendEntry">>;
  if (typeof api.appendEntry !== "function") return;

  const payload: DiffloopAuditEntry = {
    version: 1,
    timestamp: Date.now(),
    ...entry,
  } as DiffloopAuditEntry;

  try {
    api.appendEntry(DIFFLOOP_AUDIT_CUSTOM_TYPE, payload);
  } catch {
  }
}

export function readDiffloopAuditStats(ctx: ExtensionContext): DiffloopAuditStats {
  const stats: DiffloopAuditStats = {
    decisions: 0,
    blocked: 0,
    recoveries: 0,
  };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== DIFFLOOP_AUDIT_CUSTOM_TYPE) continue;
    const data = entry.data as Partial<DiffloopAuditEntry> | undefined;
    if (!data || typeof data.kind !== "string") continue;
    if (data.kind === "decision") stats.decisions++;
    if (data.kind === "blocked") stats.blocked++;
    if (data.kind === "recovery") stats.recoveries++;
  }

  return stats;
}
