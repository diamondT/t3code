import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  type CopilotUserResponse,
  copilotGitHubHost,
  copilotQuotaToLimits,
  copilotQuotaUrl,
  readCopilotUsageLimits,
} from "./copilotQuota.ts";

const checkedAt = "2026-07-01T00:00:00.000Z";

const ghSpawner = (calls: Array<ReadonlyArray<string>>, token: string) =>
  ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") calls.push(command.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(`${token}\n`)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

const quotaClient = (body: CopilotUserResponse, seen: Array<Record<string, string>>) =>
  HttpClient.make((request) => {
    seen.push({
      url: request.url,
      authorization: request.headers.authorization ?? "",
      userAgent: request.headers["user-agent"] ?? "",
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });

const premiumResponse = (login: string): CopilotUserResponse => ({
  login,
  token_based_billing: true,
  quota_reset_date_utc: "2026-08-01T00:00:00.000Z",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      percent_remaining: 25,
      remaining: 75.4,
      unlimited: false,
    },
  },
});

const withCopilotHome = <A, E, R>(
  config: string | undefined,
  run: (environment: NodeJS.ProcessEnv) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    if (config !== undefined) {
      yield* fs.writeFileString(path.join(directory, "config.json"), config);
    }
    return yield* run({ COPILOT_HOME: directory });
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.HomeDirectory, "/nonexistent"),
    Effect.provide(NodeServices.layer),
  );

describe("copilotQuotaToLimits", () => {
  it.each<{
    name: string;
    response: CopilotUserResponse;
    windows: ReadonlyArray<{
      id: string;
      label: string;
      usedPercent: number;
      resetsAt?: string;
      remaining?: number;
      limit?: number;
    }>;
  }>([
    {
      name: "labels token-billed premium usage as AI credits",
      response: premiumResponse("octo"),
      windows: [
        {
          id: "premium_interactions",
          label: "AI credits",
          usedPercent: 75,
          resetsAt: "2026-08-01T00:00:00.000Z",
          remaining: 75,
          limit: 300,
        },
      ],
    },
    {
      name: "keeps legacy premium request plans and limited chat quotas",
      response: {
        quota_snapshots: {
          chat: { entitlement: 50, percent_remaining: 90, unlimited: false },
          completions: { entitlement: 0, percent_remaining: 100, unlimited: true },
          premium_interactions: {
            entitlement: 300,
            percent_remaining: -20,
            remaining: -60,
            unlimited: false,
          },
        },
      },
      windows: [
        { id: "chat", label: "Chat", usedPercent: 10 },
        {
          id: "premium_interactions",
          label: "Premium requests",
          usedPercent: 100,
          remaining: 0,
          limit: 300,
        },
      ],
    },
  ])("$name", ({ response, windows }) => {
    const limits = copilotQuotaToLimits(response, checkedAt);
    expect(limits.windows).toEqual(windows.map((window) => ({ kind: "monthly", ...window })));
    expect(limits.externalUsage?.url).toBe("https://github.com/settings/billing");
  });

  it("reports unlimited plans as having no limits", () => {
    const limits = copilotQuotaToLimits(
      {
        quota_snapshots: {
          chat: { entitlement: 0, percent_remaining: 100, unlimited: true },
          premium_interactions: { entitlement: 0, percent_remaining: 100, unlimited: true },
        },
      },
      checkedAt,
    );
    expect(limits.unavailable?.reason).toBe("unsupported");
    expect(limits.windows).toEqual([]);
  });
});

describe("Copilot quota host", () => {
  it.each([
    [{}, "github.com", "https://api.github.com/copilot_internal/user"],
    [
      { GH_HOST: "https://Octo.ghe.com/" },
      "octo.ghe.com",
      "https://api.octo.ghe.com/copilot_internal/user",
    ],
    [{ COPILOT_GH_HOST: "git.corp.example", GH_HOST: "github.com" }, "git.corp.example", undefined],
  ])("%j resolves to %s", (environment, host, url) => {
    expect(copilotGitHubHost(environment)).toBe(host);
    expect(copilotQuotaUrl(host)).toBe(url);
  });
});

describe("readCopilotUsageLimits", () => {
  it.effect("uses an explicit token without asking gh", () =>
    withCopilotHome(undefined, (environment) =>
      Effect.gen(function* () {
        const seen: Array<Record<string, string>> = [];
        const limits = yield* readCopilotUsageLimits({
          ...environment,
          COPILOT_GITHUB_TOKEN: "env-token",
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, quotaClient(premiumResponse("other"), seen)),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("must not spawn gh")),
          ),
        );
        expect(seen).toEqual([
          {
            url: "https://api.github.com/copilot_internal/user",
            authorization: "token env-token",
            userAgent: "t3code",
          },
        ]);
        expect(limits.windows[0]?.usedPercent).toBe(75);
      }),
    ),
  );

  it.effect("asks gh for Copilot CLI's account and rejects a different one", () =>
    withCopilotHome(
      '// managed by Copilot\n{"lastLoggedInUser":{"host":"https://github.com","login":"octo"}}',
      (environment) =>
        Effect.gen(function* () {
          const calls: Array<ReadonlyArray<string>> = [];
          const read = (login: string) =>
            readCopilotUsageLimits(environment).pipe(
              Effect.provideService(HttpClient.HttpClient, quotaClient(premiumResponse(login), [])),
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                ghSpawner(calls, "gh-token"),
              ),
            );

          expect((yield* read("Octo")).windows[0]?.usedPercent).toBe(75);
          expect(calls[0]).toEqual(["auth", "token", "--hostname", "github.com", "--user", "octo"]);

          const mismatch = yield* read("someone-else");
          expect(mismatch.unavailable?.reason).toBe("probeFailed");
          expect(mismatch.unavailable?.message).toContain("someone-else");
        }),
    ),
  );

  it.effect("asks the user to sign in when no token is available", () =>
    withCopilotHome(undefined, (environment) =>
      readCopilotUsageLimits(environment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request quota")),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ghSpawner([], "")),
        Effect.map((limits) => {
          expect(limits.unavailable?.reason).toBe("probeFailed");
          expect(limits.unavailable?.message).toContain("gh auth login");
        }),
      ),
    ),
  );
});
