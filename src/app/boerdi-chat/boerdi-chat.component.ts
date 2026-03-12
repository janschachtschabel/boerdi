import {
  Component, OnInit, AfterViewChecked, ViewChild, ElementRef,
  signal, computed, inject
} from '@angular/core';
import { environment } from '../../environments/environment';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { ConfigService, FlowStep, BoerdiConfig } from '../services/config.service';
import { WorkflowService, ChatMessage, MessageOption, UserProfile } from '../services/workflow.service';
import { McpService } from '../services/mcp.service';
import { LlmService, LlmMessage, LlmTool } from '../services/llm.service';

@Component({
  selector: 'boerdi-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './boerdi-chat.component.html',
  styleUrls: ['./boerdi-chat.component.scss'],
})
export class BoerdiChatComponent implements OnInit, AfterViewChecked {
  @ViewChild('messagesContainer') messagesContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('inputField') inputField!: ElementRef<HTMLInputElement>;

  private config = inject(ConfigService);
  readonly wf = inject(WorkflowService);
  private mcp = inject(McpService);
  private llm = inject(LlmService);

  boerdiConfig: BoerdiConfig | null = null;
  userInput = signal('');
  isInputDisabled = computed(() => this.wf.isLoading());
  expandedDebugId = signal<string | null>(null);

  // Chat history for LLM context (ohne system message – die kommt von Persona)
  private chatHistory: LlmMessage[] = [];
  private shouldScrollToBottom = false;

