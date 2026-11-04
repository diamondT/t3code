import type { PullRequestMergeMethod } from "@t3tools/contracts";

type MergeMethodChoice = PullRequestMergeMethod | null | undefined;

export function resolvePullRequestMergeMethod(input: {
  readonly allowed: ReadonlyArray<PullRequestMergeMethod>;
  readonly picked: MergeMethodChoice;
  readonly configuredDefault: MergeMethodChoice;
  readonly repositoryDefault: MergeMethodChoice;
  readonly lastSelected: MergeMethodChoice;
}): PullRequestMergeMethod {
  const candidates = [
    input.picked,
    input.configuredDefault,
    input.repositoryDefault,
    input.lastSelected,
  ];
  for (const method of candidates) {
    if (method && input.allowed.includes(method)) return method;
  }
  return input.allowed[0] ?? "merge";
}
