import { describe, expect, it } from "vite-plus/test";

import { resolvePullRequestMergeMethod } from "./pullRequestMergeMethod.ts";

const ALL = ["merge", "squash", "rebase"] as const;

describe("resolvePullRequestMergeMethod", () => {
  it.each([
    {
      name: "a pick on this pull request beats everything",
      allowed: ALL,
      picked: "rebase",
      configuredDefault: "squash",
      repositoryDefault: "merge",
      lastSelected: "merge",
      expected: "rebase",
    },
    {
      name: "the configured default beats the repository default",
      allowed: ALL,
      picked: null,
      configuredDefault: "squash",
      repositoryDefault: "rebase",
      lastSelected: "merge",
      expected: "squash",
    },
    {
      name: "the repository default beats the last selection",
      allowed: ALL,
      picked: null,
      configuredDefault: null,
      repositoryDefault: "rebase",
      lastSelected: "merge",
      expected: "rebase",
    },
    {
      name: "the last selection applies without a repository default",
      allowed: ALL,
      picked: null,
      configuredDefault: null,
      repositoryDefault: undefined,
      lastSelected: "squash",
      expected: "squash",
    },
    {
      name: "a configured default the repository disallows falls through",
      allowed: ["merge", "rebase"],
      picked: null,
      configuredDefault: "squash",
      repositoryDefault: "rebase",
      lastSelected: "merge",
      expected: "rebase",
    },
    {
      name: "nothing allowed among the choices falls back to the first allowed",
      allowed: ["rebase"],
      picked: null,
      configuredDefault: "squash",
      repositoryDefault: "merge",
      lastSelected: "merge",
      expected: "rebase",
    },
  ] as const)("$name", ({ expected, ...input }) => {
    expect(resolvePullRequestMergeMethod(input)).toBe(expected);
  });
});
