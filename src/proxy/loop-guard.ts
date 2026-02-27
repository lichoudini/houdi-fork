import type { ExecutedCommand } from "./types.js";

export type LoopGuardState = {
  lastSignature: string;
  repeatedCount: number;
};

function normalizeChunk(value: string, maxChars = 1200): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return compact.slice(0, maxChars);
}

export function buildExecutionSignature(commands: string[], results: ExecutedCommand[]): string {
  const payload = {
    commands: commands.map((item) => item.trim()),
    results: results.map((item) => ({
      command: item.command,
      exitCode: item.exitCode,
      signal: item.signal,
      timedOut: item.timedOut,
      stdout: normalizeChunk(item.stdout),
      stderr: normalizeChunk(item.stderr),
    })),
  };
  return JSON.stringify(payload);
}

export function nextLoopGuardState(
  state: LoopGuardState,
  commands: string[],
  results: ExecutedCommand[],
): { state: LoopGuardState; shouldStop: boolean } {
  const signature = buildExecutionSignature(commands, results);
  if (!state.lastSignature) {
    return {
      state: {
        lastSignature: signature,
        repeatedCount: 0,
      },
      shouldStop: false,
    };
  }
  if (state.lastSignature === signature) {
    const repeatedCount = state.repeatedCount + 1;
    return {
      state: {
        lastSignature: signature,
        repeatedCount,
      },
      shouldStop: repeatedCount >= 1,
    };
  }
  return {
    state: {
      lastSignature: signature,
      repeatedCount: 0,
    },
    shouldStop: false,
  };
}
