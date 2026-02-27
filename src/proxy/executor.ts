import type { AgentProfile } from "../agents.js";
import { TaskRunner } from "../task-runner.js";
import type { ExecutedCommand } from "./types.js";

export class TerminalExecutor {
  constructor(private readonly taskRunner: TaskRunner) {}

  async runSequence(agent: AgentProfile, commands: string[]): Promise<ExecutedCommand[]> {
    const output: ExecutedCommand[] = [];

    for (const command of commands) {
      const startedAt = Date.now();
      try {
        const running = this.taskRunner.start(agent, command);
        const result = await running.done;
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.push({
          command,
          stdout: "",
          stderr: message,
          exitCode: 1,
          signal: null,
          timedOut: false,
          startedAt,
          finishedAt: Date.now(),
        });
      }
    }

    return output;
  }
}
