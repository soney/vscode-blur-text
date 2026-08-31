/**
 * This extension runs in two hosts: the Node.js extension host (VS Code desktop) and the
 * Web Worker host (vscode.dev / github.dev). Their timer typings disagree, and pulling in
 * either `@types/node` or `lib.dom` would let host-specific APIs leak into shared code.
 * Declaring just the timer surface we use keeps the bundle portable by construction.
 */
declare interface TimerHandle {
  readonly __timerHandle: unique symbol;
}

declare function setTimeout(handler: () => void, timeout?: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle): void;
