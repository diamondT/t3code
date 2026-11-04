import { useAtomRefresh } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  pullRequestMergeMessageOverride,
  pullRequestMergeMessagePrefill,
} from "@t3tools/client-runtime/pull-request-editing";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  MERGE_METHODS,
} from "./pullRequestActions";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export type PullRequestMergeMessageParams = PullRequestParams & {
  readonly mergeMethod: PullRequestMergeMethod;
};

export function PullRequestMergeMessageScreen({
  route,
}: StaticScreenProps<PullRequestMergeMessageParams>) {
  const params = route.params;
  const method = params.mergeMethod;
  const navigation = useNavigation();
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const pr = detail.data;
  const client = sourceControlClients.get(pr?.provider);
  const prefill = pr ? pullRequestMergeMessagePrefill(pr, method) : null;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? prefill ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canSubmit = prefill !== null && value.trim().length > 0;

  const merge = async () => {
    if (prefill === null || !canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const mergeMessage = pullRequestMergeMessageOverride(draft, prefill);
    const result = await runAction({
      ...target,
      input: {
        ...target.input,
        action: "merge",
        ...(mergeMessage === undefined ? {} : { mergeMessage }),
        resolveMergeMethod: (fresh) => {
          if (
            !canPerformPullRequestAction(fresh, "merge") ||
            !allowedMergeMethods(fresh).includes(method)
          )
            throw new Error(
              `The ${client.changeRequest.singular} changed. Refresh before merging.`,
            );
          return method;
        },
      },
    });
    inFlight.current = false;
    setBusy(false);
    detail.refresh();
    refreshActivity();
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Try again.");
      return;
    }
    navigation.goBack();
  };

  return (
    <PullRequestSheetContent
      busy={busy}
      title="Commit message"
      subtitle={`#${params.number} · ${params.repository}`}
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={busy ? "Merging…" : MERGE_METHODS[method].title}
          loading={busy}
          disabled={!canSubmit}
          onPress={() => void merge()}
        />
      }
    >
      <TextInput
        multiline
        editable={!busy && prefill !== null}
        autoFocus
        accessibilityLabel="Commit message"
        maxLength={65536}
        value={value}
        onChangeText={setDraft}
        className="min-h-48 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
        style={{ textAlignVertical: "top" }}
      />
      <Text className="text-xs text-foreground-muted">
        If you leave this unchanged, {client.label} writes its default message, which can include
        more detail.
      </Text>
      {error || detail.error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error ?? detail.error}
        </Text>
      ) : null}
    </PullRequestSheetContent>
  );
}
