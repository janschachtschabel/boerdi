import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; url?: string }>;
  isError?: boolean;
}

/**
 * Browser-kompatibler MCP-Client (Streamable HTTP / JSON-RPC 2.0).
 * Nutzt direkte HTTP-Requests statt des Node.js SDK.
 * MCP-Server-URL ist zur Laufzeit austauschbar (WLO-MCP etc.).
 */
@Injectable({ providedIn: 'root' })
export class McpService {
  private serverUrl = 'https://learn.microsoft.com/api/mcp';
  private tools: McpTool[] = [];
  private initialized = false;
  private requestId = 0;
  private sessionId: string | null = null;
  lastCallRaw = '';            // letzter JSON-RPC-Response als formatierter String

  constructor(private http: HttpClient) {}

  setServerUrl(url: string): void {
    this.serverUrl = url;
    this.initialized = false;
    this.tools = [];
    this.sessionId = null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const initResp = await this.jsonRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'boerdi-chat', version: '1.0.0' },
    });

    if (initResp?.result) {
      this.sessionId = initResp.result?.sessionId ?? null;
      // Send initialized notification
      await this.jsonRpcNotify('notifications/initialized');
    }

    const toolsResp = await this.jsonRpc('tools/list', {});
    this.tools = toolsResp?.result?.tools ?? [];
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.initialize();
    const resp = await this.jsonRpc('tools/call', { name, arguments: args });
    if (resp?.error) {
      return { content: [{ type: 'text', text: `MCP Fehler: ${resp.error.message}` }], isError: true };
    }
    return resp?.result ?? { content: [] };
  }

  async search(query: string, searchTool: string): Promise<string> {
    const result = await this.callTool(searchTool, { query });
    return this.extractText(result);
  }

  async fetchContent(url: string, fetchTool: string): Promise<string> {
    const result = await this.callTool(fetchTool, { url });
    return this.extractText(result);
  }

  private extractText(result: McpToolResult): string {
    return result.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join('\n\n');
  }

  private buildHeaders(): HttpHeaders {
    let headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    });
    if (this.sessionId) {
      headers = headers.set('Mcp-Session-Id', this.sessionId);
    }
    return headers;
  }

  /** Parst SSE-Stream (text/event-stream) und extrahiert den letzten JSON-RPC-Response. */
  private parseSse(text: string): any {
    const lines = text.split('\n');
    let lastJson: any = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data && data !== '[DONE]') {
          try { lastJson = JSON.parse(data); } catch { /* skip */ }
        }
      }
    }
    return lastJson;
  }

  private async jsonRpc(method: string, params: unknown): Promise<any> {
    const body = {
      jsonrpc: '2.0',
      method,
      params,
      id: ++this.requestId,
    };
    try {
      const raw = await firstValueFrom(
        this.http.post(this.serverUrl, body, {
          headers: this.buildHeaders(),
          responseType: 'text',
        })
      );
      const text = raw as string;
      let parsed: any;
      // Versuche zuerst plain JSON, dann SSE
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = this.parseSse(text);
      }
      if (method === 'tools/call') {
        this.lastCallRaw = text; // roher Text für Debug-Panel
      }
      return parsed;
    } catch (e: any) {
      console.error(`MCP ${method} failed:`, e?.message ?? e);
      if (method === 'tools/call') {
        this.lastCallRaw = `Fehler: ${e?.message ?? String(e)}`;
      }
      return null;
    }
  }

  private async jsonRpcNotify(method: string): Promise<void> {
    const body = { jsonrpc: '2.0', method };
    try {
      await firstValueFrom(
        this.http.post(this.serverUrl, body, {
          headers: this.buildHeaders(),
          responseType: 'text',
        })
      );
    } catch {
      // Notifications may return 202 with empty body – ignore errors
    }
  }
}