  async ngOnInit(): Promise<void> {
    this.boerdiConfig = await this.config.load();
    this.mcp.setServerUrl(this.boerdiConfig.mcp.serverUrl);
    this.llm.configure(this.boerdiConfig.api, environment.apiKey ?? '');
    await this.startFlow();
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  // ── Flow Engine ───────────────────────────────────────────────────────────────
  async startFlow(): Promise<void> {
    this.wf.reset();
    await this.processStep('welcome');
  }

  private async processStep(stepId: string): Promise<void> {
    const step = this.config.getStep(stepId);
    if (!step) {
      console.warn('Unbekannter Step:', stepId);
      return;
    }

    this.wf.goToStep(stepId);
    this.shouldScrollToBottom = true;

    switch (step.type) {
      case 'message':   await this.handleMessageStep(step); break;
      case 'choice':    await this.handleChoiceStep(step); break;
      case 'multiChoice': await this.handleMultiChoiceStep(step); break;
      case 'freetext':  await this.handleFreetextStep(step); break;
      case 'mcp_search': await this.handleMcpSearchStep(step); break;
      case 'chat':      await this.handleChatStep(step); break;
    }
  }

  private async handleMessageStep(step: FlowStep): Promise<void> {
    const msg = this.config.getMessage(step, this.wf.profile().persona);
    this.wf.addBotMessage(msg, undefined, step.id);
    await this.delay(400);
    if (step.next) await this.processStep(step.next);
  }

  private async handleChoiceStep(step: FlowStep): Promise<void> {
    const text = this.config.getMessage(step, this.wf.profile().persona);
    const options: MessageOption[] = (step.options ?? []).map(o => ({
      label: o.label,
      value: o.value,
      uri: o.uri,
      persona: o.persona,
      primary: o.primary,
    }));
    this.wf.addBotMessage(text, options, step.id);
  }

  private async handleMultiChoiceStep(step: FlowStep): Promise<void> {
    const text = this.config.getMessage(step, this.wf.profile().persona);
    const opts = step.options ?? [];
    const msgId = this.wf.addBotMultiChoice(text, opts, step.id).id;
    this.currentMultiChoiceMsgId = msgId;
    this.currentMultiChoiceStep = step;
  }

  private currentMultiChoiceMsgId: string | null = null;
  private currentMultiChoiceStep: FlowStep | null = null;

  private async handleFreetextStep(step: FlowStep): Promise<void> {
    const text = this.config.getMessage(step, this.wf.profile().persona);
    this.wf.addBotMessage(text, undefined, step.id);
    // Input-Feld ist jetzt aktiv – User-Input wird über sendMessage() verarbeitet
  }

  private async handleMcpSearchStep(step: FlowStep): Promise<void> {
    const interest = this.wf.profile().interest;
    const mcpCfg = this.boerdiConfig!.mcp;

    // MCP-Status anzeigen
    const statusId = this.wf.addStatusMessage(`🔍 MCP wird abgefragt: "${interest}" …`, 'searching');
    this.wf.isLoading.set(true);
    const loadMsg = this.wf.addLoadingMessage();

    try {
      const rawResults = await this.mcp.search(interest, mcpCfg.searchTool);
      this.wf.updateStatus(statusId, `✅ MCP geantwortet – ${mcpCfg.serverUrl}`, this.mcp.lastCallRaw || rawResults);

      const persona = this.config.getPersona(this.wf.profile().persona)!;
      const summaryPrompt: LlmMessage = {
        role: 'user',
        content: `Der Nutzer interessiert sich für: "${interest}"\n\nHier sind rohe Suchergebnisse vom Bildungs-MCP-Server:\n\n${rawResults}\n\nFasse diese Ergebnisse hilfreich und übersichtlich zusammen. Hebe die wichtigsten 2–3 Treffer hervor. Formatiere mit Markdown.`,
      };

      const summary = await this.llm.chat([...this.chatHistory, summaryPrompt], persona, 0.6);
      this.chatHistory.push(summaryPrompt, { role: 'assistant', content: summary });
      this.wf.replaceMessage(loadMsg.id, summary);
    } catch (e: any) {
      this.wf.updateStatus(statusId, `❌ MCP-Fehler: ${e.message}`);
      this.wf.replaceMessage(loadMsg.id, `❌ Fehler bei der Suche: ${(e as Error).message}`);
    } finally {
      this.wf.isLoading.set(false);
    }

    if (step.next) await this.processStep(step.next);
  }

  private async handleChatStep(step: FlowStep): Promise<void> {
    const text = this.config.getMessage(step, this.wf.profile().persona);
    this.wf.addBotMessage(text, undefined, step.id);
    // Jetzt im freien Chat-Modus – weitere Nachrichten gehen durch sendChatMessage()
  }

  // ── User Interactions ─────────────────────────────────────────────────────────
  async selectOption(option: MessageOption, msgId: string): Promise<void> {
    const step = this.config.getStep(this.wf.currentStepId());
    if (!step) return;

    this.wf.disableOptions(msgId);
    this.wf.addUserMessage(option.label);

    if (option.persona) {
      this.wf.setPersona(option.persona);
    }
    if (step.field) {
      this.wf.setField(step.field as keyof UserProfile, option.value);
    }
    // OEH-URI in das passende Profil-Feld schreiben
    if (option.uri) {
      if (step.field === 'educationLevels') {
        this.wf.setField('educationLevelUris' as keyof UserProfile, [option.uri]);
      } else {
        this.wf.setField('roleUri' as keyof UserProfile, option.uri);
      }
    }

    await this.delay(200);
    if (step.next) await this.processStep(step.next);
  }

  toggleMultiOption(msgId: string, value: string): void {
    this.wf.toggleMultiOption(msgId, value);
  }

  async confirmMultiChoice(): Promise<void> {
    if (!this.currentMultiChoiceStep || !this.currentMultiChoiceMsgId) return;

    const selected = this.wf.getSelectedMultiOptions(this.currentMultiChoiceMsgId);
    const step = this.currentMultiChoiceStep;

    this.wf.disableOptions(this.currentMultiChoiceMsgId);

    const displayText = selected.length > 0
      ? selected.join(', ')
      : step.skipLabel ?? 'Übersprungen';
    this.wf.addUserMessage(displayText);

    if (step.field && selected.length > 0) {
      this.wf.setField(step.field as keyof UserProfile, selected);
    }
    // OEH-URIs der gewählten Bildungsstufen durchreichen
    const selectedUris = this.wf.getSelectedMultiUris(this.currentMultiChoiceMsgId!);
    if (selectedUris.length > 0) {
      this.wf.setField('educationLevelUris' as keyof UserProfile, selectedUris);
    }

    this.currentMultiChoiceMsgId = null;
    this.currentMultiChoiceStep = null;

    await this.delay(200);
    if (step.next) await this.processStep(step.next);
  }

  async skipMultiChoice(): Promise<void> {
    if (!this.currentMultiChoiceStep) return;
    const step = this.currentMultiChoiceStep;
    if (this.currentMultiChoiceMsgId) this.wf.disableOptions(this.currentMultiChoiceMsgId);
    this.wf.addUserMessage(step.skipLabel ?? 'Übersprungen');
    this.currentMultiChoiceMsgId = null;
    this.currentMultiChoiceStep = null;
    await this.delay(200);
    if (step.next) await this.processStep(step.next);
  }

  async sendMessage(): Promise<void> {
    const text = this.userInput().trim();
    if (!text || this.wf.isLoading()) return;
    this.userInput.set('');

    const currentStep = this.config.getStep(this.wf.currentStepId());

    if (currentStep?.type === 'freetext') {
      this.wf.addUserMessage(text);
      if (currentStep.field) {
        this.wf.setField(currentStep.field as keyof UserProfile, text);
      }
      await this.delay(200);
      if (currentStep.next) await this.processStep(currentStep.next);
    } else if (currentStep?.type === 'chat') {
      await this.sendChatMessage(text);
    } else {
      // Freitextantwort in allen anderen Kontexten
      this.wf.addUserMessage(text);
      await this.sendChatMessage(text);
    }
  }

  private async sendChatMessage(text: string): Promise<void> {
    const loadMsg = this.wf.addLoadingMessage();
    this.wf.isLoading.set(true);

    const profile = this.wf.profile();
    const persona = this.config.getPersona(profile.persona)!;
    const mcpCfg = this.boerdiConfig!.mcp;

    this.chatHistory.push({ role: 'user', content: text });

    try {
      // MCP als Tool für den LLM anbieten
      const tools: LlmTool[] = [
        {
          type: 'function',
          function: {
            name: 'search_educational_content',
            description: 'Sucht Bildungsinhalte und Lernmaterialien auf WirLernenOnline.de / MCP-Server',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Suchbegriff oder Thema' },
              },
              required: ['query'],
            },
          },
        },
      ];

      let choice = await this.llm.chatWithTools(this.chatHistory, persona, tools, 0.7);

      // Tool-Call-Loop
      while (choice.finish_reason === 'tool_calls') {
        const toolCalls = choice.message.tool_calls ?? [];
        this.chatHistory.push({ role: 'assistant', content: choice.message.content ?? '' });

        const toolResults: LlmMessage[] = [];
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          const query = args.query ?? text;
          // MCP-Nutzung im Chat sichtbar machen
          const sid = this.wf.addStatusMessage(`🔍 MCP-Tool: "${query}" …`, 'searching');
          const result = await this.mcp.search(query, mcpCfg.searchTool);
          this.wf.updateStatus(sid, `✅ MCP: "${query}"`, this.mcp.lastCallRaw || result);
          toolResults.push({ role: 'user', content: `[Tool-Ergebnis für "${query}"]: ${result}` });
        }

        this.chatHistory.push(...toolResults);
        choice = await this.llm.chatWithTools(this.chatHistory, persona, tools, 0.7);
      }

