import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** Copilot CLI's own precedence for an explicit token. */
const TOKEN_VARIABLES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const SIGN_IN_MESSAGE =
  "Sign in with `gh auth login` as your Copilot account, or set GH_TOKEN in this instance's environment.";

const QUOTA_LABELS: Readonly<Record<string, string>> = {
  chat: "Chat",
  completions: "Completions",
};

const QuotaSnapshot = Schema.Struct({
  entitlement: Schema.optional(Schema.Number),
  percent_remaining: Schema.optional(Schema.Number),
  unlimited: Schema.optional(Schema.Boolean),
});

// Undocumented endpoint used by VS Code Copilot Chat; decode only what the bars need.
export const CopilotUserResponse = Schema.Struct({
  login: Schema.optional(Schema.String),
  token_based_billing: Schema.optional(Schema.Boolean),
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(Schema.Record(Schema.String, QuotaSnapshot)),
});
export type CopilotUserResponse = typeof CopilotUserResponse.Type;

const CopilotConfig = Schema.Struct({
  lastLoggedInUser: Schema.optional(
    Schema.Struct({ host: Schema.optional(Schema.String), login: Schema.optional(Schema.String) }),
  ),
});
const decodeCopilotConfig = Schema.decodeUnknownOption(Schema.fromJsonString(CopilotConfig));

const hostName = (value: string) =>
  value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

export function copilotGitHubHost(environment: NodeJS.ProcessEnv): string {
  return hostName(environment.COPILOT_GH_HOST || environment.GH_HOST || "") || "github.com";
}

/** Copilot quota lives on github.com and GHE.com data residency hosts, not on GitHub Enterprise Server. */
export function copilotQuotaUrl(host: string): string | undefined {
  if (host === "github.com") return "https://api.github.com/copilot_internal/user";
  if (host.endsWith(".ghe.com")) return `https://api.${host}/copilot_internal/user`;
  return undefined;
}

export function copilotQuotaToLimits(
  response: CopilotUserResponse,
  checkedAt: string,
): ServerProviderUsageLimits {
  const reset = Option.flatMap(Option.fromNullishOr(response.quota_reset_date_utc), DateTime.make);
  const windows = Object.entries(response.quota_snapshots ?? {}).flatMap(
    ([id, snapshot]): ServerProviderUsageWindow[] => {
      const label =
        id === "premium_interactions"
          ? response.token_based_billing
            ? "AI credits"
            : "Premium requests"
          : QUOTA_LABELS[id];
      if (
        label === undefined ||
        snapshot.unlimited !== false ||
        !((snapshot.entitlement ?? 0) > 0) ||
        snapshot.percent_remaining === undefined
      ) {
        return [];
      }
      return [
        {
          id,
          kind: "monthly",
          label,
          usedPercent: clampPercent(100 - snapshot.percent_remaining),
          ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
        },
      ];
    },
  );
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "This Copilot plan reports no usage limits.",
    });
  }
  return {
    ...makeUsageLimits({ checkedAt, windows }),
    externalUsage: { label: "GitHub billing", url: "https://github.com/settings/billing" },
  };
}

const readCopilotLogin = Effect.fn("CopilotQuota.readLogin")(function* (
  environment: NodeJS.ProcessEnv,
  host: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const copilotHome = environment.COPILOT_HOME?.trim();
  const home = copilotHome
    ? expandHomePath(copilotHome, homeDirectory)
    : path.join(homeDirectory, ".copilot");
  const contents = yield* fs.readFileString(path.join(home, "config.json"));
  // Copilot prefixes its config with `//` comment lines.
  const config = decodeCopilotConfig(contents.replace(/^\s*\/\/.*$/gm, ""));
  const user = Option.getOrUndefined(config)?.lastLoggedInUser;
  return user?.login && hostName(user.host ?? "github.com") === host ? user.login : undefined;
});

const ghAuthToken = (environment: NodeJS.ProcessEnv, host: string, login: string | undefined) =>
  spawnAndCollect(
    "gh",
    ChildProcess.make(
      "gh",
      ["auth", "token", "--hostname", host, ...(login === undefined ? [] : ["--user", login])],
      // Never let gh print the token into a debug log.
      {
        env: { ...environment, GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
        extendEnv: false,
        stdin: "ignore",
      },
    ),
  ).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
    Effect.orElseSucceed(() => ""),
  );

export const readCopilotUsageLimits = Effect.fn("CopilotQuota.read")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });
  const host = copilotGitHubHost(environment);
  const url = copilotQuotaUrl(host);
  if (url === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "GitHub Enterprise Server does not report Copilot usage limits.",
    });
  }
  const login = yield* readCopilotLogin(environment, host).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const explicitToken = TOKEN_VARIABLES.map((name) => environment[name]?.trim()).find(Boolean);
  // gh may hold several accounts; prefer Copilot CLI's, then gh's active account.
  const token =
    explicitToken ||
    (login === undefined ? "" : yield* ghAuthToken(environment, host, login)) ||
    (yield* ghAuthToken(environment, host, undefined));
  if (!token) return probeFailed(SIGN_IN_MESSAGE);

  const response = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const raw = yield* client.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Authorization", `token ${token}`),
        // GitHub's API rejects requests without a User-Agent.
        HttpClientRequest.setHeader("User-Agent", "t3code"),
        HttpClientRequest.acceptJson,
      ),
    );
    return yield* HttpClientResponse.schemaBodyJson(CopilotUserResponse)(
      yield* HttpClientResponse.filterStatusOk(raw),
    );
  }).pipe(Effect.timeout("10 seconds"), Effect.option);
  if (Option.isNone(response)) {
    return probeFailed(`Could not read Copilot usage limits. ${SIGN_IN_MESSAGE}`);
  }
  const responseLogin = response.value.login;
  if (
    explicitToken === undefined &&
    login !== undefined &&
    responseLogin !== undefined &&
    responseLogin.toLowerCase() !== login.toLowerCase()
  ) {
    return probeFailed(
      `gh is signed in as ${responseLogin}, but Copilot CLI uses ${login}. ${SIGN_IN_MESSAGE}`,
    );
  }
  return copilotQuotaToLimits(response.value, checkedAt);
});
