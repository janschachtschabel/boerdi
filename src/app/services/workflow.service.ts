import { Injectable, signal, computed } from '@angular/core';
import { FlowStep, FlowStepType } from './config.service';

export interface UserProfile {
  role: string;                  // learner | teacher | other
  persona: string;               // aktive Persona-ID
  roleUri: string;               // OEH-URI: intendedEndUserRole
  educationLevels: string[];
  educationLevelUris: string[];  // OEH-URIs: educationalContext
  interest: string;
}

export interface ChatMessage {
  id: string;
  sender: 'bot' | 'user';
  content: string;         // Markdown-Text
  options?: MessageOption[];
  multiOptions?: MultiOption[];
  wloCards?: WloCard[];    // WLO-Kacheln (Sammlungen/Inhalte)
  cardsPagination?: CardsPagination; // Pagination state für Sammlungsinhalte
  isLoading?: boolean;
  statusType?: 'searching' | 'done' | 'error'; // MCP-Status-Badge
  debugInfo?: string;          // Rohresponse vom MCP zur Debug-Anzeige
  stepId?: string;
  timestamp: Date;
}

export interface MessageOption {
  label: string;
  value: string;
  uri?: string;      // OEH-URI
  persona?: string;
  primary?: boolean;
}

export interface MultiOption {
  label: string;
  value: string;
  uri?: string;      // OEH-URI für späteren API-Aufruf
  selected: boolean;
}

export interface CardsPagination {
  nodeId: string;
  title: string;
  skip: number;
  total: number;
}

export interface WloCard {
  nodeId: string;
  title: string;
  description: string;
  disciplines: string[];
  educationalContexts: string[];
  keywords: string[];
  learningResourceTypes: string[];
  url: string;
  wloUrl: string;
  previewUrl: string;
  license: string;
  publisher: string;
  nodeType: 'collection' | 'content';
}

@Injectable({ providedIn: 'root' })
export class WorkflowService {
  // ── State ────────────────────────────────────────────────────────────────────
  readonly currentStepId = signal<string>('welcome');
  readonly profile = signal<UserProfile>({
    role: 'other',
    persona: 'other',
    roleUri: 'http://w3id.org/openeduhub/vocabs/intendedEndUserRole/other',
    educationLevels: [],
    educationLevelUris: [],
    interest: '',
  });
  readonly messages = signal<ChatMessage[]>([]);
  readonly isLoading = signal<boolean>(false);
  readonly isComplete = computed(() => this.currentStepId() === 'done');

  private stepHistory: string[] = [];
  private idCounter = 0;

  // ── Navigation ───────────────────────────────────────────────────────────────
  goToStep(stepId: string): void {
    this.stepHistory.push(this.currentStepId());
    this.currentStepId.set(stepId);
  }

  goBack(): void {
    const prev = this.stepHistory.pop();
    if (prev) this.currentStepId.set(prev);
  }

  reset(): void {
    this.currentStepId.set('welcome');
    this.stepHistory = [];
    this.profile.set({
      role: 'other', persona: 'other',
      roleUri: 'http://w3id.org/openeduhub/vocabs/intendedEndUserRole/other',
      educationLevels: [], educationLevelUris: [], interest: ''
    });
    this.messages.set([]);
    this.isLoading.set(false);
  }

  // ── Profile ──────────────────────────────────────────────────────────────────
  setPersona(persona: string): void {
    this.profile.update(p => ({ ...p, persona }));
  }

  setField(field: keyof UserProfile, value: string | string[]): void {
    this.profile.update(p => ({ ...p, [field]: value }));
  }

  // ── Messages ─────────────────────────────────────────────────────────────────
  addBotMessage(content: string, options?: MessageOption[], stepId?: string): ChatMessage {
    const msg: ChatMessage = {
      id: `msg-${++this.idCounter}`,
      sender: 'bot',
      content,
      options,
      stepId,
      timestamp: new Date(),
    };
    this.messages.update(msgs => [...msgs, msg]);
    return msg;
  }

