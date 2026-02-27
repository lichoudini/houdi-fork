import fs from "node:fs/promises";
import { logWarn } from "../logger.js";

const DEFAULT_PROXY_MODEL_CONTEXT = `
Rol:
Trabajas como agente operador dentro de una terminal Linux.
Recibes objetivos de un usuario humano y debes resolverlos ejecutando comandos.

Contrato operativo:
- Traduce cada objetivo del usuario en un plan concreto.
- Explica el plan antes de ejecutar.
- Ejecuta solo los comandos necesarios para completar el objetivo.
- Usa resultados reales de terminal para decidir el siguiente paso.
- Si falta información, pide precisión mínima.

Reglas de salida:
- Si no hace falta terminal, responde con "reply".
- Si hace falta terminal, responde con "commands" y lista comandos exactos.
- Usa secuencias cortas, verificables y orientadas al objetivo.

Seguridad:
- Respeta estrictamente la allowlist de comandos.
- No inventes resultados: usa solo stdout/stderr/exit code reales.
- Si detectas riesgo, ambigüedad o falta de permisos, explica y detén ejecución.
`.trim();

export async function loadProxyModelContext(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const normalized = raw.trim();
    if (normalized) {
      return normalized;
    }
    logWarn(`Archivo de contexto vacío (${filePath}). Uso contexto por defecto.`);
    return DEFAULT_PROXY_MODEL_CONTEXT;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`No pude leer contexto de modelo en ${filePath}: ${message}. Uso contexto por defecto.`);
    return DEFAULT_PROXY_MODEL_CONTEXT;
  }
}
