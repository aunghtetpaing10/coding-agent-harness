export type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

export type NeedsApproval = (input: { command: string }) => boolean;

const SAFE_PREFIXES = [
  "js-exec ",
  "ls",
  "tree",
  "rg",
  "cat",
  "head",
  "tail",
  "wc",
];

export function createApproval(config: ApprovalConfig): NeedsApproval {
  return ({ command }) => {
    const trimmed = command.trim();

    if (config.mode === "background") {
      return false;
    }

    if (config.mode === "delegated") {
      return !config.trust.some((prefix) => trimmed.startsWith(prefix));
    }

    return !SAFE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  };
}
