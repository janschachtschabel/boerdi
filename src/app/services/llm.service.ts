import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiConfig, PersonaConfig } from './config.service';

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
@Injectable({ providedIn: 'root' })
export class LlmService {
  private apiConfig: ApiConfig | null = null;
  private apiKey: string = '';

  constructor(private http: HttpClient) {}

  configure(apiConfig: ApiConfig, apiKey: string): void {
    this.apiConfig = apiConfig;
    this.apiKey = apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
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
    temperature = 0.5
  ): Promise<LlmChoice> {
    const all: LlmMessage[] = [
      { role: 'system', content: persona.systemPrompt ?? 'Du bist Boerdi, ein hilfreicher Assistent für WirLernenOnline.de.' },
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
    if (!this.apiConfig) throw new Error('LlmService nicht konfiguriert.');

    const body: Record<string, unknown> = {
      model: this.apiConfig.model,
      messages,
      temperature,
    };
    if (tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    const headers = this.buildHeaders();
    const url = `${this.apiConfig.baseUrl}/chat/completions`;

    try {
      return await firstValueFrom(
        this.http.post<LlmResponse>(url, body, { headers })
      );
    } catch (e: any) {
      const msg = e?.error?.error?.message ?? e?.message ?? 'Unbekannter Fehler';
      throw new Error(`LLM-Fehler: ${msg}`);
    }
  }

  private buildHeaders(): HttpHeaders {
    if (!this.apiConfig) throw new Error('LlmService nicht konfiguriert.');
    return new HttpHeaders({
      'Content-Type': 'application/json',
      [this.apiConfig.apiKeyHeader]: this.apiKey,
    });
  }
}
