import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiConfig, LlmProvider, PersonaConfig } from './config.service';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: LlmToolCall[];
  };
  finish_reason: string;
}

export interface LlmResponse {
  choices: LlmChoice[];
}

/**
 * LLM-Service: Ruft B-API oder OpenAI-kompatible Endpunkte auf.
 * Unterstützt persona-aware System-Prompts und Tool-Calling (für MCP-Bridge).
 */
/** OpenAI-kompatible Provider-Konfiguration */
interface ResolvedProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
  authHeader: string;       // Header-Name
  authValue: string;        // Header-Wert (z.B. 'Bearer sk-...')
}

@Injectable({ providedIn: 'root' })
export class LlmService {
  private apiConfig: ApiConfig | null = null;
  private apiKey: string = '';
  private bapiKey: string = '';
  private openaiKey: string = '';
  private resolvedProvider: ResolvedProvider | null = null;

  constructor(private http: HttpClient) {}

  configure(apiConfig: ApiConfig, keys: { apiKey: string; bapiKey?: string; openaiKey?: string; envProvider?: string }): void {
    this.apiConfig = apiConfig;
    this.apiKey = keys.apiKey;
    this.bapiKey = keys.bapiKey ?? '';
    this.openaiKey = keys.openaiKey ?? '';
    // Umgebungsvariable LLM_PROVIDER überschreibt Flow-Config provider
    const effectiveConfig = keys.envProvider === 'openai' || keys.envProvider === 'bapi'
      ? { ...apiConfig, provider: keys.envProvider as LlmProvider }
      : apiConfig;
    this.resolvedProvider = this.resolveProvider(effectiveConfig);
    console.log(`[LlmService] Provider: ${this.resolvedProvider.baseUrl} (auth: ${this.resolvedProvider.authHeader})`);
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /** Bestimmt den effektiven Provider basierend auf Config + verfügbaren Keys */
  private resolveProvider(config: ApiConfig): ResolvedProvider {
    const explicit = config.provider;

    // Explizit openai im Flow-Config
    if (explicit === 'openai' && this.openaiKey) {
      return {
        baseUrl: 'https://api.openai.com/v1',
        model: config.model,
        apiKey: this.openaiKey,
        authHeader: 'Authorization',
        authValue: `Bearer ${this.openaiKey}`,
      };
    }

    // Explizit bapi oder Default mit bapi-Key vorhanden
    if (this.bapiKey) {
      return {
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: this.bapiKey,
        authHeader: config.apiKeyHeader,
        authValue: this.bapiKey,
      };
    }

    // Fallback: openai-Key vorhanden, aber kein bapi-Key
    if (this.openaiKey) {
      console.warn('[LlmService] Kein B_API_KEY → Fallback auf OpenAI direkt');
      return {
        baseUrl: 'https://api.openai.com/v1',
        model: config.model,
        apiKey: this.openaiKey,
        authHeader: 'Authorization',
        authValue: `Bearer ${this.openaiKey}`,
      };
    }

    // Kein Key → verwende Config-Defaults (wird wahrscheinlich 401 geben)
    return {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: this.apiKey,
      authHeader: config.apiKeyHeader,
      authValue: this.apiKey,
    };
  }

  /** Einfache Chat-Completion ohne Tools */
  async chat(
    messages: LlmMessage[],
    persona: PersonaConfig,
    temperature = 0.7
  ): Promise<string> {
    const systemMessages: LlmMessage[] = [
      { role: 'system', content: persona.systemPrompt ?? 'Du bist Boerdi, ein hilfreicher Assistent für WirLernenOnline.de.' },
    ];
    return this.complete([...systemMessages, ...messages], [], temperature);
  }

  /** Chat-Completion mit Tool-Calling (für MCP-Bridge) */
  async chatWithTools(
    messages: LlmMessage[],
    persona: PersonaConfig,
    tools: LlmTool[],
    temperature = 0.5,
    extraSystemContext?: string
  ): Promise<LlmChoice> {
    const systemBase = persona.systemPrompt ?? 'Du bist Boerdi, ein hilfreicher Assistent für WirLernenOnline.de.';
    const systemContent = extraSystemContext ? `${systemBase}

${extraSystemContext}` : systemBase;
    const all: LlmMessage[] = [
      { role: 'system', content: systemContent },
      ...messages,
    ];
    return this.completeWithTools(all, tools, temperature);
  }

  private async complete(
    messages: LlmMessage[],
    tools: LlmTool[],
    temperature: number
  ): Promise<string> {
    const resp = await this.completeRaw(messages, tools, temperature);
    return resp.choices[0]?.message?.content ?? '(keine Antwort)';
  }

  private async completeWithTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    temperature: number
  ): Promise<LlmChoice> {
    const resp = await this.completeRaw(messages, tools, temperature);
    return resp.choices[0];
  }

  private async completeRaw(
    messages: LlmMessage[],
    tools: LlmTool[],
    temperature: number
  ): Promise<LlmResponse> {
    if (!this.resolvedProvider) throw new Error('LlmService nicht konfiguriert.');

    const prov = this.resolvedProvider;
    const body: Record<string, unknown> = {
      model: prov.model,
      messages,
      temperature,
    };
    if (tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      [prov.authHeader]: prov.authValue,
    });
    const url = `${prov.baseUrl}/chat/completions`;

    try {
      return await firstValueFrom(
        this.http.post<LlmResponse>(url, body, { headers })
      );
    } catch (e: any) {
      const msg = e?.error?.error?.message ?? e?.message ?? 'Unbekannter Fehler';
      throw new Error(`LLM-Fehler: ${msg}`);
    }
  }
}
