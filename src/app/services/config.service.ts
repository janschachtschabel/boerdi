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

export type LlmProvider = 'bapi' | 'openai';

export interface ApiConfig {
  baseUrl: string;
  model: string;
  apiKeyHeader: string;
  apiKey?: string;
  provider?: LlmProvider;
}

export interface McpConfig {
  serverUrl: string;
  searchTool: string;
  fetchTool: string;
}

export interface PersonaConfig {
  label: string;
  uri: string;
  personaFile?: string;         // Pfad zur Markdown-Datei in assets/personas/ (optional)
  systemPrompt?: string;        // inline (FlowStudio-Export) oder zur Laufzeit aus Datei geladen
}

export interface DockedToolConfig {
  id: string;
  type: string;              // 'tool_mcp' | 'tool_rag'
  mcpServer?: string;
  tools?: string[];          // undefined/empty = all available tools
  params?: Record<string, unknown>;
}

export interface FlowOption {
  label: string;
  value: string;
  uri?: string;                 // OEH-URI für späteren API-Aufruf
  persona?: string;
  primary?: boolean;
  next?: string;                // Überschreibt step.next für diese Option (Loop/Rücksprung).
                                // Sonderwerte: '__restart' (Flow neu starten), '__back' (vorheriger Step)
}

export type FlowStepType = 'message' | 'choice' | 'multiChoice' | 'freetext' | 'mcp_search' | 'chat' | 'gateway' | 'handoff' | 'input';

/** One branch in a gateway step */
export interface GatewayBranch {
  label: string;
  next?: string;
  // splitBy='condition':
  field?: string;
  operator?: 'equals' | 'not_equals' | 'contains';
  value?: string;
  // splitBy='persona':
  personaId?: string;
  // splitBy='intent' (regex):
  intentPattern?: string;
  // splitBy='ai_intent' (LLM classifies — no fixed pattern):
  intentDescription?: string;
}

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
  // gateway-specific:
  splitBy?: 'condition' | 'persona' | 'intent' | 'ai_intent';
  branches?: GatewayBranch[];
  default?: string;             // fallback next when no branch matches
  // handoff-specific:
  handoffTarget?: string;
  handoffMessage?: string;
  // docked tool/persona attachments (FlowStudio export format):
  dockedTools?: DockedToolConfig[];
  dockedPersona?: { mode: string; personaId?: string };
}

export interface FlowDefinition {
  id: string;
  name: string;
  description?: string;
  configFile: string;           // path to YAML, e.g. 'assets/flows/boerdi-wlo/config.yml'
  default?: boolean;            // true = auto-select without selection screen
}

export interface BoerdiConfig {
  bot: BotConfig;
  api: ApiConfig;
  mcp: McpConfig;
  personas: Record<string, PersonaConfig>;
  flow: FlowStep[];
  flowStart?: string;           // erster Schritt (aus FlowStudio-Format: flow.start)
  flows?: FlowDefinition[];     // optional multi-flow registry
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private config: BoerdiConfig | null = null;
  private activeConfigFile = 'assets/boerdi-config.yml';
  private configBasePath   = '';  // e.g. 'assets/flows/boerdi-wlo/' – used to resolve relative personaFile paths

  constructor(private http: HttpClient) {}

  async load(): Promise<BoerdiConfig> {
    if (this.config) return this.config;
    return this.loadFromFile(this.activeConfigFile);
  }

  /** Lädt eine Config-Datei (Boerdi-Format ODER FlowStudio-Export) und normalisiert sie */
  async loadFromFile(filePath: string): Promise<BoerdiConfig> {
    this.activeConfigFile = filePath;
    this.config = null;
    // Compute the directory of the config file for relative personaFile resolution.
    // e.g. 'assets/flows/wlo-website-bot/config.yml' → 'assets/flows/wlo-website-bot/'
    const lastSlash = filePath.lastIndexOf('/');
    this.configBasePath = lastSlash >= 0 ? filePath.substring(0, lastSlash + 1) : '';
    const raw = await firstValueFrom(
      this.http.get(filePath, { responseType: 'text' })
    );
    this.config = this.normalizeConfig(yaml.load(raw));
    await this.resolvePersonaPrompts();
    return this.config;
  }

  /** Lädt die Flow-Registry aus der Standard-Config */
  async loadFlowRegistry(): Promise<FlowDefinition[]> {
    const raw = await firstValueFrom(
      this.http.get('assets/boerdi-config.yml', { responseType: 'text' })
    );
    const doc = yaml.load(raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      console.error('[ConfigService] loadFlowRegistry: unexpected YAML root type', doc);
      return [];
    }
    const flows = (doc as Record<string, unknown>)['flows'];
    if (!Array.isArray(flows)) {
      console.warn('[ConfigService] loadFlowRegistry: no flows[] in boerdi-config.yml', doc);
      return [];
    }
    return flows as FlowDefinition[];
  }

  // ── Normalisierung ────────────────────────────────────────────────────────────
  // Versteht BEIDE Formate:
  //   A) Boerdi-Eigenformat  (personas: {id: {label, personaFile, …}}, flow: [{…}])
  //   B) FlowStudio-Export   (personas: [{id, label, uri, systemPrompt?}], flow: {start, steps:[…]})

