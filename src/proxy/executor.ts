import type { AgentProfile } from "../agents.js";
import { TaskRunner } from "../task-runner.js";
import { abortReasonToText, throwIfAborted } from "./abort-utils.js";
import type { ExecutedCommand } from "./types.js";
import { rewriteProxyWebApiCurlCommandForRuntime } from "./web-api.js";

export class TerminalExecutor {
  constructor(private readonly taskRunner: TaskRunner) {}

  async runSequence(
    agent: AgentProfile,
    commands: string[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<ExecutedCommand[]> {
    const output: ExecutedCommand[] = [];

    for (const command of commands) {
      throwIfAborted(options?.abortSignal);
      const startedAt = Date.now();
      try {
        const runtimeCommand = rewriteProxyWebApiCurlCommandForRuntime(command);
        const running = this.taskRunner.start(agent, runtimeCommand);
        const abortHandler = (): void => {
          try {
            running.child.kill("SIGTERM");
          } catch {
            // ignore secondary kill failures
          }
        };
        if (options?.abortSignal) {
          if (options.abortSignal.aborted) {
            abortHandler();
          } else {
            options.abortSignal.addEventListener("abort", abortHandler, { once: true });
          }
        }
        const result = await running.done;
        if (options?.abortSignal) {
          options.abortSignal.removeEventListener("abort", abortHandler);
        }
        output.push({
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          startedAt: result.task.startedAt,
          finishedAt: result.finishedAt,
        });

        if (result.timedOut) {
          break;
        }
        if (options?.abortSignal?.aborted) {
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.push({
          command,
          stdout: "",
          stderr: options?.abortSignal?.aborted ? abortReasonToText(options.abortSignal) : message,
          exitCode: options?.abortSignal?.aborted ? null : 1,
          signal: null,
          timedOut: false,
          startedAt,
          finishedAt: Date.now(),
        });
        if (options?.abortSignal?.aborted) {
          break;
        }
      }
    }

    return output;
  }
}
