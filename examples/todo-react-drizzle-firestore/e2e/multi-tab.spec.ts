import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const OWNER = /holds the local database/;
const FOLLOWER = /held by another tab/;

async function openTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("storage-role")).toHaveText(/local database/);
  return page;
}

async function addTodo(page: Page, title: string): Promise<void> {
  await page.getByLabel("New todo").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(title)).toBeVisible();
}

test("a follower's write reaches every tab through the single owner", async ({ context }) => {
  const owner = await openTab(context);
  const follower = await openTab(context);
  const third = await openTab(context);
  await expect(owner.getByTestId("storage-role")).toHaveText(OWNER);
  await expect(follower.getByTestId("storage-role")).toHaveText(FOLLOWER);
  await expect(third.getByTestId("storage-role")).toHaveText(FOLLOWER);

  await addTodo(follower, "written in a follower");
  await expect(owner.getByText("written in a follower")).toBeVisible();
  await expect(third.getByText("written in a follower")).toBeVisible();

  await addTodo(owner, "written in the owner");
  await expect(follower.getByText("written in the owner")).toBeVisible();
});

test("closing the owner hands the database to a follower without losing data", async ({
  context,
}) => {
  const owner = await openTab(context);
  const follower = await openTab(context);
  await addTodo(follower, "before handoff");

  await owner.close();
  await expect(follower.getByTestId("storage-role")).toHaveText(OWNER);
  await expect(follower.getByText("before handoff")).toBeVisible();
  await addTodo(follower, "after handoff");

  const late = await openTab(context);
  await expect(late.getByTestId("storage-role")).toHaveText(FOLLOWER);
  await expect(late.getByText("before handoff")).toBeVisible();
  await expect(late.getByText("after handoff")).toBeVisible();
});

test("an owner crash keeps every acknowledged write", async ({ context }) => {
  const owner = await openTab(context);
  const follower = await openTab(context);
  await addTodo(follower, "acked before crash");

  // Kill the owner's renderer: no pagehide, no cleanup, the lock is simply freed.
  const session = await context.newCDPSession(owner);
  await session.send("Page.crash").catch(() => undefined);

  await expect(follower.getByTestId("storage-role")).toHaveText(OWNER);
  await expect(follower.getByText("acked before crash")).toBeVisible();
});

test("tabs reloading together keep one snapshot and the latest data", async ({ context }) => {
  const first = await openTab(context);
  const second = await openTab(context);
  await addTodo(second, "survives reloads");
  await Promise.all([first.reload(), second.reload()]);
  for (const page of [first, second]) {
    await expect(page.getByText("survives reloads")).toBeVisible();
  }
  const roles = await Promise.all(
    [first, second].map((page) => page.getByTestId("storage-role").textContent()),
  );
  expect(roles.filter((role) => OWNER.test(role ?? ""))).toHaveLength(1);
});
