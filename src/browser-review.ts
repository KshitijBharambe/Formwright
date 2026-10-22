import { createInterface } from 'node:readline';
import type { BrowserContext } from 'playwright';

/** Keep a visible dry run alive until the user finishes reviewing its tabs. */
export async function waitForReview(context: BrowserContext): Promise<void> {
  if (!context.pages().length) return;
  await new Promise<void>(resolve => {
    const terminal = process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    const finish = () => {
      context.off('close', finish);
      terminal?.close();
      resolve();
    };
    context.once('close', finish);
    terminal?.once('line', finish);
  });
}