  addBotMultiChoice(content: string, opts: Array<{ label: string; value: string; uri?: string }>, stepId?: string): ChatMessage {
    const msg: ChatMessage = {
      id: `msg-${++this.idCounter}`,
      sender: 'bot',
      content,
      multiOptions: opts.map(o => ({ ...o, uri: o.uri, selected: false })),
      stepId,
      timestamp: new Date(),
    };
    this.messages.update(msgs => [...msgs, msg]);
    return msg;
  }

  addUserMessage(content: string): void {
    this.messages.update(msgs => [
      ...msgs,
      { id: `msg-${++this.idCounter}`, sender: 'user', content, timestamp: new Date() },
    ]);
  }

  addLoadingMessage(): ChatMessage {
    const msg: ChatMessage = {
      id: `msg-${++this.idCounter}`,
      sender: 'bot',
      content: '',
      isLoading: true,
      timestamp: new Date(),
    };
    this.messages.update(msgs => [...msgs, msg]);
    return msg;
  }

  replaceMessage(id: string, content: string, wloCards?: WloCard[]): void {
    this.messages.update(msgs =>
      msgs.map(m => (m.id === id ? { ...m, content, isLoading: false, ...(wloCards ? { wloCards } : {}) } : m))
    );
  }

  setMessageCards(id: string, wloCards: WloCard[]): void {
    this.messages.update(msgs =>
      msgs.map(m => (m.id === id ? { ...m, wloCards } : m))
    );
  }

  setMessagePagination(id: string, pagination: CardsPagination): void {
    this.messages.update(msgs =>
      msgs.map(m => (m.id === id ? { ...m, cardsPagination: pagination } : m))
    );
  }

  /** Deaktiviert alle Buttons einer Nachricht (nach Auswahl) */
  disableOptions(msgId: string): void {
    this.messages.update(msgs =>
      msgs.map(m => {
        if (m.id !== msgId) return m;
        return {
          ...m,
          options: m.options?.map(o => ({ ...o, disabled: true })),
          multiOptions: m.multiOptions?.map(o => ({ ...o, disabled: true })),
        };
      })
    );
  }

  toggleMultiOption(msgId: string, value: string): void {
    this.messages.update(msgs =>
      msgs.map(m => {
        if (m.id !== msgId) return m;
        return {
          ...m,
          multiOptions: m.multiOptions?.map(o =>
            o.value === value ? { ...o, selected: !o.selected } : o
          ),
        };
      })
    );
  }

  getSelectedMultiOptions(msgId: string): string[] {
    const msg = this.messages().find(m => m.id === msgId);
    return msg?.multiOptions?.filter(o => o.selected).map(o => o.value) ?? [];
  }

  getSelectedMultiUris(msgId: string): string[] {
    const msg = this.messages().find(m => m.id === msgId);
    return msg?.multiOptions?.filter(o => o.selected && o.uri).map(o => o.uri!) ?? [];
  }

  /** Fügt eine MCP-Status-Zeile ein und gibt die ID zurück */
  addStatusMessage(content: string, type: 'searching' | 'done' | 'error'): string {
    const msg: ChatMessage = {
      id: `msg-${++this.idCounter}`,
      sender: 'bot',
      content,
      statusType: type,
      timestamp: new Date(),
    };
    this.messages.update(msgs => [...msgs, msg]);
    return msg.id;
  }

  /** Aktualisiert Text, Typ und optional den Debug-Inhalt einer Status-Nachricht */
  updateStatus(id: string, content: string, debugInfo?: string): void {
    this.messages.update(msgs =>
      msgs.map(m =>
        m.id === id
          ? {
              ...m,
              content,
              statusType: content.startsWith('❌') ? 'error' : 'done',
              ...(debugInfo !== undefined ? { debugInfo } : {}),
            }
          : m
      )
    );
  }
}
