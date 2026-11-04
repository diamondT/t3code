import { pullRequestMergeMessageOverride } from "@t3tools/client-runtime/pull-request-editing";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

interface FormProps {
  number: number;
  baseBranch: string;
  hostLabel: string;
  term: string;
  methodLabel: string;
  prefill: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (message: string | undefined) => void;
}

function MergeMessageForm({
  number,
  baseBranch,
  hostLabel,
  term,
  methodLabel,
  prefill,
  pending,
  onCancel,
  onSubmit,
}: FormProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? prefill;
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || value.trim().length === 0) return;
        onSubmit(pullRequestMergeMessageOverride(draft, prefill));
      }}
    >
      <DialogHeader>
        <DialogTitle>
          Merge {term} #{number}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <Textarea
          aria-label="Commit message"
          disabled={pending}
          maxLength={65_536}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Merges into {baseBranch}. If you leave this unchanged, {hostLabel} writes its default
          message, which can include more detail.
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || value.trim().length === 0}>
          {pending ? "Merging..." : methodLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PullRequestMergeMessageDialog({
  open,
  onClose,
  onMerge,
  pending,
  ...form
}: Omit<FormProps, "onCancel" | "onSubmit"> & {
  open: boolean;
  onClose: () => void;
  onMerge: (message: string | undefined) => Promise<boolean>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogPopup>
        {/* The draft lives in the popup, so it survives a refused merge and resets on reopening. */}
        <MergeMessageForm
          {...form}
          pending={pending}
          onCancel={onClose}
          onSubmit={(message) => {
            void onMerge(message).then((merged) => {
              if (merged) onClose();
            });
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}
