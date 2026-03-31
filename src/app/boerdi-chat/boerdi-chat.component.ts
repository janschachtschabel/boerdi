import {
  Component, OnInit, AfterViewChecked, ViewChild, ElementRef,
  signal, computed, inject
} from '@angular/core';
import { environment } from '../../environments/environment';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { ConfigService, FlowStep, BoerdiConfig } from '../services/config.service';
import { WorkflowService, ChatMessage, MessageOption, UserProfile, WloCard, CardsPagination } from '../services/workflow.service';
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
    const cfg = this.config.get();
    const startStepId = cfg.flowStart ?? cfg.flow[0]?.id ?? 'welcome';
    await this.processStep(startStepId);
  }

  private async processStep(stepId: string): Promise<void> {
    // ── Sonderwerte ────────────────────────────────────────────────────────────
    if (stepId === '__restart') { await this.startFlow(); return; }
    if (stepId === '__back')    { this.wf.goBack(); const prev = this.wf.currentStepId(); if (prev) await this.processStep(prev); return; }

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
      case 'freetext':
      case 'input':     await this.handleFreetextStep(step); break;
      case 'mcp_search': await this.handleMcpSearchStep(step); break;
      case 'chat':      await this.handleChatStep(step); break;
      case 'gateway':   await this.handleGatewayStep(step); break;
      case 'handoff':   await this.handleHandoffStep(step); break;
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
      next: o.next,
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
    const profile  = this.wf.profile();
    const mcpCfg   = this.boerdiConfig!.mcp;

    const statusId = this.wf.addStatusMessage(`🔍 Suche Themenseiten: „${interest}" …`, 'searching');
    this.wf.isLoading.set(true);
    const loadMsg = this.wf.addLoadingMessage();

    try {
      const toArr = (v: string | string[]): string[] => Array.isArray(v) ? v : (v ? [v] : []);
      const levelUris = toArr(profile.educationLevelUris);
      const levels    = toArr(profile.educationLevels);
      const persona   = this.config.getPersona(profile.persona)!;
      const filters: Record<string, unknown> = {};
      if (levelUris.length) filters['educationalContext'] = levelUris[0];
      if (profile.roleUri)  filters['userRole'] = profile.roleUri;

      // ── Phase 1: direkte Suche ────────────────────────────────────────────
      const { rawResults, usedTool } = await this.guidedCollectionSearch(
        interest, filters, statusId, persona
      );

      this.wf.updateStatus(statusId, `✅ ${usedTool} – Ergebnisse erhalten`, rawResults);
      const cardDefault = usedTool === 'search_wlo_content' ? 'content' : 'collection';
      const cards = this.parseWloCards(rawResults, cardDefault);
      const resultType = usedTool === 'search_wlo_content' ? 'einzelne Lernmaterialien' : 'Themenseiten (Sammlungen)';

      const topicPageCards = cards.filter(c => !!c.topicPageUrl);
      const topicPageHint = topicPageCards.length > 0
        ? `\n\nWichtig: ${topicPageCards.length} Sammlung(en) haben eine kuratierte **Themenseite** (erkennbar am 📄-Button auf der Kachel). Themenseiten bieten eine übersichtliche, redaktionell aufbereitete Darstellung mit Swimlanes – ideal zum Stöbern. Erwähne das kurz und empfiehl die Themenseite, wenn passend.`
        : '';

      const summaryPrompt: LlmMessage = {
        role: 'user',
        content: `Der Nutzer interessiert sich für: „${interest}". Bildungsstufe: ${levels.join(', ') || 'nicht angegeben'}. Rolle: ${profile.role}.

Gefundene ${resultType} aus WLO:

${rawResults}

Fasse kurz in 2–3 Sätzen zusammen, was gefunden wurde. Wenn du Titel von Sammlungen/Inhalten erwähnst, verlinke sie mit der zugehörigen URL aus den Ergebnissen im Markdown-Format [Titel](URL). Hinweis: Die Kacheln sind bereits als visuelle Karten sichtbar – kein nochmaliges Auflisten nötig.${topicPageHint}`,
      };
      const summary = await this.llm.chat([...this.chatHistory, summaryPrompt], persona, 0.6);
      this.chatHistory.push(summaryPrompt, { role: 'assistant', content: summary });
      this.wf.replaceMessage(loadMsg.id, summary, cards.length ? cards : undefined);

    } catch (e: any) {
      this.wf.updateStatus(statusId, `❌ MCP-Fehler: ${e.message}`);
      this.wf.replaceMessage(loadMsg.id, `❌ Fehler bei der Suche: ${(e as Error).message}`);
    } finally {
      this.wf.isLoading.set(false);
    }

    if (step.next) await this.processStep(step.next);
  }

  /**
   * LLM-guided tree traversal for WLO collections.
   *
   * Strategy:
   *   1. Standard search (Level 1+2+3 on MCP server) – fast, covers broad topics
   *   2. If empty → LLM picks best Level-1 node → search within it
   *   3. If still empty → LLM picks best Level-2 node within that → search within it
   *   4. If still empty → fall back to search_wlo_content (files/materials)
   */
  private async guidedCollectionSearch(
    query: string,
    filters: Record<string, unknown>,
    statusId: string,
    persona: import('../services/config.service').PersonaConfig
  ): Promise<{ rawResults: string; usedTool: string }> {
    const mcpText = (r: any): string =>
      (r.content as any[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n\n');
    const isEmpty = (t: string) => !t || t.toLowerCase().startsWith('keine');

    // ── Step 1: Standard server search (built-in L1→L2→L3 keyword match) ─────
    const step1 = await this.mcp.callTool('search_wlo_collections', { query, maxResults: 4, ...filters });
    const text1 = mcpText(step1);
    if (!isEmpty(text1)) return { rawResults: text1, usedTool: 'search_wlo_collections' };

    // ── Step 2: LLM-guided recursive traversal (up to 6 levels) ──────────────
    this.wf.updateStatus(statusId, `🤔 KI durchsucht Themenbaum für „${query}" …`, 'searching');
    const guided = await this.traverseTree(query, null, 0, 6, filters, statusId, persona);
    if (guided) return { rawResults: guided, usedTool: 'search_wlo_collections' };

    // ── Step 3: Fallback – full-text material search ──────────────────────────
    this.wf.updateStatus(statusId, `� Keine Sammlungen – suche Einzelmaterialien …`, 'searching');
    const contentRes = await this.mcp.callTool('search_wlo_content', { query, maxResults: 4, ...filters });
    const textContent = mcpText(contentRes);
    if (!isEmpty(textContent)) return { rawResults: textContent, usedTool: 'search_wlo_content' };

    return { rawResults: `Leider keine Ergebnisse für „${query}" gefunden.`, usedTool: 'search_wlo_collections' };
  }

  /**
   * Recursively traverses the WLO collection tree guided by the LLM.
   * At each level: browse children → LLM picks best → search within → if empty go deeper.
   */
  private async traverseTree(
    query: string,
    parentNodeId: string | null,
    depth: number,
    maxDepth: number,
    filters: Record<string, unknown>,
    statusId: string,
    persona: import('../services/config.service').PersonaConfig
  ): Promise<string | null> {
    const mcpText = (r: any): string =>
      (r.content as any[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n\n');
    const isEmpty = (t: string) => !t || t.toLowerCase().startsWith('keine');

    // Browse children at current level (empty query = list all)
    const browseArgs: Record<string, unknown> = { query: '', maxResults: 25 };
    if (parentNodeId) browseArgs['parentNodeId'] = parentNodeId;
    const browseRes = await this.mcp.callTool('search_wlo_collections', browseArgs);
    const browseText = mcpText(browseRes);
    if (isEmpty(browseText)) return null;

    // LLM picks the most relevant child
    const bestNodeId = await this.llmPickNode(query, browseText, persona);
    if (!bestNodeId) return null;

    const levelNames = ['Fachportal', 'Themenbereich', 'Unterthema', 'Kapitel', 'Abschnitt', 'Detailthema'];
    const levelLabel = levelNames[depth] ?? `Ebene ${depth + 1}`;
    const title = this.extractTitleForNode(browseText, bestNodeId);
    this.wf.updateStatus(statusId, `� ${levelLabel}: „${title || bestNodeId}" …`, 'searching');

    // Search within selected node
    const searchRes = await this.mcp.callTool('search_wlo_collections',
      { query, parentNodeId: bestNodeId, maxResults: 5, ...filters });
    const searchText = mcpText(searchRes);
    if (!isEmpty(searchText)) return searchText;

    // Nothing found → go one level deeper if budget allows
    if (depth < maxDepth) {
      return this.traverseTree(query, bestNodeId, depth + 1, maxDepth, filters, statusId, persona);
    }
    return null;
  }

  /** Asks the LLM to pick the most relevant nodeId from a renderToText listing. */
  private async llmPickNode(
    query: string,
    collectionsText: string,
    persona: import('../services/config.service').PersonaConfig
  ): Promise<string | null> {
    const prompt: LlmMessage = {
      role: 'user',
      content: `Verfügbare WLO-Sammlungen:\n\n${collectionsText}\n\nSuche: "${query}"\n\nAntworte NUR mit der nodeId der am besten passenden Sammlung (UUID-Format, z.B. abc12345-…). Falls keine passt: "none".`,
    };
    const answer = await this.llm.chat([prompt], persona, 0);
    return this.extractNodeId(answer);
  }

  /** Extracts the title of a specific nodeId from a renderToText block list. */
  private extractTitleForNode(text: string, nodeId: string): string {
    const blocks = text.split(/\n(?=## )/);
    for (const block of blocks) {
      if (block.includes(`nodeId: ${nodeId}`)) {
        return block.split('\n')[0].replace(/^##\s+/, '').trim();
      }
    }
    return '';
  }

  /** Extracts the first UUID from an LLM response string. */
  private extractNodeId(text: string): string | null {
    const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }

  /** Parst das renderToText-Format des WLO-MCP-Servers in WloCard-Objekte. */
  parseWloCards(text: string, defaultType: 'collection' | 'content' = 'content'): WloCard[] {
    if (!text) return [];
    const blocks = text.split(/\n(?=## )/);
    return blocks.map(block => {
      const lines = block.split('\n');
      const title = (lines[0] ?? '').replace(/^##\s+/, '').trim();
      const get = (key: string): string => {
        const line = lines.find(l => l.startsWith(key + ': '));
        return line ? line.slice(key.length + 2).trim() : '';
      };
      const getList = (key: string): string[] => {
        const val = get(key);
        return val ? val.split(', ').map(s => s.trim()).filter(Boolean) : [];
      };
      const nodeId = get('nodeId');
      return {
        nodeId,
        title,
        description: get('Beschreibung'),
        disciplines: getList('Fach'),
        educationalContexts: getList('Bildungsstufe'),
        keywords: getList('Schlagworte'),
        learningResourceTypes: getList('Ressourcentyp'),
        url: get('URL'),
        previewUrl: get('Vorschaubild'),
        license: get('Lizenz'),
        publisher: get('Anbieter'),
        wloUrl: nodeId
          ? `https://redaktion.openeduhub.net/edu-sharing/components/render/${nodeId}`
          : '',
        nodeType: get('Typ') === 'Sammlung' ? 'collection'
          : get('Typ') === 'Inhalt' ? 'content'
          : defaultType,
        topicPageUrl: get('Themenseite') || undefined,
      } as WloCard;
    }).filter(c => !!c.nodeId && !!c.title);
  }

  async browseCollection(nodeId: string, title: string, skip: number): Promise<void> {
    const statusId = this.wf.addStatusMessage(`Lade Inhalte von "${title}" ...`, 'searching');
    this.wf.isLoading.set(true);
    const loadMsg = this.wf.addLoadingMessage();
    try {
      const result = await this.mcp.callTool('get_collection_contents', {
        nodeId,
        contentFilter: 'files',
        maxResults: 4,
        skipCount: skip,
      });
      const rawText = (result.content as any[])
        .filter(c => c.type === 'text').map(c => c.text ?? '').join('\n\n');
      const cards = this.parseWloCards(rawText, 'content');
      const totalMatch = rawText.match(/Gefundene Treffer gesamt: (\d+)/);
      const total = totalMatch ? parseInt(totalMatch[1], 10) : (skip + cards.length);
      const shown = skip + cards.length;
      const summary = cards.length
        ? `**${title}** (${skip + 1}\u2013${shown} von ${total})`
        : `Keine Inhalte in "${title}" gefunden.`;
      this.wf.updateStatus(statusId, `Inhalte von "${title}" geladen`, rawText);
      this.wf.replaceMessage(loadMsg.id, summary, cards.length ? cards : undefined);
      if (shown < total) {
        this.wf.setMessagePagination(loadMsg.id, { nodeId, title, skip: shown, total });
      }
    } catch (e: any) {
      this.wf.updateStatus(statusId, `Fehler: ${e.message}`);
      this.wf.replaceMessage(loadMsg.id, `Fehler beim Laden der Inhalte.`);
    } finally {
      this.wf.isLoading.set(false);
      this.shouldScrollToBottom = true;
    }
  }

  async generateLearningPath(nodeId: string, title: string): Promise<void> {
    const statusId = this.wf.addStatusMessage(`🗺️ Lade Inhalte für Lernpfad „${title}" …`, 'searching');
    this.wf.isLoading.set(true);
    const loadMsg = this.wf.addLoadingMessage();

    try {
      // Fetch up to 16 contents for a representative selection
      const result = await this.mcp.callTool('get_collection_contents', {
        nodeId,
        contentFilter: 'files',
        maxResults: 16,
        skipCount: 0,
      });
      const rawText = (result.content as any[])
        .filter(c => c.type === 'text').map(c => c.text ?? '').join('\n\n');
      const cards = this.parseWloCards(rawText, 'content');

      if (cards.length === 0) {
        this.wf.updateStatus(statusId, `❌ Keine Inhalte in „${title}" gefunden`);
        this.wf.replaceMessage(loadMsg.id, `Leider keine Inhalte in der Sammlung „${title}" gefunden.`);
        return;
      }

      this.wf.updateStatus(statusId, `✅ ${cards.length} Inhalte geladen – KI erstellt Lernpfad …`, rawText);

      const profile = this.wf.profile();
      const persona = this.config.getPersona(profile.persona)!;

      const contentList = cards.map((c, i) => {
        const url = c.url || c.wloUrl;
        const lines = [
          `${i + 1}. ${c.title}`,
          c.learningResourceTypes.length ? `   Typ: ${c.learningResourceTypes.join(', ')}` : '',
          c.educationalContexts.length   ? `   Zielgruppe: ${c.educationalContexts.join(', ')}` : '',
          c.description                  ? `   Beschreibung: ${c.description.slice(0, 150)}` : '',
          url                            ? `   URL: ${url}` : '',
        ].filter(Boolean);
        return lines.join('\n');
      }).join('\n\n');

      const learnerInfo = [
        profile.role             ? `Rolle: ${profile.role}` : '',
        profile.educationLevels.length ? `Bildungsstufe: ${profile.educationLevels.join(', ')}` : '',
        profile.interest         ? `Thema: ${profile.interest}` : '',
      ].filter(Boolean).join(' | ') || 'allgemeine Lernende';

      const prompt: LlmMessage = {
        role: 'user',
        content: `Erstelle einen pädagogisch strukturierten **Lernpfad** zum Thema „${title}" für: ${learnerInfo}.

Verfügbare Inhalte aus der WLO-Sammlung (${cards.length} Elemente):

${contentList}

**Aufgabe:** Wähle die geeignetsten Inhalte aus und ordne sie in einem sinnvollen Lernpfad an. Berücksichtige:
- Inhaltstypen (z.B. Video für Einstieg, Arbeitsblatt für Übung, interaktives Medium für Vertiefung)
- Passende Zielgruppe je Schritt
- Logischer Aufbau: Einstieg → Verstehen → Üben → Vertiefen/Anwenden

**Format (Markdown, auf Deutsch):**

Beginne mit einem **Überblick**-Block:
> **Lernpfad: ${title}**
> Kurze Beschreibung des Lernziels (1–2 Sätze).
> **Schritte auf einen Blick:** Bullet-Liste der 3–5 wichtigsten Stationen

Dann die einzelnen Schritte als nummerierte Abschnitte (### Schritt N: Titel):
- Lernziel des Schritts (1 Satz, kursiv)
- Verlinkter Inhalt: [Titel des Inhalts](URL)
- 1–2 Sätze Begründung, warum dieser Inhalt hier passt

Schließe mit einem kurzen **Tipp für Lehrende** oder **Weiterführende Ideen** ab.

Wichtig: Verlinke **alle verwendeten Inhalte** als [Titel](URL). Nutze ausschließlich Inhalte aus der obigen Liste.`,
      };

      const learningPath = await this.llm.chat([...this.chatHistory, prompt], persona, 0.7);
      this.chatHistory.push(prompt, { role: 'assistant', content: learningPath });
      this.wf.replaceMessage(loadMsg.id, learningPath);

    } catch (e: any) {
      this.wf.updateStatus(statusId, `❌ Fehler: ${e.message}`);
      this.wf.replaceMessage(loadMsg.id, `❌ Fehler beim Erstellen des Lernpfads: ${(e as Error).message}`);
    } finally {
      this.wf.isLoading.set(false);
      this.shouldScrollToBottom = true;
    }
  }

  private async handleChatStep(step: FlowStep): Promise<void> {
    // Activate persona defined in dockedPersona (FlowStudio export)
    if (step.dockedPersona?.mode === 'set' && step.dockedPersona.personaId) {
      this.wf.setPersona(step.dockedPersona.personaId);
    }
    const text = this.config.getMessage(step, this.wf.profile().persona);
    this.wf.addBotMessage(text, undefined, step.id);
    // Jetzt im freien Chat-Modus – weitere Nachrichten gehen durch sendChatMessage()
  }

  // ── Gateway ───────────────────────────────────────────────────────────────────

  private async handleGatewayStep(step: FlowStep): Promise<void> {
    const splitBy = step.splitBy ?? 'condition';

    if (splitBy === 'ai_intent') {
      // If a previous input step already collected the intent text, classify immediately.
      const fieldKey = step.field ?? 'intent_text';
      const existingText = String(this.wf.profile()[fieldKey] ?? '').trim();
      if (existingText) {
        await this.classifyIntentAndRoute(existingText, step);
        return;
      }
      // Otherwise show the prompt and wait for user input (sendMessage handles it).
      const msg = step.message ?? 'Wie kann ich dir weiterhelfen?';
      this.wf.addBotMessage(msg, undefined, step.id);
      return;
    }

    // Immediate routing (no user input needed):
    const nextStepId = this.resolveGatewayBranch(step);
    if (nextStepId) {
      await this.processStep(nextStepId);
    } else {
      console.warn('Gateway: kein passender Zweig und kein Default für', step.id);
    }
  }

  /** Evaluates condition/persona/intent branches and returns the next step id. */
  private resolveGatewayBranch(step: FlowStep): string | null {
    const profile = this.wf.profile();
    const branches = step.branches ?? [];

    for (const branch of branches) {
      if (step.splitBy === 'condition') {
        const fieldVal = (profile as Record<string, unknown>)[branch.field ?? ''];
        const strVal = Array.isArray(fieldVal) ? fieldVal[0] : String(fieldVal ?? '');
        const match = branch.operator === 'not_equals' ? strVal !== branch.value
          : branch.operator === 'contains' ? strVal.includes(branch.value ?? '')
          : strVal === branch.value;
        if (match && branch.next) return branch.next;
      } else if (step.splitBy === 'persona') {
        if (profile.persona === branch.personaId && branch.next) return branch.next;
      } else if (step.splitBy === 'intent') {
        const lastInput = profile.intent_text ?? profile.interest ?? '';
        const re = branch.intentPattern ? new RegExp(branch.intentPattern, 'i') : null;
        if (re?.test(lastInput) && branch.next) return branch.next;
      }
    }
    return step.default ?? null;
  }

  /** Called from sendMessage when current step is gateway+ai_intent.
   *  Sends user text + branch descriptions to LLM, routes to matching branch. */
  private async classifyIntentAndRoute(text: string, step: FlowStep): Promise<void> {
    const branches = step.branches ?? [];
    const loadMsg = this.wf.addLoadingMessage();
    this.wf.isLoading.set(true);

    try {
      const branchList = branches.map((b, i) =>
        `${i}: ${b.label}${b.intentDescription ? ' – ' + b.intentDescription : ''}`
      ).join('\n');

      const classifyPrompt: LlmMessage = {
        role: 'user',
        content: `Klassifiziere die folgende Nutzer-Eingabe in eine der Kategorien.\n\nNutzer-Eingabe: "${text}"\n\nKategorien:\n${branchList}\n\nAntworte NUR mit der Nummer (0, 1, 2, …) der passendsten Kategorie. Falls keine passt, antworte mit "default".`,
      };

      const persona = this.config.getPersona('other')!;
      const answer = (await this.llm.chat([classifyPrompt], persona, 0)).trim();
      const idx = parseInt(answer, 10);
      const matched = !isNaN(idx) && idx >= 0 && idx < branches.length ? branches[idx] : null;
      const nextId = matched?.next ?? step.default ?? null;

      if (matched?.personaId) {
        this.wf.setPersona(matched.personaId);
      }

      this.wf.removeMessage(loadMsg.id);

      if (nextId) {
        await this.processStep(nextId);
      } else {
        this.wf.replaceMessage(loadMsg.id, 'Ich konnte dein Anliegen leider nicht einordnen. Magst du es anders beschreiben?');
      }
    } catch (e: any) {
      this.wf.replaceMessage(loadMsg.id, `❌ Fehler bei der Klassifizierung: ${(e as Error).message}`);
    } finally {
      this.wf.isLoading.set(false);
      this.shouldScrollToBottom = true;
    }
  }

  private async handleHandoffStep(step: FlowStep): Promise<void> {
    const msg = step.handoffMessage ?? step.message ?? 'Du wirst jetzt weitergeleitet …';
    this.wf.addBotMessage(msg, undefined, step.id);
    await this.delay(400);
    if (step.next) await this.processStep(step.next);
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
      // educationLevels muss immer ein Array sein
      const val = step.field === 'educationLevels' ? [option.value] : option.value;
      this.wf.setField(step.field as keyof UserProfile, val);
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
    const nextId = option.next ?? step.next;
    if (nextId) await this.processStep(nextId);
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

    if (currentStep?.type === 'freetext' || currentStep?.type === 'input') {
      this.wf.addUserMessage(text);
      if (currentStep.field) {
        this.wf.setField(currentStep.field as keyof UserProfile, text);
      }
      await this.delay(200);
      if (currentStep.next) await this.processStep(currentStep.next);
    } else if (currentStep?.type === 'gateway' && currentStep.splitBy === 'ai_intent') {
      this.wf.addUserMessage(text);
      if (currentStep.field) {
        this.wf.setField(currentStep.field as keyof UserProfile, text);
      } else {
        this.wf.setField('intent_text', text);
      }
      await this.delay(200);
      await this.classifyIntentAndRoute(text, currentStep);
    } else if (currentStep?.type === 'chat') {
      this.wf.addUserMessage(text);
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

    // Determine allowed tools from dockedTools (undefined/empty = all tools)
    const currentStep = this.config.getStep(this.wf.currentStepId());
    const mcpDocked = currentStep?.dockedTools?.find(t => t.type === 'tool_mcp');
    const allowedTools: string[] | null = mcpDocked?.tools?.length ? mcpDocked.tools : null;

    this.chatHistory.push({ role: 'user', content: text });

    try {
      const allTools: LlmTool[] = [
        {
          type: 'function',
          function: {
            name: 'search_wlo_collections',
            description: 'Sucht Themenseiten/Sammlungen auf WirLernenOnline.de. NUR für Themenrecherche (Sammlungen, Themenseiten, Lernpfade). NICHT für spezifische Inhaltstypen wie Videos oder Arbeitsblätter!',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Suchbegriff, z.B. "Klimawandel" oder "Algebra"' },
                maxResults: { type: 'number', description: 'Max. Ergebnisse (1-5)' },
              },
              required: ['query'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'search_wlo_content',
            description: 'Sucht konkrete Lernmaterialien auf WirLernenOnline.de. Nutze dieses Tool wenn der Nutzer nach spezifischen Inhaltstypen fragt: Videos, Arbeitsblätter, PDFs, interaktive Übungen, Erklärvideos, Aufgaben, Materialien.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Suchbegriff' },
                maxResults: { type: 'number', description: 'Max. Ergebnisse (1-8)' },
              },
              required: ['query'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_collection_contents',
            description: 'Ruft die Inhalte (Lernmaterialien oder Untersammlungen) einer WLO-Sammlung anhand der nodeId ab.',
            parameters: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: 'NodeId der Sammlung' },
                contentFilter: { type: 'string', enum: ['files', 'folders', 'both'], description: '"files" für Materialien, "folders" für Untersammlungen' },
                maxResults: { type: 'number', description: 'Max. Ergebnisse' },
              },
              required: ['nodeId'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_node_details',
            description: 'Ruft Detailmetadaten, optionalen Volltext und Eltern-Sammlungen für eine WLO-NodeId ab.',
            parameters: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: 'NodeId des Inhalts oder der Sammlung' },
                includeTextContent: { type: 'boolean', description: 'Gespeicherten Volltext abrufen' },
                includeParents: { type: 'boolean', description: 'Eltern-Sammlungen abrufen' },
              },
              required: ['nodeId'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_wirlernenonline_info',
            description: 'Infos von WirLernenOnline (WLO) – OER-Portal. Nutze bei: WLO, WirLernenOnline, OER, Fachportale, Qualitätssicherung, Mitmachen, Fachredaktion, Informatik, Deutsch, Medienbildung, Nachhaltigkeit, ComeIn.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Unterseite, z.B. "/fachportale/informatik"' } } },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_edu_sharing_network_info',
            description: 'Infos von edu-sharing-network.org – Community & Vernetzung. Nutze bei: edu-sharing Vernetzung, JOINTLY, ITsJOINTLY, BIRD, Bildungsraum Digital, Hackathon, OER-Sommercamp.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Unterseite' } } },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_edu_sharing_product_info',
            description: 'Infos von edu-sharing.com – Software/Produkt. Nutze bei: edu-sharing Produkt, Repository, Suchmaschine, Moodle Integration, Cloudspeicher, Plugins, Dokumentation, Demo.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Unterseite' } } },
          },
        },
        {
          type: 'function',
          function: {
            name: 'get_metaventis_info',
            description: 'Infos von metaventis.com – Unternehmen hinter edu-sharing. Nutze bei: metaVentis, Schulcloud, IDM, Autoren-Lösung, F&E, Firmenwissen und E-Learning.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Unterseite' } } },
          },
        },
        {
          type: 'function',
          function: {
            name: 'search_wlo_topic_pages',
            description: 'Sucht Themenseiten auf WirLernenOnline. Themenseiten sind kuratierte Seiten mit Swimlanes, zugeschnitten auf Zielgruppen (Lehrkräfte, Lernende, Allgemein). Nutze bei: "Themenseite zu X", "kuratierte Seite", "Themenseiten für Lehrer". Kann nach Thema (query), Zielgruppe (targetGroup) oder Sammlung (collectionId) suchen.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Themensuche, z.B. "Physik" oder "Farben"' },
                targetGroup: { type: 'string', enum: ['teacher', 'learner', 'general'], description: 'Zielgruppe: teacher/learner/general' },
                collectionId: { type: 'string', description: 'NodeId einer Sammlung (optional, für direkten Check)' },
                maxResults: { type: 'number', description: 'Max. Ergebnisse (1-5)' },
              },
            },
          },
        },
      ];
      // Apply tool filter from dockedTools (null = all tools allowed)
      const tools = allowedTools ? allTools.filter(t => allowedTools.includes(t.function.name)) : allTools;

      const toolRoutingRules = `## Tool-Routing-Regeln (strikt einhalten)
- search_wlo_content STATT search_wlo_collections wenn der Nutzer nach konkreten Inhaltstypen fragt (Videos, Arbeitsblätter, PDFs, Übungen, Erklärvideos, Aufgaben, interaktive Materialien).
- search_wlo_topic_pages wenn der Nutzer explizit nach "Themenseiten", "kuratierten Seiten" oder "topic pages" fragt. Auch nach search_wlo_collections nutzbar, um zu prüfen ob eine gefundene Sammlung eine Themenseite hat (collectionId übergeben).
- get_wirlernenonline_info (oder get_edu_sharing_*) STATT search_wlo_collections wenn der Nutzer nach WirLernenOnline, edu-sharing oder metaVentis als Projekt/Plattform/Website fragt (z.B. "Was ist WLO?", "Wie funktioniert edu-sharing?").
- search_wlo_collections nur für inhaltliche Themensuche (z.B. "Klimawandel", "Bruchrechnung").`;

      let choice = await this.llm.chatWithTools(this.chatHistory, persona, tools, 0.7, toolRoutingRules);

      // Tool-Call-Loop
      while (choice.finish_reason === 'tool_calls') {
        const toolCalls = choice.message.tool_calls ?? [];
        this.chatHistory.push({ role: 'assistant', content: choice.message.content ?? '' });

        const toolResults: LlmMessage[] = [];
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.function.arguments || '{}');
          const toolName = tc.function.name;
          const sid = this.wf.addStatusMessage(`🔍 WLO-Tool: ${toolName} …`, 'searching');
          try {
            const mcpResult = await this.mcp.callTool(toolName, args);
            const resultText = mcpResult.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n\n');
            this.wf.updateStatus(sid, `✅ ${toolName}`, this.mcp.lastCallRaw || resultText);
            // Karten extrahieren für alle Tool-Typen die Nodes zurückgeben
            const isCardTool = toolName === 'search_wlo_collections'
              || toolName === 'search_wlo_content'
              || toolName === 'get_collection_contents'
              || toolName === 'search_wlo_topic_pages';
            if (isCardTool && resultText) {
              const toolDefault = toolName === 'search_wlo_content' ? 'content' : 'collection';
              const cards = this.parseWloCards(resultText, toolDefault);
              if (cards.length) this.wf.setMessageCards(loadMsg.id, cards);
            }
            toolResults.push({ role: 'user', content: `[${toolName}-Ergebnis]: ${resultText}` });
          } catch (toolErr: any) {
            this.wf.updateStatus(sid, `❌ ${toolName}: ${toolErr.message}`);
            toolResults.push({ role: 'user', content: `[${toolName}-Fehler]: ${toolErr.message}` });
          }
        }

        this.chatHistory.push(...toolResults);
        choice = await this.llm.chatWithTools(this.chatHistory, persona, tools, 0.7, toolRoutingRules);
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
    return step?.type === 'freetext'
      || step?.type === 'input'
      || step?.type === 'chat'
      || (step?.type === 'gateway' && step.splitBy === 'ai_intent');
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
