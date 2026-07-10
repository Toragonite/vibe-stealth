/**
 * Diagnostics sink (CONTRACT §6: separate 'Vibe Stealth Diagnostics' channel, created
 * lazily) and the single place errors are rendered. CONTRACT §7: every boundary writes
 * here; nothing ever reaches a modal dialog.
 */

import * as vscode from 'vscode';
import { IDS } from '../core/contract';

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack && err.stack.includes(err.message)
      ? err.stack
      : `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  try {
    const json = JSON.stringify(err);
    if (typeof json === 'string') return json;
  } catch {
    /* cyclic structure */
  }
  return String(err);
}

export class Diagnostics implements vscode.Disposable {
  private channel: vscode.OutputChannel | undefined;

  private ensure(): vscode.OutputChannel {
    if (!this.channel) this.channel = vscode.window.createOutputChannel(IDS.diagChannel);
    return this.channel;
  }

  log(message: string): void {
    // A diagnostics sink must never throw back into the caller's boundary.
    try {
      this.ensure().appendLine(`${new Date().toISOString()} ${message}`);
    } catch {
      /* channel disposed during shutdown */
    }
  }

  error(scope: string, err: unknown): void {
    this.log(`[${scope}] ${describeError(err)}`);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}
