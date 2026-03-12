# Boerdi 🦉

**Boerdi** ist ein KI-gestützter Chatbot zur Suche nach freien Bildungsmaterialien (OER) auf [WirLernenOnline.de](https://wirlernenonline.de). Er nutzt einen konfigurierbaren Konversationsfluss, personas-bewusste LLM-Antworten und den Microsoft Learn MCP-Server zur semantischen Ressourcensuche.

---

## Technologie-Stack

| Schicht | Technologie |
|---|---|
| Frontend | Angular 17 (Standalone Components) |
| Styling | SCSS |
| LLM-API | B-API (OpenAI-kompatibel) via `/bapi-proxy` |
| Suche | Microsoft Learn MCP via `/mcp-proxy` |
| Konfiguration | YAML (`src/assets/boerdi-config.yml`) |
| Personas | Markdown-Dateien (`src/assets/personas/`) |
| Deployment | Vercel (statisch + Edge-Rewrites als Proxy) |

---

## 🔑 API-Key — Sicherheitshinweis

Der API-Key wird **niemals** im Quellcode gespeichert.

- Die Dateien `src/environments/environment.ts` und `src/environments/environment.development.ts` werden **zur Build-Zeit automatisch generiert** und sind in `.gitignore` eingetragen.
- Der Key kommt ausschließlich aus der Umgebungsvariable `B_API_KEY` des jeweiligen Systems (lokal: OS, Deployment: Vercel).

**Nie einchecken:**
```
src/environments/environment.ts          ← gitignored ✅
src/environments/environment.development.ts  ← gitignored ✅
```

---

## Lokale Entwicklung

### Voraussetzungen

- Node.js ≥ 18
- npm ≥ 9

### Installation

```bash
npm install
```

### Umgebungsvariable setzen (Windows PowerShell)

```powershell
$env:B_API_KEY = "dein-api-key-hier"
```

### Umgebungsvariable setzen (macOS / Linux)

```bash
export B_API_KEY="dein-api-key-hier"
```

### Starten

```bash
npm start
```

`npm start` führt automatisch `node generate-env.mjs` aus, das `environment.ts` mit dem Key befüllt, bevor `ng serve` startet. Die App ist dann unter [http://localhost:4200](http://localhost:4200) erreichbar.

> **Hinweis:** Ohne gesetzten `B_API_KEY` startet die App zwar, aber LLM-Anfragen schlagen fehl.

---

## Konfiguration

Die gesamte Bot-Konfiguration liegt in einer einzigen editierbaren YAML-Datei:

```
src/assets/boerdi-config.yml
```

Dort können ohne Coding geändert werden:
- Bot-Name, Avatar, Tagline
- LLM-Modell und API-URL
- MCP-Server-URL und Such-Tool
- Konversationsfluss (Schritte, Fragen, Optionen mit OEH-URIs)
- Personas (Referenz auf Markdown-Dateien)
- Vorschläge (Suggestion-Chips) pro Schritt

Persona-Verhalten wird als Markdown editiert:

```
src/assets/personas/learner.md
src/assets/personas/teacher.md
src/assets/personas/counsellor.md
src/assets/personas/parent.md
src/assets/personas/author.md
src/assets/personas/manager.md
src/assets/personas/other.md
```

---

## Deployment auf Vercel

### 1. Repository pushen

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/DEIN-USER/boerdi.git
git push -u origin main
```

### 2. Projekt auf Vercel importieren

1. Gehe zu [vercel.com](https://vercel.com) → **Add New Project**
2. Wähle dein Repository aus
3. **Framework Preset** → `Other` (Vercel erkennt `vercel.json` automatisch)
4. Klicke auf **Deploy** — noch nicht abschicken, erst Schritt 3!

### 3. Umgebungsvariable `B_API_KEY` setzen

**Während des ersten Deploys:**

Im Vercel-Dialog „Configure Project" → Abschnitt **Environment Variables**:

| Name | Value | Environments |
|---|---|---|
| `B_API_KEY` | `dein-api-key` | Production, Preview, Development |

**Oder nachträglich** über das Vercel-Dashboard:

1. Projekt öffnen → **Settings** → **Environment Variables**
2. **Add New** → Name: `B_API_KEY`, Value: `dein-api-key`
3. Haken bei **Production** (und optional Preview/Development)
4. **Save** → anschließend **Redeploy** auslösen (Deployments → ⋯ → Redeploy)

### 4. Wie der Build auf Vercel abläuft

```
Vercel klont Repo
  └── npm run build
        ├── prebuild: node generate-env.mjs
        │     └── liest B_API_KEY aus Vercel-Umgebungsvariable
        │     └── schreibt src/environments/environment.ts  ← Key eingebettet
        └── ng build
              └── kompiliert → dist/boerdi/browser/
```

Der fertige Build enthält den Key **nur im kompilierten JS-Bundle** (nicht im Repo).

### 5. Proxy-Rewrites (automatisch via `vercel.json`)

Die `vercel.json` konfiguriert Vercel als transparenten Proxy für:

| Lokaler Pfad | Ziel |
|---|---|
| `/mcp-proxy` | `https://learn.microsoft.com/api/mcp` |
| `/bapi-proxy` | `https://b-api.staging.openeduhub.net/api/v1/llm/openai` |

Dadurch entstehen keine CORS-Probleme im Browser.

---

## Projektstruktur (vereinfacht)

```
boerdi/
├── src/
│   ├── app/
│   │   ├── boerdi-chat/          # Haupt-Chat-Komponente (HTML, TS, SCSS)
│   │   └── services/
│   │       ├── config.service.ts # Lädt boerdi-config.yml
│   │       ├── workflow.service.ts # Gesprächszustand + Nachrichten
│   │       ├── llm.service.ts    # LLM-Anfragen (B-API)
│   │       └── mcp.service.ts    # MCP-Suche
│   ├── assets/
│   │   ├── boerdi-config.yml     # ⚙️ Haupt-Konfiguration
│   │   └── personas/             # 📝 Persona-Markdown-Dateien
│   └── environments/             # 🔒 Gitignored — wird generiert
├── generate-env.mjs              # Build-Zeit Key-Injektion
├── vercel.json                   # Vercel Build + Proxy-Config
├── proxy.conf.json               # Lokaler Dev-Proxy (ng serve)
└── angular.json
```

---

## Skripte

| Befehl | Beschreibung |
|---|---|
| `npm start` | Dev-Server starten (inkl. Key-Generierung) |
| `npm run build` | Production-Build (inkl. Key-Generierung) |
| `node generate-env.mjs` | Nur environment-Dateien neu generieren |
