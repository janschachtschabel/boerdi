import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoerdiChatComponent } from './boerdi-chat/boerdi-chat.component';
import { ConfigService, FlowDefinition } from './services/config.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, BoerdiChatComponent],
  template: `
    @if (!selectedFlow()) {
      <div class="flow-selector">
        <div class="selector-card">
          <div class="selector-logo">🦉</div>
          <h1>Boerdi</h1>
          <p class="selector-tagline">Dein Assistent für WirLernenOnline.de</p>

          @if (error()) {
            <div class="flow-error">⚠️ {{ error() }}</div>
          }
          @if (loading()) {
            <div class="flow-loading">⏳ Lade Flow …</div>
          } @else if (flows().length > 1) {
            <p class="selector-hint">Wähle einen Flow:</p>
            <div class="flow-list">
              @for (flow of flows(); track flow.id) {
                <button class="flow-item" (click)="selectFlow(flow)" [disabled]="loading()">
                  <div class="flow-name">{{ flow.name }}</div>
                  @if (flow.description) {
                    <div class="flow-desc">{{ flow.description }}</div>
                  }
                </button>
              }
            </div>
          } @else {
            <div class="flow-loading">⏳ Lade …</div>
          }
        </div>
      </div>
    } @else {
      <boerdi-chat></boerdi-chat>
    }
  `,
  styles: [`
    :host { display: block; height: 100vh; }

    .flow-selector {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: linear-gradient(135deg, #f0f4ff 0%, #e8f5e9 100%);
    }

    .selector-card {
      background: white;
      border-radius: 16px;
      padding: 40px 32px;
      max-width: 480px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.12);
      text-align: center;
    }

    .selector-logo { font-size: 3rem; margin-bottom: 8px; }

    h1 {
      font-size: 1.8rem;
      font-weight: 700;
      color: #1a1a2e;
      margin: 0 0 4px;
    }

    .selector-tagline {
      color: #666;
      font-size: 0.95rem;
      margin: 0 0 28px;
    }

    .selector-hint {
      font-size: 0.85rem;
      color: #888;
      margin: 0 0 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .flow-list { display: flex; flex-direction: column; gap: 10px; }

    .flow-item {
      display: block;
      width: 100%;
      text-align: left;
      background: #f8f9ff;
      border: 2px solid #e0e4ff;
      border-radius: 12px;
      padding: 14px 18px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .flow-item:hover {
      border-color: #4f6ef7;
      background: #eef1ff;
      transform: translateY(-1px);
    }

    .flow-name {
      font-weight: 600;
      font-size: 1rem;
      color: #1a1a2e;
    }

    .flow-desc {
      font-size: 0.82rem;
      color: #888;
      margin-top: 3px;
    }

    .flow-loading { color: #aaa; font-size: 0.9rem; }

    .flow-error {
      background: #fff3f3;
      border: 1px solid #ffcdd2;
      border-radius: 8px;
      color: #c62828;
      font-size: 0.85rem;
      padding: 10px 14px;
      margin-bottom: 16px;
      text-align: left;
    }
  `]
})
export class AppComponent implements OnInit {
  private configService = inject(ConfigService);

  flows = signal<FlowDefinition[]>([]);
  selectedFlow = signal<FlowDefinition | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const registry = await this.configService.loadFlowRegistry();
      if (registry.length === 0) {
        await this.selectFlow({ id: 'default', name: 'Boerdi', configFile: 'assets/boerdi-config.yml' });
        return;
      }
      // Auto-start: single flow OR explicit default:true marker skips selection screen
      const defaultFlow = registry.find(f => f.default);
      if (defaultFlow) {
        await this.selectFlow(defaultFlow);
        return;
      }
      if (registry.length === 1) {
        await this.selectFlow(registry[0]);
        return;
      }
      this.flows.set(registry);
      this.loading.set(false);
    } catch (e) {
      this.loading.set(false);
      this.error.set('Konfiguration konnte nicht geladen werden: ' + (e as Error).message);
    }
  }

  async selectFlow(flow: FlowDefinition): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.configService.loadFromFile(flow.configFile);
      this.selectedFlow.set(flow);
    } catch (e) {
      this.error.set(`Flow "${flow.name}" konnte nicht geladen werden: ${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }
}
