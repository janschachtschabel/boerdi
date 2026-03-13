# Boerdi 🦉

**Boerdi** ist ein KI-gestützter Chatbot zur Suche nach freien Bildungsmaterialien (OER) auf [WirLernenOnline.de](https://wirlernenonline.de). Er nutzt einen konfigurierbaren Konversationsfluss, personas-bewusste LLM-Antworten und den [WLO MCP Server](../wlomcp) zur semantischen Suche in WLO-Sammlungen und Inhalten.

---

## Technologie-Stack

| Schicht | Technologie |
|---|---|
| Frontend | Angular 17 (Standalone Components) |
| Styling | SCSS |
| LLM-API | B-API (OpenAI-kompatibel) via `/bapi-proxy` |
| MCP-Suche | [WLO MCP Server](../wlomcp) via `/mcp-proxy` |
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
| `/mcp-proxy` | WLO MCP Server (konfiguriert in `boerdi-config.yml` → `mcpUrl`) |
| `/bapi-proxy` | `https://b-api.staging.openeduhub.net/api/v1/llm/openai` |

Dadurch entstehen keine CORS-Probleme im Browser.

---

## WLO-Kacheln (Cards)

Nach einer Suche zeigt Boerdi die Ergebnisse als interaktive Kacheln an:

- **Typ-Badge:** Jede Kachel zeigt ob es eine `Sammlung` (blau) oder ein `Inhalt` (grün) ist
- **Vorschaubild:** Wird über `previewUrl` geladen; bei Fehler oder fehlendem Bild erscheint ein Icon (📁 / 📄)
- **„Inhalte“-Button:** Auf Sammlungskacheln – lädt die ersten 4 Inhalte der Sammlung als neue Chat-Nachricht
- **Pagination:** Unter den Kacheln erscheint `Weiter (5–8 von N)` wenn mehr Inhalte verfügbar sind
- **Maximal 4 Kacheln** pro Nachricht (2×2 Grid)

## Tool-Routing

Der Chat-LLM verfügt über 9 Tools und folgt diesen Routing-Regeln:

| Frage-Typ | Verwendetes Tool |
|---|---|
| Themensuche ("Klimawandel", "Bruchrechnung") | `search_wlo_collections` |
| Inhaltstypen ("Videos", "Arbeitsblätter", "PDFs") | `search_wlo_content` |
| Inhalte einer Sammlung durchblättern | `get_collection_contents` |
| Details zu einem Inhalt/Node | `get_node_details` |
| Fragen zu WirLernenOnline als Plattform | `get_wirlernenonline_info` |
| Fragen zu edu-sharing Network/Projekten | `get_edu_sharing_network_info` |
| Fragen zu edu-sharing Software/Produkt | `get_edu_sharing_product_info` |
| Fragen zu metaVentis | `get_metaventis_info` |
| Filterwerte für Fach/Stufe nachschlagen | `lookup_wlo_vocabulary` |

---

## Konversationsfluss

Der Fluss ist in `boerdi-config.yml` konfiguriert:

```
welcome → role (Persona-Auswahl) → level (Bildungsstufe) → interest (Thema) → search (MCP) → chat
```

- **`mcp_search`-Schritt:** Ruft automatisch `search_wlo_collections` auf, fasst Ergebnisse zusammen und zeigt Kacheln
- **`chat`-Schritt:** Freies Chat-Interface mit vollem Tool-Zugriff und Tool-Routing-Regeln
- **Personas:** 7 vorkonfigurierte Rollen (Lernende, Lehrende, Beratung, Eltern, Autoren, Manager, Andere) mit individuellen System-Prompts

---

## Projektstruktur (vereinfacht)

```
boerdi/
├── src/
│   ├── app/
│   │   ├── boerdi-chat/          # Haupt-Chat-Komponente (HTML, TS, SCSS)
│   │   └── services/
│   │       ├── config.service.ts   # Lädt boerdi-config.yml + Personas
│   │       ├── workflow.service.ts # Gesprächszustand, Nachrichten, WloCard-Modell
│   │       ├── llm.service.ts      # LLM-Anfragen (B-API, Tool-Calling)
│   │       └── mcp.service.ts      # WLO MCP Tool-Aufrufe
│   ├── assets/
│   │   ├── boerdi-config.yml     # ⚙️ Haupt-Konfiguration (Fluss, Tools, MCP-URL, LLM)
│   │   └── personas/             # 📝 7 Persona-Markdown-Dateien (System-Prompts)
│   └── environments/             # 🔒 Gitignored — wird zur Build-Zeit generiert
├── generate-env.mjs              # Build-Zeit Key-Injektion aus Umgebungsvariablen
├── vercel.json                   # Vercel Build + Proxy-Rewrites (bapi, mcp)
├── proxy.conf.json               # Lokaler Dev-Proxy für ng serve
└── angular.json
```

---

## Skripte

| Befehl | Beschreibung |
|---|---|
| `npm start` | Dev-Server starten (inkl. Key-Generierung) |
| `npm run build` | Production-Build (inkl. Key-Generierung) |
| `node generate-env.mjs` | Nur environment-Dateien neu generieren |