      const reply = choice.message.content ?? '(keine Antwort)';
      this.chatHistory.push({ role: 'assistant', content: reply });
      this.wf.replaceMessage(loadMsg.id, reply);

    } catch (e: any) {
      this.wf.replaceMessage(loadMsg.id, `❌ Fehler: ${e.message}`);
    } finally {
      this.wf.isLoading.set(false);
      this.shouldScrollToBottom = true;
    }
  }

  // ── Debug + Suggestions ──────────────────────────────────────────────────────
  toggleDebug(id: string): void {
    this.expandedDebugId.update(cur => cur === id ? null : id);
  }

  getSuggestionsForCurrentStep(): string[] {
    const step = this.config.getStep(this.wf.currentStepId());
    return step?.suggestions ?? [];
  }

  selectSuggestion(text: string): void {
    this.userInput.set(text);
    this.sendMessage();
  }

  copyDebug(text: string): void {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  renderMarkdown(text: string): string {
    if (!text) return '';
    return marked.parse(text) as string;
  }

  isMultiChoiceActive(step: FlowStep | undefined): boolean {
    return step?.type === 'multiChoice' && !!this.currentMultiChoiceMsgId;
  }

  isFreetextActive(): boolean {
    const step = this.config.getStep(this.wf.currentStepId());
    return step?.type === 'freetext' || step?.type === 'chat';
  }

  getPlaceholder(): string {
    const step = this.config.getStep(this.wf.currentStepId());
    return step?.placeholder ?? 'Nachricht schreiben …';
  }

  trackById(_: number, msg: ChatMessage): string {
    return msg.id;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  private scrollToBottom(): void {
    try {
      const el = this.messagesContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } catch {}
  }
}
