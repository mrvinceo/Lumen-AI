import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleGenAI } from "@google/genai";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import path from "path";
import fs from "fs";

export interface ParsedChunk {
  text: string;
  heading?: string;
  pageSpan?: { start?: number; end?: number };
}

export interface DocumentParseResult {
  success: boolean;
  parserUsed: "document_ai_layout_parser" | "gemini_layout_parser" | "fallback_plain_text";
  processorId?: string;
  location?: string;
  projectId?: string;
  chunks: ParsedChunk[];
  fullText: string;
  pagesCount?: number;
  tablesDetected?: number;
  error?: string;
}

export interface DocumentAiConfig {
  processorId?: string;
  location?: string;
  projectId?: string;
  enableDocumentAi?: boolean;
}

// Load firebase-applet-config.json
let firebaseConfig: any = {};
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
} catch (err) {
  console.warn("[DocumentAI] Could not load firebase-applet-config.json:", err);
}

// Helper to get initialized Firestore instance for the configured named database
export function getAdminFirestore() {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      projectId: firebaseConfig?.projectId || "gen-lang-client-0701859835"
    });
  }
  const dbId = firebaseConfig?.firestoreDatabaseId;
  return dbId ? getFirestore(dbId) : getFirestore();
}

// Local in-memory / file cache for config
let cachedConfig: DocumentAiConfig | null = null;
const LOCAL_CONFIG_PATH = path.join(process.cwd(), "document_ai_saved_config.json");

// Cache Document AI client per location
const clientCache = new Map<string, DocumentProcessorServiceClient>();

function getDocumentAiClient(location: string = "us"): DocumentProcessorServiceClient {
  const loc = location.toLowerCase().trim() || "us";
  if (clientCache.has(loc)) {
    return clientCache.get(loc)!;
  }

  const endpoint = loc === "us" ? "us-documentai.googleapis.com" : `${loc}-documentai.googleapis.com`;
  const client = new DocumentProcessorServiceClient({
    apiEndpoint: endpoint,
  });

  clientCache.set(loc, client);
  return client;
}

/**
 * Retrieve configuration from Firestore system settings, local cache, or environment
 */
export async function getDocumentAiConfig(): Promise<DocumentAiConfig> {
  let projectId = process.env.DOCUMENT_AI_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || firebaseConfig?.projectId || "gen-lang-client-0701859835";
  let location = process.env.DOCUMENT_AI_LOCATION || "us";
  let processorId = process.env.DOCUMENT_AI_PROCESSOR_ID || "";
  let enableDocumentAi = true;

  // 1. Try reading from Firestore settings/document_ai
  try {
    const db = getAdminFirestore();
    const docSnap = await db.collection("settings").doc("document_ai").get();
    if (docSnap.exists) {
      const data = docSnap.data();
      if (data?.processorId !== undefined) processorId = data.processorId;
      if (data?.location) location = data.location;
      if (data?.projectId) projectId = data.projectId;
      if (data?.enableDocumentAi !== undefined) enableDocumentAi = data.enableDocumentAi;

      cachedConfig = { processorId, location, projectId, enableDocumentAi };
      return cachedConfig;
    }
  } catch (err: any) {
    console.warn("[DocumentAI] Could not fetch settings from Firestore:", err.message);
  }

  // 2. Try reading from local file backup
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, "utf8"));
      if (fileData.processorId !== undefined) processorId = fileData.processorId;
      if (fileData.location) location = fileData.location;
      if (fileData.projectId) projectId = fileData.projectId;
      if (fileData.enableDocumentAi !== undefined) enableDocumentAi = fileData.enableDocumentAi;
    } catch {
      // ignore
    }
  }

  cachedConfig = {
    projectId,
    location,
    processorId,
    enableDocumentAi,
  };

  return cachedConfig;
}

/**
 * Save configuration to both Firestore and local file
 */
export async function saveDocumentAiConfig(config: Partial<DocumentAiConfig>): Promise<DocumentAiConfig> {
  const current = await getDocumentAiConfig();
  const updated: DocumentAiConfig = {
    projectId: config.projectId !== undefined ? config.projectId.trim() : current.projectId,
    location: config.location !== undefined ? config.location.trim() : current.location,
    processorId: config.processorId !== undefined ? config.processorId.trim() : current.processorId,
    enableDocumentAi: config.enableDocumentAi !== undefined ? Boolean(config.enableDocumentAi) : current.enableDocumentAi,
  };

  // 1. Save to Firestore
  try {
    const db = getAdminFirestore();
    await db.collection("settings").doc("document_ai").set({
      ...updated,
      updatedAt: new Date(),
    }, { merge: true });
  } catch (err: any) {
    console.warn("[DocumentAI] Firestore save error:", err.message);
  }

  // 2. Save to local disk backup
  try {
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf8");
  } catch (err: any) {
    console.warn("[DocumentAI] Local disk save error:", err.message);
  }

  cachedConfig = updated;
  return updated;
}

