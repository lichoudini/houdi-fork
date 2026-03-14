import fs from "node:fs/promises";
import path from "node:path";
import type { IntentDomain } from "./intent-ir.js";

const DOMAINS: IntentDomain[] = ["self-maintenance", "schedule", "gmail", "workspace", "web", "memory", "general"];

type BiasVector = Record<IntentDomain, number>;

type PersistedBiasStore = {
  version: 1;
  chats: Record<string, Partial<Record<IntentDomain, number>>>;
};

export type IntentBiasOutcomeStatus = "success" | "blocked" | "incomplete";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundBias(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function createZeroBiasVector(): BiasVector {
  return {
    "self-maintenance": 0,
    schedule: 0,
    gmail: 0,
    workspace: 0,
    web: 0,
    memory: 0,
    general: 0,
  };
}

export class IntentBiasStore {
  private readonly enabled: boolean;
  private readonly filePath: string;
  private readonly learningRate: number;
  private readonly decayFactor: number;
  private readonly maxAbsBias: number;
  private readonly byChat = new Map<number, BiasVector>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(params: {
    enabled: boolean;
    filePath: string;
    learningRate: number;
    decayFactor: number;
    maxAbsBias: number;
  }) {
    this.enabled = params.enabled;
    this.filePath = params.filePath;
    this.learningRate = params.learningRate;
    this.decayFactor = clamp(params.decayFactor, 0.9, 0.999);
    this.maxAbsBias = Math.max(0.2, params.maxAbsBias);
  }

  static async create(params: { enabled: boolean; filePath: string }): Promise<IntentBiasStore> {
    const instance = new IntentBiasStore({
      enabled: params.enabled,
      filePath: params.filePath,
      learningRate: 0.18,
      decayFactor: 0.992,
      maxAbsBias: 1.8,
    });
    await instance.load();
    return instance;
  }

  private async load(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedBiasStore;
      if (parsed.version !== 1 || typeof parsed.chats !== "object" || parsed.chats === null) {
        return;
      }
      for (const [chatIdRaw, biasRaw] of Object.entries(parsed.chats)) {
        const chatId = Number.parseInt(chatIdRaw, 10);
        if (!Number.isFinite(chatId) || chatId <= 0) {
          continue;
        }
        const next = createZeroBiasVector();
        for (const domain of DOMAINS) {
          const value = biasRaw[domain];
          if (typeof value === "number" && Number.isFinite(value)) {
            next[domain] = clamp(value, -this.maxAbsBias, this.maxAbsBias);
          }
        }
        this.byChat.set(chatId, next);
      }
    } catch {
      // ignore missing/corrupted file; a new one will be created on first update
    }
  }

  private getOrCreate(chatId: number): BiasVector {
    const existing = this.byChat.get(chatId);
    if (existing) {
      return existing;
    }
    const created = createZeroBiasVector();
    this.byChat.set(chatId, created);
    return created;
  }

  getDomainBias(chatId: number): Partial<Record<IntentDomain, number>> {
    if (!this.enabled) {
      return {};
    }
    const vector = this.byChat.get(chatId);
    if (!vector) {
      return {};
    }
    const out: Partial<Record<IntentDomain, number>> = {};
    for (const domain of DOMAINS) {
      const value = vector[domain];
      if (Math.abs(value) < 0.001) {
        continue;
      }
      out[domain] = roundBias(value);
    }
    return out;
  }

  private async persist(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const payload: PersistedBiasStore = {
      version: 1,
      chats: {},
    };
    for (const [chatId, vector] of this.byChat.entries()) {
      const persisted: Partial<Record<IntentDomain, number>> = {};
      for (const domain of DOMAINS) {
        persisted[domain] = roundBias(vector[domain]);
      }
      payload.chats[String(chatId)] = persisted;
    }

    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tmpPath = `${this.filePath}.tmp`;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(tmpPath, serialized, "utf8");
        await fs.rename(tmpPath, this.filePath);
      });
    await this.writeQueue;
  }

  async recordOutcome(params: {
    chatId: number;
    domain: IntentDomain;
    status: IntentBiasOutcomeStatus;
    confidence: number;
    abstained?: boolean;
    criticBlocked?: boolean;
  }): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const vector = this.getOrCreate(params.chatId);

    for (const domain of DOMAINS) {
      vector[domain] = clamp(vector[domain] * this.decayFactor, -this.maxAbsBias, this.maxAbsBias);
    }

    const confidence = clamp(params.confidence, 0, 1);
    let delta = 0;
    if (params.status === "success") {
      delta = this.learningRate * (0.7 + (1 - confidence) * 0.6);
    } else if (params.status === "blocked") {
      delta = -this.learningRate * (1 + confidence * 0.7);
    }

    // Pedir aclaración, abstener o bloquear un plan desviado no implica
    // que el dominio detectado fuera incorrecto; no conviene sesgar contra él.
    if (params.status !== "blocked" || params.abstained || params.criticBlocked) {
      delta = params.status === "success" ? delta : 0;
    }

    vector[params.domain] = clamp(vector[params.domain] + delta, -this.maxAbsBias, this.maxAbsBias);
    await this.persist();
  }
}
