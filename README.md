# Lumen - OCA Creative Arts Companion

Lumen is a specialized creative companion and multimodal chatbot developed for the **Open College of the Arts (OCA)**. Engineered to assist students in creative higher education, Lumen leverages artificial intelligence to provide tailored guidance on course material, aid in project structuring, facilitate study planning, and offer design feedback.

Lumen is built to operate both as a standalone portal and as an embedded tool integrated into learning environments (such as Canvas or Moodle) via the LTI (Learning Tools Interoperability) 1.3 standard.

---

## 🚀 Key Capabilities

- **Interactive Core Chat**: Student-centric conversations guided by tailored education personas and specialized knowledge.
- **Multimodal Feedback Theme Engine**: Supports rich image inputs (using browser cameras or drag-and-drop file uploads) to analyze student artwork, draft portfolios, or visual references.
- **Vector Search & Document Retrieval**: Seamlessly queries reference files and directories indexed from a Google Drive knowledge base.
- **OCR-based Study Planner**: Automatically generates custom, downloadable PDF study trackers and milestones based on syllabus requirements or projects.
- **LTI 1.3 Integration**: Supports LTI-standard deep launching, allowing universities to embed interactive activity sessions directly into courses.
- **Seamless History Sync**: Automatically synchronizes and records all embedded student chats with the central user history, enabling easy reference and backup downloading.

---

## 🛠️ The Tech Stack

Lumen utilizes a robust, modern full-stack architecture to ensure low-latency completions, data security, and solid session persistence.

### Frontend
- **React 18+ (TypeScript)**: Standard modular single-page architecture built using functional components and hooks.
- **Vite**: Rapid, lightweight bundler and development build loop.
- **Tailwind CSS (v4)**: Modern, class-driven styling with responsive modifiers and custom palette configurations.
- **Framer Motion**: Smooth, declarative interface transitions, accordion collapses, and entrance states.
- **Lucide Icons**: Consistent, vector-based iconography used throughout the interface.

### Backend Routing & Proxy
- **Express Server (`server.ts`)**: Built with custom Node.js middleware.
- **TypeScript native compilation**: Compiled at build time using `esbuild` to a singular CommonJS bundle in `dist/server.cjs` for streamlined container deployment.
- **Secure Server-side API Proxying**:
  - Handles **Gemini 2.5 Flash / Pro** interactions without exposing the server-level `GEMINI_API_KEY` to public client-side scopes.
  - Proxies sensitive **Google Cloud & Firebase Firestore** queries. This ensures third-party LTI launches of embedded activity widgets remain functional even on networks/browsers with restricted client-side Firebase connections or missing client-side credentials.

### Storage & Database
- **Firebase Firestore**: Secure, server-orchestrated, document-based NoSQL persistence.
  - `chat_history`: Stores message objects and lists (`userId`, `sessionId`, `role`, `parts`, `createdAt`).
  - `study_schedules`: Saves student timeline planning information.
  - `activities`: Organizes the active embedded curricula created by lecturers.
  - `moodleUnits`: Stores academic structures referencing courses.
  - `folders` & `chunks`: Organizes vector indexing references from academic knowledge bases.
- **Firebase Authentication**: Secures student session logs using standard web flow standards.

---

## 📂 Project Directory Structure

```bash
├── server.ts                       # Full-stack Node.js server entry point (Express, Vite Middleware, API proxy)
├── firestore.rules                 # Security rules configuration for Firestore databases
├── firebase-blueprint.json         # Seed structure blueprint for collections
├── src/
│   ├── main.tsx                    # React client-side entry point
│   ├── App.tsx                     # Primary router and application layout
│   ├── index.css                   # Global styles importing modern Tailwind CSS v4 variables
│   ├── components/
│   │   ├── BrandAssets.tsx         # OCA-branded visual constants, Logos, SVGs, and brand icons
│   │   ├── ChatWidget.tsx          # Real-time intelligent conversation panel and session controller
│   │   ├── StudyPlanner.tsx        # OCR scheduler and milestone sheet generator
│   │   ├── ActivityView.tsx        # Responsive embedded view for course LTI-activities
│   │   ├── AdminPanel.tsx          # Configuration, persona writer, folder indexer, and LTI selector
│   │   └── HistoryView.tsx         # Student log visualizer with PDF download export utilities
│   └── lib/
│       └── vector.ts               # Core utility handles embedding math matching and query chunks
```

---

## 📖 Related Documents

To preserve a consistent user experience and design excellence across all Open College of the Arts digital workspaces, see our comprehensive:

- 👉 **[DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)**: The developer-ready design package detailing our signature Neobrutalist design system, colour variables, layout templates, typography, and interactive components.
