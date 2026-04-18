import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
