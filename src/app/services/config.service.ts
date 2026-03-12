import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import * as yaml from 'js-yaml';

// ── Config types (spiegeln boerdi-config.yml) ─────────────────────────────────

export interface BotConfig {
  name: string;
  avatar: string;
  tagline: string;
}

export interface ApiConfig {
  baseUrl: string;
  model: string;
  apiKeyHeader: string;
  apiKey?: string;
}

export interface McpConfig {
  serverUrl: string;
  searchTool: string;
  fetchTool: string;
}

export interface PersonaConfig {
  label: string;
  uri: string;
  personaFile: string;          // Pfad zur Markdown-Datei in assets/personas/
  systemPrompt?: string;        // zur Laufzeit aus Datei geladen
}

export interface FlowOption {
  label: string;
  value: string;
  uri?: string;                 // OEH-URI für späteren API-Aufruf
  persona?: string;
  primary?: boolean;
}

export type FlowStepType = 'message' | 'choice' | 'multiChoice' | 'freetext' | 'mcp_search' | 'chat';

export interface FlowStep {
  id: string;
  type: FlowStepType;
  field?: string;
  message?: string;
  personaMessages?: Record<string, string>;
  options?: FlowOption[];
  skipLabel?: string;
  placeholder?: string;
  suggestions?: string[];       // Vorschlag-Chips für Freitext-Schritte
  next?: string;
}

export interface BoerdiConfig {
  bot: BotConfig;
  api: ApiConfig;
  mcp: McpConfig;
  personas: Record<string, PersonaConfig>;
  flow: FlowStep[];
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private config: BoerdiConfig | null = null;

  constructor(private http: HttpClient) {}

  async load(): Promise<BoerdiConfig> {
    if (this.config) return this.config;
    const raw = await firstValueFrom(
      this.http.get('assets/boerdi-config.yml', { responseType: 'text' })
    );
    this.config = yaml.load(raw) as BoerdiConfig;
    await this.loadPersonaFiles();
    return this.config;
  }

  /** Lädt alle Persona-Markdown-Dateien und speichert den Inhalt als systemPrompt */
  private async loadPersonaFiles(): Promise<void> {
    if (!this.config) return;
    const personas = this.config.personas;
    await Promise.all(
      Object.values(personas).map(async persona => {
        if (!persona.personaFile) return;
        try {
          persona.systemPrompt = await firstValueFrom(
            this.http.get(persona.personaFile, { responseType: 'text' })
          );
        } catch {
          persona.systemPrompt = `Du bist Boerdi, ein hilfreicher Assistent für WirLernenOnline.de.`;
        }
      })
    );
  }

  get(): BoerdiConfig {
    if (!this.config) throw new Error('Config not loaded yet. Call load() first.');
    return this.config;
  }

  getStep(id: string): FlowStep | undefined {
    return this.config?.flow.find(s => s.id === id);
  }

  getPersona(id: string): PersonaConfig | undefined {
    return this.config?.personas[id] ?? this.config?.personas['other'];
  }

  /** Gibt den Nachrichtentext für einen Schritt zurück – persona-aware */
  getMessage(step: FlowStep, persona: string): string {
    if (step.personaMessages?.[persona]) return step.personaMessages[persona];
    // Fallback-Kette: other → erster vorhandener personaMessage → message
    if (step.personaMessages?.['other']) return step.personaMessages['other'];
    const first = Object.values(step.personaMessages ?? {}).find(Boolean);
    return first ?? step.message ?? '';
  }
}
