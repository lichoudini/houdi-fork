import type { InterpretationBundle } from "./interpretation-bundle.js";

export type ActionOutcome = {
  status: "success" | "blocked" | "incomplete";
  summary: string;
  reason: string;
};

export type ActionHandler<TContext> = {
  id: string;
  canHandle: (bundle: InterpretationBundle) => boolean;
  execute: (context: TContext) => Promise<ActionOutcome | null>;
};

export class DomainActionRegistry<TContext extends { bundle: InterpretationBundle }> {
  constructor(private readonly handlers: ActionHandler<TContext>[]) {}

  async execute(context: TContext): Promise<{ handlerId: string; outcome: ActionOutcome | null } | null> {
    for (const handler of this.handlers) {
      if (!handler.canHandle(context.bundle)) {
        continue;
      }
      const outcome = await handler.execute(context);
      if (outcome) {
        return {
          handlerId: handler.id,
          outcome,
        };
      }
    }
    return null;
  }
}