/**
 * Parse a PDF buffer using Google Cloud Document AI's Layout Parser
 */
export async function parseWithDocumentAi(
  pdfBuffer: Buffer,
  config: DocumentAiConfig
): Promise<DocumentParseResult> {
  const { projectId = "gen-lang-client-0701859835", location = "us", processorId } = config;

  if (!processorId || !processorId.trim()) {
    throw new Error("DOCUMENT_AI_PROCESSOR_ID is not configured.");
  }

  // Clean processor path format: "projects/{project}/locations/{location}/processors/{processor}"
  let processorName = processorId.trim();
  if (!processorName.startsWith("projects/")) {
    processorName = `projects/${projectId}/locations/${location}/processors/${processorId.trim()}`;
  }

  console.log(`[DocumentAI] Calling Google Cloud Layout Parser at ${processorName} (buffer size: ${pdfBuffer.length} bytes)`);

  const client = getDocumentAiClient(location);

  const request: any = {
    name: processorName,
    rawDocument: {
      content: pdfBuffer.toString("base64"),
      mimeType: "application/pdf",
    },
    processOptions: {
      layoutConfig: {
        chunkingConfig: {
          chunkSize: 1000,
          includeAncestorHeadings: true,
        },
      },
    },
  };

  const [result] = await client.processDocument(request);
  const document = result.document;

  if (!document) {
    throw new Error("Document AI returned an empty document response.");
  }

  const chunks: ParsedChunk[] = [];
  let tablesDetected = 0;
  const pagesCount = document.pages?.length || 0;

  // 1. Check if chunkedDocument chunks are directly available
  const chunkedDoc = (document as any).chunkedDocument;
  if (chunkedDoc && Array.isArray(chunkedDoc.chunks) && chunkedDoc.chunks.length > 0) {
    console.log(`[DocumentAI] Received ${chunkedDoc.chunks.length} structured chunks directly from Layout Parser`);
    for (const c of chunkedDoc.chunks) {
      const text = c.content || c.text || "";
      if (text.trim().length > 0) {
        chunks.push({
          text: text.trim(),
          heading: c.heading || undefined,
          pageSpan: c.pageSpan
            ? {
                start: c.pageSpan.pageStartNumber || c.pageSpan.startPage,
                end: c.pageSpan.pageEndNumber || c.pageSpan.endPage,
              }
            : undefined,
        });
      }
    }
  }

  // 2. Count tables from layout if available
  if (document.pages) {
    for (const page of document.pages) {
      if (page.tables && page.tables.length > 0) {
        tablesDetected += page.tables.length;
      }
    }
  }

  const fullText = document.text || "";

  // 3. If no pre-chunked items but text exists, perform contextual markdown / heading chunking
  if (chunks.length === 0 && fullText.trim().length > 0) {
    console.log(`[DocumentAI] ChunkedDocument was empty; generating contextual chunks from document layout text.`);
    const fallbackChunks = createSemanticChunks(fullText, 1200);
    chunks.push(...fallbackChunks);
  }

  return {
    success: true,
    parserUsed: "document_ai_layout_parser",
    processorId,
    location,
    projectId,
    chunks,
    fullText,
    pagesCount,
    tablesDetected,
  };
}

/**
 * Fallback parser using Gemini Flash for Multimodal Layout Understanding
 */
export async function parseWithGeminiLayout(
  pdfBuffer: Buffer,
  apiKey: string
): Promise<DocumentParseResult> {
  console.log(`[DocumentAI Fallback] Processing PDF with Gemini Layout Understanding (${pdfBuffer.length} bytes)...`);

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `You are a high-precision document layout and OCR parser for academic course materials.
Parse this document with complete structural awareness:
1. Preserve all document tables as clean, formatted Markdown tables.
2. Structure sections using hierarchical Markdown headings (# for Title, ## for Main Sections, ### for Subsections).
3. Preserve numbered lists, bullet points, callouts, and captions in natural reading order.
4. Output ONLY the parsed, structured Markdown content. Do NOT include conversational commentary or summaries.`;

  const geminiResponse = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        inlineData: {
          data: pdfBuffer.toString("base64"),
          mimeType: "application/pdf",
        },
      },
      prompt,
    ],
  });

  const markdownText = geminiResponse.text || "";
  if (!markdownText.trim()) {
    throw new Error("Gemini returned empty text during document layout extraction");
  }

  // Split into contextual semantic chunks
  const chunks = createSemanticChunks(markdownText, 1200);

  return {
    success: true,
    parserUsed: "gemini_layout_parser",
    chunks,
    fullText: markdownText,
    stats: {
      chunksCount: chunks.length,
      length: markdownText.length,
    },
  } as any;
}

/**
 * Main unified document parser function
 * Tries Document AI Layout Parser first, then falls back smoothly to Gemini Layout Parser
 */