  private normalizeConfig(raw: unknown): BoerdiConfig {
    // Use typed doc to avoid noPropertyAccessFromIndexSignature errors
    const doc = raw as {
      bot?: { name?: string; avatar?: string; tagline?: string };
      api?: { baseUrl?: string; model?: string; apiKeyHeader?: string; mcpServerUrl?: string };
      mcp?: { serverUrl?: string; searchTool?: string; fetchTool?: string };
      personas?: unknown;
      flow?: unknown;
      flows?: FlowDefinition[];
    };

    // ── 1. bot ─────────────────────────────────────────────────────────────────
    const bot: BotConfig = {
      name:    String(doc.bot?.name    ?? 'Boerdi'),
      avatar:  String(doc.bot?.avatar  ?? '🦉'),
      tagline: String(doc.bot?.tagline ?? ''),
    };

    // ── 2. api + mcp ──────────────────────────────────────────────────────────
    const rawProvider = (doc.api as Record<string, unknown>)?.['provider'] as string | undefined;
    const provider: LlmProvider | undefined = rawProvider === 'openai' ? 'openai' : rawProvider === 'bapi' ? 'bapi' : undefined;
    const api: ApiConfig = {
      baseUrl:      String(doc.api?.baseUrl      ?? '/bapi-proxy'),
      model:        String(doc.api?.model        ?? 'gpt-4.1-mini'),
      apiKeyHeader: String(doc.api?.apiKeyHeader ?? 'X-API-KEY'),
      provider,
    };
    const mcp: McpConfig = {
      // FlowStudio puts mcpServerUrl in api section; Boerdi uses separate mcp.serverUrl
      serverUrl:  String(doc.mcp?.serverUrl  ?? doc.api?.mcpServerUrl  ?? ''),
      searchTool: String(doc.mcp?.searchTool ?? 'search_wlo_collections'),
      fetchTool:  String(doc.mcp?.fetchTool  ?? 'fetch_web_content'),
    };

    // ── 3. personas ───────────────────────────────────────────────────────────
    const rawPersonas = doc.personas;
    let personas: Record<string, PersonaConfig>;

    if (Array.isArray(rawPersonas)) {
      // FlowStudio format: [{id, label, uri, systemPrompt?}]
      personas = {};
      for (const p of rawPersonas as Array<{ id?: string; label?: string; uri?: string; personaFile?: string; systemPrompt?: string }>) {
        const id = String(p.id ?? '');
        personas[id] = {
          label:        String(p.label ?? id),
          uri:          String(p.uri   ?? ''),
          // Explicit path only – relative paths are resolved in resolvePersonaPrompts().
          // Inline systemPrompt always takes priority (no HTTP round-trip needed).
          personaFile:  p.personaFile ?? undefined,
          systemPrompt: p.systemPrompt ?? undefined,
        };
      }
    } else if (rawPersonas && typeof rawPersonas === 'object') {
      // Boerdi format: {id: {label, uri, personaFile?}}
      personas = rawPersonas as Record<string, PersonaConfig>;
    } else {
      personas = {};
    }

    // ── 4. flow ───────────────────────────────────────────────────────────────
    const rawFlow = doc.flow;
    let flow: FlowStep[];
    let flowStart: string | undefined;

    if (Array.isArray(rawFlow)) {
      // Boerdi format: flat array
      flow = rawFlow as FlowStep[];
      flowStart = flow[0]?.id;
    } else if (rawFlow && typeof rawFlow === 'object') {
      // FlowStudio format: {start: 'id', steps: [...]}
      const flowDoc = rawFlow as { start?: string; steps?: FlowStep[] };
      flow = flowDoc.steps ?? [];
      flowStart = flowDoc.start ?? flow[0]?.id;
    } else {
      flow = [];
    }

    // Normalize handoff field names: FlowStudio exports target/farewell
    flow = flow.map(step => {
      if (step.type === 'handoff') {
        const s = step as unknown as { target?: string; farewell?: string };
        return {
          ...step,
          handoffTarget:  step.handoffTarget  ?? s.target   ?? undefined,
          handoffMessage: step.handoffMessage ?? s.farewell ?? undefined,
        };
      }
      return step;
    });

    return {
      bot, api, mcp, personas, flow, flowStart,
      flows: doc.flows ?? undefined,
    };
  }

  // ── Persona-Prompts auflösen ──────────────────────────────────────────────────
  // Reihenfolge: 1) bereits inline (FlowStudio-Export), 2) personaFile laden, 3) Default
  // personaFile-Pfade werden relativ zum configBasePath aufgelöst wenn sie nicht absolut sind.

  private async resolvePersonaPrompts(): Promise<void> {
    if (!this.config) return;
    await Promise.all(
      Object.values(this.config.personas).map(async persona => {
        if (persona.systemPrompt) return; // already set inline
        if (persona.personaFile) {
          // Resolve relative paths (no leading slash, no 'assets/') against config directory
          const isRelative = !persona.personaFile.startsWith('/') && !persona.personaFile.startsWith('assets/');
          const resolvedPath = isRelative ? `${this.configBasePath}${persona.personaFile}` : persona.personaFile;
          try {
            persona.systemPrompt = await firstValueFrom(
              this.http.get(resolvedPath, { responseType: 'text' })
            );
            return;
          } catch { /* file not found – fall through */ }
        }
        persona.systemPrompt = 'Du bist ein hilfreicher Assistent für WirLernenOnline.de.';
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
    if (step.personaMessages?.['other']) return step.personaMessages['other'];
    const first = Object.values(step.personaMessages ?? {}).find(Boolean);
    return first ?? step.message ?? '';
  }
}
