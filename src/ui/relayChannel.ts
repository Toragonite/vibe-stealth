/**
 * The ONE relay output channel (CONTRACT §6). Plain OutputChannel — every line is
 * pre-formatted by src/core/format.ts, so VS Code must not add its own log prefixes.
 */

import * as vscode from 'vscode';
import { IDS } from '../core/contract';

export class RelayChannel implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel(IDS.relayChannel);

  append(line: string): void {
    this.channel.appendLine(line);
  }

  /** CONTRACT §6: `openRelay` reveals without stealing focus. */
  show(): void {
    this.channel.show(true);
  }

  clear(): void {
    this.channel.clear();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