export async function parseDocumentBuffer(
  pdfBuffer: Buffer,
  apiKey?: string
): Promise<DocumentParseResult> {
  const config = await getDocumentAiConfig();

  // If Document AI is configured with a processor ID, attempt Document AI first
  if (config.enableDocumentAi && config.processorId && config.processorId.trim().length > 0) {
    try {
      const docAiResult = await parseWithDocumentAi(pdfBuffer, config);
      if (docAiResult.chunks.length > 0) {
        return docAiResult;
      }
    } catch (docAiError: any) {
      console.warn(`[DocumentAI] Primary Document AI execution failed, falling back to Gemini Layout Parser:`, docAiError.message || docAiError);
    }
  } else {
    console.log(`[DocumentAI] Processor ID not set or Document AI disabled; using Gemini Layout Parser.`);
  }

  // Fallback to Gemini Layout Parser
  const keyToUse = apiKey || process.env.GEMINI_API_KEY;
  if (!keyToUse) {
    throw new Error("Cannot parse document: Neither Document AI processor nor Gemini API Key is configured.");
  }

  return await parseWithGeminiLayout(pdfBuffer, keyToUse);
}

/**
 * Smart Semantic & Boundary-Aware Chunking Helper
 * Respects paragraph boundaries, sentences, and document headings.
 * NEVER splits mid-word or mid-sentence.
 */
export function createSemanticChunks(text: string, maxChunkSize = 1200): ParsedChunk[] {
  if (!text || !text.trim()) return [];

  // Normalize newlines
  const normalized = text.replace(/\r\n/g, "\n").trim();
  
  // Break into paragraphs / blocks
  const rawParagraphs = normalized.split(/\n{2,}/);
  const chunks: ParsedChunk[] = [];

  let currentHeading = "General Overview";
  let currentChunkBuffer: string[] = [];
  let currentBufferLength = 0;

  const flushBuffer = () => {
    if (currentChunkBuffer.length === 0) return;
    const combined = currentChunkBuffer.join("\n\n").trim();
    if (combined.length > 0) {
      const hasHeadingAlready = combined.startsWith("#") || combined.startsWith("[Context:");
      const formatted = hasHeadingAlready ? combined : `[Context: ${currentHeading}]\n\n${combined}`;
      chunks.push({
        text: formatted,
        heading: currentHeading,
      });
    }
    currentChunkBuffer = [];
    currentBufferLength = 0;
  };

  for (const para of rawParagraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    // Check if this paragraph starts with a heading pattern
    const mdHeadingMatch = trimmedPara.match(/^(#{1,4})\s+(.+)$/m);
    const numberedHeadingMatch = trimmedPara.match(/^(\d+[\.\)]\s+[A-Z][^\n]+)/);

    if (mdHeadingMatch) {
      // If we already have content buffered, flush it
      if (currentBufferLength > 300) {
        flushBuffer();
      }
      currentHeading = mdHeadingMatch[2].trim();
    } else if (numberedHeadingMatch && trimmedPara.length < 150) {
      if (currentBufferLength > 300) {
        flushBuffer();
      }
      currentHeading = numberedHeadingMatch[1].trim();
    }

    // If paragraph itself exceeds maxChunkSize, split it cleanly by sentences
    if (trimmedPara.length > maxChunkSize) {
      // Flush previous buffer first
      flushBuffer();

      // Split paragraph into sentences
      const sentences = trimmedPara.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [trimmedPara];
      let sentenceBuffer: string[] = [];
      let sentenceLen = 0;

      for (const sent of sentences) {
        const trimmedSent = sent.trim();
        if (!trimmedSent) continue;

        if (sentenceLen + trimmedSent.length + 1 > maxChunkSize && sentenceBuffer.length > 0) {
          const sentText = sentenceBuffer.join(" ").trim();
          const hasHeading = sentText.startsWith("#") || sentText.startsWith("[Context:");
          chunks.push({
            text: hasHeading ? sentText : `[Context: ${currentHeading}]\n\n${sentText}`,
            heading: currentHeading,
          });
          sentenceBuffer = [];
          sentenceLen = 0;
        }

        sentenceBuffer.push(trimmedSent);
        sentenceLen += trimmedSent.length + 1;
      }

      if (sentenceBuffer.length > 0) {
        const sentText = sentenceBuffer.join(" ").trim();
        const hasHeading = sentText.startsWith("#") || sentText.startsWith("[Context:");
        chunks.push({
          text: hasHeading ? sentText : `[Context: ${currentHeading}]\n\n${sentText}`,
          heading: currentHeading,
        });
      }
    } else {
      // Will adding this paragraph exceed max size?
      if (currentBufferLength + trimmedPara.length + 2 > maxChunkSize && currentChunkBuffer.length > 0) {
        flushBuffer();
      }

      currentChunkBuffer.push(trimmedPara);
      currentBufferLength += trimmedPara.length + 2;
    }
  }

  // Flush any remaining content
  flushBuffer();

  return chunks;
}

