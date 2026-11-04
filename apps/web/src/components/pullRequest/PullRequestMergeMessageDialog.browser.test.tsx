import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PullRequestMergeMessageDialog } from "./PullRequestMergeMessageDialog";

const props = {
  open: true,
  onClose: () => {},
  number: 7,
  baseBranch: "main",
  hostLabel: "Bitbucket",
  term: "pull request",
  methodLabel: "Squash and merge",
  prefill: "Merged in feat/page (pull request #7)\n\nAdd page",
  pending: false,
};
const message = () => page.getByRole("textbox", { name: "Commit message" });
const merge = () => page.getByRole("button", { name: "Squash and merge" });

it("sends no message when the prefill is left alone", async () => {
  const onMerge = vi.fn(async () => true);
  const onClose = vi.fn();
  await using _screen = await render(
    <PullRequestMergeMessageDialog {...props} onClose={onClose} onMerge={onMerge} />,
  );
  await expect.element(message()).toHaveValue(props.prefill);
  await userEvent.click(merge());
  expect(onMerge).toHaveBeenCalledWith(undefined);
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("keeps a written message open for another try when the host refuses", async () => {
  const onMerge = vi.fn(async () => false);
  const onClose = vi.fn();
  await using _screen = await render(
    <PullRequestMergeMessageDialog {...props} onClose={onClose} onMerge={onMerge} />,
  );
  await userEvent.fill(message(), "  Ship it\n");
  await userEvent.click(merge());
  expect(onMerge).toHaveBeenCalledWith("Ship it");
  await expect.element(message()).toHaveValue("  Ship it\n");
  expect(onClose).not.toHaveBeenCalled();
});

it("refuses a blank message", async () => {
  await using _screen = await render(
    <PullRequestMergeMessageDialog {...props} onMerge={async () => true} />,
  );
  await userEvent.fill(message(), "   ");
  await expect.element(merge()).toBeDisabled();
});
