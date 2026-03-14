import fs from "node:fs/promises";
import path from "node:path";
import type { IntentAction, IntentDomain } from "./intent-ir.js";

export type IntentOutcomeStatus = "success" | "blocked" | "incomplete";

export type IntentDecisionEvent = {
  chatId: number;
  userId?: number;
  domain: IntentDomain;
  action: IntentAction;
  confidence: number;
  ambiguousDomains: IntentDomain[];
  reasons: string[];
  objectivePreview: string;
  shadowDomain?: IntentDomain;
  shadowConfidence?: number;
  abstained?: boolean;
  criticBlocked?: boolean;
};

export type IntentOutcomeEvent = {
  chatId: number;
  userId?: number;
  domain: IntentDomain;
  confidence: number;
  status: IntentOutcomeStatus;
  durationMs: number;
  iterations: number;
  commandsExecuted: number;
  reason?: string;
};

type TelemetryEvent =
  | {
      ts: string;
      type: "intent-decision";
      payload: IntentDecisionEvent;
    }
  | {
      ts: string;
      type: "intent-outcome";
      payload: IntentOutcomeEvent;
    };

export type IntentSloAlert = {
  scope: "overall" | IntentDomain;
  windowSize: number;
  sampleSize: number;
  failures: number;
  failureRate: number;
  threshold: number;
};

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class IntentTelemetry {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private readonly sloWindow: number;
  private readonly sloMaxFailureRate: number;
  private readonly sloMinSamples: number;
  private readonly outcomes: IntentOutcomeEvent[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(params: {
    filePath: string;
    enabled: boolean;
    sloWindow: number;
    sloMaxFailureRate: number;
    sloMinSamples: number;
  }) {
    this.filePath = params.filePath;
    this.enabled = params.enabled;
    this.sloWindow = Math.max(5, params.sloWindow);
    this.sloMaxFailureRate = Math.max(0, Math.min(1, params.sloMaxFailureRate));
    this.sloMinSamples = Math.max(1, params.sloMinSamples);
  }

  static async create(params: {
    filePath: string;
    enabled: boolean;
    sloWindow: number;
    sloMaxFailureRate: number;
    sloMinSamples: number;
  }): Promise<IntentTelemetry> {
    const instance = new IntentTelemetry(params);
    if (instance.enabled) {
      await fs.mkdir(path.dirname(instance.filePath), { recursive: true });
    }
    return instance;
  }

  private enqueueWrite(event: TelemetryEvent): Promise<void> {
    if (!this.enabled) {
      return Promise.resolve();
    }
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.appendFile(this.filePath, line, "utf8");
      });
    return this.writeQueue;
  }

  async recordDecision(event: IntentDecisionEvent): Promise<void> {
    await this.enqueueWrite({
      ts: new Date().toISOString(),
      type: "intent-decision",
      payload: event,
    });
  }

  async recordOutcome(event: IntentOutcomeEvent): Promise<void> {
    this.outcomes.push(event);
    if (this.outcomes.length > this.sloWindow * 4) {
      this.outcomes.splice(0, this.outcomes.length - this.sloWindow * 4);
    }

    await this.enqueueWrite({
      ts: new Date().toISOString(),
      type: "intent-outcome",
      payload: event,
    });
  }

  getSloAlert(scope?: IntentDomain): IntentSloAlert | null {
    const recent = this.outcomes.slice(-this.sloWindow);
    const sampled = scope ? recent.filter((item) => item.domain === scope) : recent;
    if (sampled.length < this.sloMinSamples) {
      return null;
    }
    const failures = sampled.filter((item) => item.status !== "success").length;
    const failureRate = sampled.length === 0 ? 0 : failures / sampled.length;
    if (failureRate <= this.sloMaxFailureRate) {
      return null;
    }
    return {
      scope: scope ?? "overall",
      windowSize: this.sloWindow,
      sampleSize: sampled.length,
      failures,
      failureRate: roundRate(failureRate),
      threshold: this.sloMaxFailureRate,
    };
  }
}
