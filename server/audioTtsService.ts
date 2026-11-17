import fs from "fs";
import path from "path";
import crypto from "crypto";
import { GoogleAuth } from "google-auth-library";
import mammoth from "mammoth";
import { createRequire } from "module";
import { getAdminFirestore } from "./documentAiService";

import { GoogleGenAI } from "@google/genai";

const require = createRequire(import.meta.url);
let pdfParsePkg: any = null;
try {
  pdfParsePkg = require("pdf-parse");
} catch (e) {
  console.warn("[AudioTTS] pdf-parse require error:", e);
}

/**
 * Safely extract text from PDF buffer supporting both pdf-parse v2 (PDFParse class) and v1 (function)
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  if (!pdfParsePkg) {
    try {
      pdfParsePkg = require("pdf-parse");
    } catch (e: any) {
      throw new Error(`PDF parser package unavailable: ${e.message}`);
    }
  }

  // pdf-parse v2.x exports { PDFParse: class ... }
  if (pdfParsePkg?.PDFParse) {
    const parser = new pdfParsePkg.PDFParse({ data: buffer });
    try {
      const res = await parser.getText();
      return (res && typeof res.text === "string") ? res.text : "";
    } finally {
      if (typeof parser.destroy === "function") {
        await parser.destroy().catch(() => {});
      }
    }
  }

  // Legacy pdf-parse v1.x exports default function: pdf(buffer)
  if (typeof pdfParsePkg === "function") {
    const data = await pdfParsePkg(buffer);
    return data?.text || "";
  }

  if (typeof pdfParsePkg?.default === "function") {
    const data = await pdfParsePkg.default(buffer);
    return data?.text || "";
  }

  throw new Error("Unable to parse PDF: no compatible PDFParse method found in pdf-parse package.");
}

// Mapping from UK Voice IDs to Gemini prebuilt voices for seamless fallback
export const GEMINI_VOICE_MAP: Record<string, string> = {
  "en-GB-Neural2-B": "Puck",     // Oliver (UK Male · Clear, balanced)
  "en-GB-Neural2-A": "Aoede",    // Charlotte (UK Female · Articulate, engaging)
  "en-GB-Journey-D": "Fenrir",   // George (UK Male · Warm, conversational)
  "en-GB-Journey-F": "Kore",     // Eleanor (UK Female · Warm, expressive)
  "en-GB-Neural2-D": "Charon"    // Arthur (UK Male · Deep tone)
};

// Flag to track whether Cloud TTS API is disabled on project, avoiding repeated 403 delays
let cloudTtsServiceDisabled = false;

export interface VoiceOption {
  id: string;
  name: string;
  displayName: string;
  gender: "MALE" | "FEMALE";
  style: "Neural2" | "Journey";
  accent: string;
  tone: string;
  sampleText: string;
}

export const UK_VOICES: VoiceOption[] = [
  {
    id: "en-GB-Neural2-B",
    name: "Oliver",
    displayName: "Oliver (UK Male · Neural2)",
    gender: "MALE",
    style: "Neural2",
    accent: "British (UK)",
    tone: "Clear, academic, and well-paced",
    sampleText: "Hello! I am Oliver, one of the UK voices available for converting your course documents into speech."
  },
  {
    id: "en-GB-Neural2-A",
    name: "Charlotte",
    displayName: "Charlotte (UK Female · Neural2)",
    gender: "FEMALE",
    style: "Neural2",
    accent: "British (UK)",
    tone: "Articulate, natural, and engaging RP",
    sampleText: "Welcome. I am Charlotte. I can read your study materials, lecture summaries, and essays clearly."
  },
  {
    id: "en-GB-Journey-D",
    name: "George",
    displayName: "George (UK Male · Journey)",
    gender: "MALE",
    style: "Journey",
    accent: "British (UK)",
    tone: "Warm, conversational, and natural pacing",
    sampleText: "Hi there, I am George. My voice is designed to sound natural and conversational for long listening sessions."
  },
  {
    id: "en-GB-Journey-F",
    name: "Eleanor",
    displayName: "Eleanor (UK Female · Journey)",
    gender: "FEMALE",
    style: "Journey",
    accent: "British (UK)",
    tone: "Warm, empathetic, and expressive",
    sampleText: "Good day. I am Eleanor. I bring an expressive, warm tone to readings, articles, and research papers."
  },
  {
    id: "en-GB-Neural2-D",
    name: "Arthur",
    displayName: "Arthur (UK Male · Deep Tone)",
    gender: "MALE",
    style: "Neural2",
    accent: "British (UK)",
    tone: "Deep, resonant, and authoritative",
    sampleText: "Greetings. I am Arthur. I provide a calm, deep, and measured reading of formal texts and policies."
  }
];

export interface AudioQuotaStatus {
  allowed: boolean;
  isStaff: boolean;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  todayKey: string;
  monthKey: string;
  reason?: string;
}

export interface AudioDocumentRecord {
  id: string;
  userId: string;
  userEmail: string;
  fileName: string;
  fileType: string;
  wordCount: number;
  voiceId: string;
  voiceName: string;
  audioUrl: string;
  durationSeconds: number;
  status: "completed" | "processing" | "failed";
  createdAt: string;
}

// Ensure audio directory exists
const AUDIO_STORAGE_DIR = path.join(process.cwd(), "public", "generated_audio");
if (!fs.existsSync(AUDIO_STORAGE_DIR)) {
  fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });
}

// Google Auth helper
let googleAuthClient: GoogleAuth | null = null;
async function getGoogleAccessToken(apiKeyFallback?: string): Promise<string | null> {
  try {
    if (!googleAuthClient) {
      googleAuthClient = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"]
      });
    }
    const client = await googleAuthClient.getClient();
    const tokenResponse = await client.getAccessToken();
    if (tokenResponse && tokenResponse.token) {
      return tokenResponse.token;
    }
  } catch (err: any) {
    // Expected in environments without service account credentials; will fallback to API key
    console.log("[AudioTTS] Cloud ADC token lookup skipped, using API key auth.");
  }
  return null;
}

/**
 * Concatenate multiple PCM WAV audio buffers into a single playable WAV buffer
 */
export function concatWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  const first = buffers[0];
  const firstDataOffset = first.indexOf("data");
  if (firstDataOffset === -1) {
    return Buffer.concat(buffers);
  }

  const pcmList: Buffer[] = [];
  for (const b of buffers) {
    const dataOffset = b.indexOf("data");
    if (dataOffset !== -1) {
      pcmList.push(b.subarray(dataOffset + 8));
    } else {
      pcmList.push(b.subarray(44));
    }
  }

  const totalPcm = Buffer.concat(pcmList);
  const header = Buffer.from(first.subarray(0, firstDataOffset + 8));
  header.writeUInt32LE(totalPcm.length + 36, 4); // RIFF chunk size
  header.writeUInt32LE(totalPcm.length, firstDataOffset + 4); // data chunk size

  return Buffer.concat([header, totalPcm]);
}

/**
 * Synthesize speech using Google Gemini's Text-to-Speech (gemini-3.8-flash-lite-tts)
 */
export async function synthesizeWithGeminiTts(
  text: string,
  voiceId: string,
  apiKey: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const ai = new GoogleGenAI({ apiKey });
  const mappedVoice = GEMINI_VOICE_MAP[voiceId] || "Puck";

  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("Text chunk is empty");
  }

  const res = await ai.models.generateContent({
    model: "gemini-3.8-flash-lite-tts",
    contents: cleanText,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: mappedVoice
          }
        }
      }
    }
  });

  let base64Data: string | undefined;
  let mimeType = "audio/wav";

  for (const cand of res.candidates || []) {
    for (const part of cand.content?.parts || []) {
      if (part.inlineData?.data) {
        base64Data = part.inlineData.data;
        if (part.inlineData.mimeType) {
          mimeType = part.inlineData.mimeType;
        }
        break;
      }
    }
    if (base64Data) break;
  }

  if (!base64Data) {
    const finishReason = res.candidates?.[0]?.finishReason;
    console.warn("[AudioTTS] No inline audio data in candidate. Finish reason:", finishReason);
    throw new Error(`Gemini TTS returned empty audio data (finishReason: ${finishReason || "unknown"})`);
  }

  return {
    buffer: Buffer.from(base64Data, "base64"),
    mimeType
  };
}

/**
 * Synthesize a single chunk of text with Google Gemini TTS (gemini-3.8-flash-lite-tts)
 * or Google Cloud Text-to-Speech API. Google Gemini TTS is primary because it runs directly
 * on the app's Gemini API key with zero GCP service-enablement hurdles.
 */
export async function synthesizeTtsChunk(
  text: string,
  voiceId: string,
  apiKey: string,
  speakingRate = 1.0
): Promise<{ buffer: Buffer; mimeType: string; isWav: boolean }> {
  // Always use Gemini TTS as primary high-performance engine
  try {
    const geminiRes = await synthesizeWithGeminiTts(text, voiceId, apiKey);
    return { ...geminiRes, isWav: true };
  } catch (geminiErr: any) {
    console.warn("[AudioTTS] Gemini TTS attempt failed:", geminiErr?.message, "- checking Cloud TTS fallback...");
    
    // Only attempt Cloud TTS if not previously disabled
    if (!cloudTtsServiceDisabled) {
      try {
        const token = await getGoogleAccessToken(apiKey);
        const url = token
          ? "https://texttospeech.googleapis.com/v1/text:synthesize"
          : `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            input: { text },
            voice: { languageCode: "en-GB", name: voiceId },
            audioConfig: { audioEncoding: "MP3", speakingRate, pitch: 0.0 }
          })
        });

        if (res.ok) {
          const data: any = await res.json();
          if (data.audioContent) {
            return {
              buffer: Buffer.from(data.audioContent, "base64"),
              mimeType: "audio/mpeg",
              isWav: false
            };
          }
        } else {
          cloudTtsServiceDisabled = true;
          console.warn(`[AudioTTS] Cloud TTS returned ${res.status}. Sticking with Gemini TTS.`);
        }
      } catch (cloudErr: any) {
        cloudTtsServiceDisabled = true;
        console.warn("[AudioTTS] Cloud TTS fallback also failed:", cloudErr.message);
      }
    }

    throw new Error(`Text-to-speech generation failed: ${geminiErr?.message || "Unknown error"}`);
  }
}

/**
 * Extract plain text from PDF, DOCX, or TXT buffer
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<{ text: string; wordCount: number }> {
  let rawText = "";

  const lowerName = fileName.toLowerCase();
  const isPdf = mimeType.includes("pdf") || lowerName.endsWith(".pdf");
  const isDocx =
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("officedocument") ||
    lowerName.endsWith(".docx");

  if (isPdf) {
    rawText = await parsePdfBuffer(buffer);
  } else if (isDocx) {
    const docxResult = await mammoth.extractRawText({ buffer });
    rawText = docxResult.value || "";
  } else {
    // Plain text or markdown
    rawText = buffer.toString("utf8");
  }

  // Clean and normalize text
  const cleanedText = rawText
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const words = cleanedText ? cleanedText.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  return {
    text: cleanedText,
    wordCount
  };
}

/**
 * Split text into chunks suitable for TTS (max ~200 words per chunk),
 * respecting paragraph and sentence boundaries, avoiding huge single chunks.
 */
export function chunkTextForTts(text: string, maxWordsPerChunk = 200): string[] {
  if (!text || !text.trim()) return [];

  // Remove page numbers, separator lines, and non-readable noise from PDF/DOCX
  const cleanInput = text
    .replace(/^--\s*\d+\s+of\s+\d+\s*--$/gm, "")
    .replace(/^[_\-=*~]{4,}$/gm, "")
    .replace(/\r\n/g, "\n");

  const paragraphs = cleanInput.split(/\n{2,}/);
  const chunks: string[] = [];
  let currentChunkParagraphs: string[] = [];
  let currentChunkWordCount = 0;

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    const paraWords = trimmedPara.split(/\s+/).filter(Boolean);
    const paraWordCount = paraWords.length;
    if (paraWordCount === 0) continue;

    // If this paragraph alone exceeds maxWordsPerChunk, split it by sentences
    if (paraWordCount > maxWordsPerChunk) {
      if (currentChunkParagraphs.length > 0) {
        chunks.push(currentChunkParagraphs.join("\n\n"));
        currentChunkParagraphs = [];
        currentChunkWordCount = 0;
      }

      const sentences = trimmedPara.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [trimmedPara];
      let sentBuffer: string[] = [];
      let sentWordCount = 0;

      for (const sent of sentences) {
        const sTrimmed = sent.trim();
        if (!sTrimmed) continue;
        const sWords = sTrimmed.split(/\s+/).filter(Boolean).length;

        if (sentWordCount + sWords > maxWordsPerChunk && sentBuffer.length > 0) {
          chunks.push(sentBuffer.join(" "));
          sentBuffer = [];
          sentWordCount = 0;
        }
        sentBuffer.push(sTrimmed);
        sentWordCount += sWords;
      }

      if (sentBuffer.length > 0) {
        chunks.push(sentBuffer.join(" "));
      }
      continue;
    }

    // Paragraph fits or starts a new chunk
    if (currentChunkWordCount + paraWordCount <= maxWordsPerChunk) {
      currentChunkParagraphs.push(trimmedPara);
      currentChunkWordCount += paraWordCount;
    } else {
      if (currentChunkParagraphs.length > 0) {
        chunks.push(currentChunkParagraphs.join("\n\n"));
      }
      currentChunkParagraphs = [trimmedPara];
      currentChunkWordCount = paraWordCount;
    }
  }

  if (currentChunkParagraphs.length > 0) {
    chunks.push(currentChunkParagraphs.join("\n\n"));
  }

  // Final filter to ensure no empty or blank chunks
  return chunks.map(c => c.trim()).filter(c => c.length > 0);
}

/**
 * Get date keys (today and current month in UTC/UK format)
 */
export function getDateKeys(): { todayKey: string; monthKey: string } {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return {
    todayKey: `${yyyy}-${mm}-${dd}`,
    monthKey: `${yyyy}-${mm}`
  };
}

/**
 * Check if user is staff (unlimited quota)
 */
export function checkIsStaffUser(userEmail?: string, explicitStaffFlag = false): boolean {
  if (explicitStaffFlag) return true;
  if (!userEmail) return false;
  const emailLower = userEmail.toLowerCase().trim();
  return (
    emailLower.endsWith("@oca.ac.uk") ||
    emailLower === "paulvincent@oca.ac.uk" ||
    emailLower.includes("staff")
  );
}

/**
 * Check user's current audio conversion quota
 */
export async function getUserAudioQuota(
  userId: string,
  userEmail: string,
  explicitStaff = false
): Promise<AudioQuotaStatus> {
  const isStaff = checkIsStaffUser(userEmail, explicitStaff);
  const { todayKey, monthKey } = getDateKeys();

  const dailyLimit = 5;
  const monthlyLimit = 10;

  // Staff have unlimited allowance
  if (isStaff) {
    return {
      allowed: true,
      isStaff: true,
      dailyUsed: 0,
      dailyLimit: 9999,
      monthlyUsed: 0,
      monthlyLimit: 9999,
      dailyRemaining: 9999,
      monthlyRemaining: 9999,
      todayKey,
      monthKey
    };
  }

  // Check local resilient store first
  const localStore = loadLocalAudioStore();
  const userLocalQuota = localStore.quotas[userId];

  let dailyUsed = 0;
  let monthlyUsed = 0;

  if (userLocalQuota) {
    if (userLocalQuota.todayKey === todayKey) {
      dailyUsed = Number(userLocalQuota.dailyCount || 0);
    }
    if (userLocalQuota.monthKey === monthKey) {
      monthlyUsed = Number(userLocalQuota.monthlyCount || 0);
    }
  }

  // Optionally check Firestore quietly if available
  try {
    const db = getAdminFirestore();
    const quotaRef = db.collection("audio_quotas").doc(userId);
    const snap = await quotaRef.get();

    if (snap.exists) {
      const data = snap.data() || {};
      if (data.todayKey === todayKey) {
        dailyUsed = Math.max(dailyUsed, Number(data.dailyCount || 0));
      }
      if (data.monthKey === monthKey) {
        monthlyUsed = Math.max(monthlyUsed, Number(data.monthlyCount || 0));
      }
    }
  } catch (err: any) {
    // Normal when server environment has no ADC IAM role; local store provides persistent tracking
    if (!err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("[AudioTTS] Firestore quota check note:", err.message);
    }
  }

  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

  if (dailyUsed >= dailyLimit) {
    return {
      allowed: false,
      isStaff: false,
      dailyUsed,
      dailyLimit,
      monthlyUsed,
      monthlyLimit,
      dailyRemaining,
      monthlyRemaining,
      todayKey,
      monthKey,
      reason: `Daily quota limit reached (5 requests/day). Your quota will reset tomorrow.`
    };
  }

  if (monthlyUsed >= monthlyLimit) {
    return {
      allowed: false,
      isStaff: false,
      dailyUsed,
      dailyLimit,
      monthlyUsed,
      monthlyLimit,
      dailyRemaining,
      monthlyRemaining,
      todayKey,
      monthKey,
      reason: `Monthly quota limit reached (10 requests/month). Your quota will reset next month.`
    };
  }

  return {
    allowed: true,
    isStaff: false,
    dailyUsed,
    dailyLimit,
    monthlyUsed,
    monthlyLimit,
    dailyRemaining,
    monthlyRemaining,
    todayKey,
    monthKey
  };
}

interface AudioStoreData {
  quotas: Record<
    string,
    {
      userId: string;
      userEmail: string;
      isStaff: boolean;
      todayKey: string;
      monthKey: string;
      dailyCount: number;
      monthlyCount: number;
      totalWordsProcessed: number;
      lastRequestedAt: string;
    }
  >;
  documents: Record<string, AudioDocumentRecord>;
}

const AUDIO_STORE_PATH = path.join(AUDIO_STORAGE_DIR, "audio_data_store.json");

function loadLocalAudioStore(): AudioStoreData {
  try {
    if (fs.existsSync(AUDIO_STORE_PATH)) {
      const content = fs.readFileSync(AUDIO_STORE_PATH, "utf8");
      const parsed = JSON.parse(content);
      return {
        quotas: parsed.quotas || {},
        documents: parsed.documents || {}
      };
    }
  } catch (e) {
    console.warn("[AudioTTS] Could not read audio_data_store.json:", e);
  }
  return { quotas: {}, documents: {} };
}

function saveLocalAudioStore(data: AudioStoreData): void {
  try {
    fs.writeFileSync(AUDIO_STORE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.warn("[AudioTTS] Could not write audio_data_store.json:", e);
  }
}

/**
 * Increment quota in local store and Firestore after successful audio conversion
 */
export async function incrementUserAudioQuota(
  userId: string,
  userEmail: string,
  wordsCount: number,
  explicitStaff = false
): Promise<void> {
  const isStaff = checkIsStaffUser(userEmail, explicitStaff);
  const { todayKey, monthKey } = getDateKeys();

  // 1. Update local persistent store
  try {
    const store = loadLocalAudioStore();
    const existing = store.quotas[userId];
    const newDaily = existing && existing.todayKey === todayKey ? existing.dailyCount + 1 : 1;
    const newMonthly = existing && existing.monthKey === monthKey ? existing.monthlyCount + 1 : 1;
    const totalWords = (existing?.totalWordsProcessed || 0) + wordsCount;

    store.quotas[userId] = {
      userId,
      userEmail: userEmail || "",
      isStaff,
      todayKey,
      monthKey,
      dailyCount: newDaily,
      monthlyCount: newMonthly,
      totalWordsProcessed: totalWords,
      lastRequestedAt: new Date().toISOString()
    };
    saveLocalAudioStore(store);
  } catch (e: any) {
    console.warn("[AudioTTS] Local quota save error:", e.message);
  }

  // 2. Quietly attempt Firestore sync if available
  try {
    const db = getAdminFirestore();
    const quotaRef = db.collection("audio_quotas").doc(userId);
    const snap = await quotaRef.get();

    let newDailyCount = 1;
    let newMonthlyCount = 1;
    let totalWordsProcessed = wordsCount;

    if (snap.exists) {
      const data = snap.data() || {};
      newDailyCount = data.todayKey === todayKey ? Number(data.dailyCount || 0) + 1 : 1;
      newMonthlyCount = data.monthKey === monthKey ? Number(data.monthlyCount || 0) + 1 : 1;
      totalWordsProcessed = Number(data.totalWordsProcessed || 0) + wordsCount;
    }

    await quotaRef.set(
      {
        userId,
        userEmail: userEmail || "",
        isStaff,
        todayKey,
        monthKey,
        dailyCount: newDailyCount,
        monthlyCount: newMonthlyCount,
        totalWordsProcessed,
        lastRequestedAt: new Date()
      },
      { merge: true }
    );
  } catch (err: any) {
    if (!err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("[AudioTTS] Firestore quota increment note:", err.message);
    }
  }
}

/**
 * Save audio document record in local store and Firestore
 */
export async function recordAudioDocument(record: AudioDocumentRecord): Promise<void> {
  // 1. Save in local store
  try {
    const store = loadLocalAudioStore();
    store.documents[record.id] = record;
    saveLocalAudioStore(store);
  } catch (e: any) {
    console.warn("[AudioTTS] Local document record error:", e.message);
  }

  // 2. Quietly attempt Firestore sync
  try {
    const db = getAdminFirestore();
    await db.collection("audio_documents").doc(record.id).set({
      ...record,
      createdAtServer: new Date()
    });
  } catch (err: any) {
    if (!err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("[AudioTTS] Firestore record note:", err.message);
    }
  }
}

/**
 * Fetch saved audio documents for a user (merging local store and Firestore)
 */
export async function getUserAudioHistory(userId: string): Promise<AudioDocumentRecord[]> {
  const store = loadLocalAudioStore();
  const userDocs = Object.values(store.documents).filter(d => d.userId === userId);
  const itemsMap = new Map<string, AudioDocumentRecord>();

  for (const doc of userDocs) {
    itemsMap.set(doc.id, doc);
  }

  // Attempt to merge from Firestore if accessible
  try {
    const db = getAdminFirestore();
    const snap = await db
      .collection("audio_documents")
      .where("userId", "==", userId)
      .limit(50)
      .get();

    snap.forEach(docSnap => {
      const data = docSnap.data() as AudioDocumentRecord;
      itemsMap.set(data.id, data);
    });
  } catch (err: any) {
    // Expected when running without cross-project service account credentials; local store serves records
    if (!err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("[AudioTTS] Firestore history sync note:", err.message);
    }
  }

  const items = Array.from(itemsMap.values());
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return items;
}

/**
 * Delete a user's audio document from local store, disk, and Firestore
 */
export async function deleteUserAudioDocument(userId: string, docId: string): Promise<boolean> {
  // 1. Remove from local store
  try {
    const store = loadLocalAudioStore();
    if (store.documents[docId]) {
      delete store.documents[docId];
      saveLocalAudioStore(store);
    }
  } catch (e: any) {
    console.warn("[AudioTTS] Local document delete error:", e.message);
  }

  // 2. Delete local audio files if present (.wav or .mp3)
  const localMp3 = path.join(AUDIO_STORAGE_DIR, `${docId}.mp3`);
  const localWav = path.join(AUDIO_STORAGE_DIR, `${docId}.wav`);
  for (const p of [localMp3, localWav]) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        console.warn("[AudioTTS] Could not delete local file:", e);
      }
    }
  }

  // 3. Delete from Firestore if permitted
  try {
    const db = getAdminFirestore();
    const docRef = db.collection("audio_documents").doc(docId);
    await docRef.delete();
  } catch (err: any) {
    if (!err?.message?.includes("PERMISSION_DENIED")) {
      console.warn("[AudioTTS] Firestore doc delete note:", err.message);
    }
  }

  return true;
}

/**
 * Full pipeline: Process file buffer, chunk, synthesize with Google Gemini TTS,
 * save audio, update quota and records.
 */
export async function processDocumentToAudio(params: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  voiceId: string;
  userId: string;
  userEmail: string;
  isStaff?: boolean;
  apiKey: string;
  publicBaseUrl?: string;
  onProgress?: (step: string, percent: number) => void;
}): Promise<{
  id: string;
  audioUrl: string;
  durationSeconds: number;
  wordCount: number;
  fileName: string;
  voiceName: string;
}> {
  const {
    fileBuffer,
    fileName,
    mimeType,
    voiceId,
    userId,
    userEmail,
    isStaff = false,
    apiKey
  } = params;

  // 1. Check Quota first
  const quota = await getUserAudioQuota(userId, userEmail, isStaff);
  if (!quota.allowed) {
    throw new Error(quota.reason || "Quota limit exceeded for audio generation.");
  }

  // 2. Extract Text
  const { text, wordCount } = await extractDocumentText(fileBuffer, mimeType, fileName);

  if (!text || wordCount === 0) {
    throw new Error("The uploaded file does not contain readable text. Please check the document.");
  }

  // Max 30,000 words limit
  const MAX_WORDS = 30000;
  if (wordCount > MAX_WORDS) {
    throw new Error(
      `Document exceeds the maximum limit of ${MAX_WORDS.toLocaleString()} words (found ${wordCount.toLocaleString()} words). Please shorten your document and try again.`
    );
  }

  // 3. Chunk text (aim for ~200 words per chunk for fast, reliable TTS without hitting token limits)
  const chunks = chunkTextForTts(text, 200);
  console.log(`[AudioTTS] Extracted ${wordCount} words into ${chunks.length} chunks for "${fileName}"`);

  // Selected voice details
  const selectedVoice = UK_VOICES.find(v => v.id === voiceId) || UK_VOICES[0];

  // 4. Synthesize all chunks
  const audioBuffers: Buffer[] = [];
  let isWavFormat = true;

  for (let i = 0; i < chunks.length; i++) {
    const chunkWords = chunks[i].split(/\s+/).filter(Boolean).length;
    console.log(`[AudioTTS] Synthesizing chunk ${i + 1}/${chunks.length} (~${chunkWords} words) using ${selectedVoice.id}...`);

    try {
      const chunkResult = await synthesizeTtsChunk(chunks[i], selectedVoice.id, apiKey);
      if (chunkResult.buffer && chunkResult.buffer.length > 44) {
        audioBuffers.push(chunkResult.buffer);
        isWavFormat = chunkResult.isWav;
      }
    } catch (chunkErr: any) {
      console.warn(`[AudioTTS] Chunk ${i + 1}/${chunks.length} initial attempt warning: ${chunkErr.message}. Retrying once...`);
      try {
        await new Promise(r => setTimeout(r, 400));
        const retryResult = await synthesizeTtsChunk(chunks[i], selectedVoice.id, apiKey);
        if (retryResult.buffer && retryResult.buffer.length > 44) {
          audioBuffers.push(retryResult.buffer);
          isWavFormat = retryResult.isWav;
        }
      } catch (retryErr: any) {
        console.warn(`[AudioTTS] Chunk ${i + 1}/${chunks.length} retry failed: ${retryErr.message}. Continuing with remaining chunks.`);
      }
    }

    // Polite throttle between TTS requests to stay within API rate quotas
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (audioBuffers.length === 0) {
    throw new Error("Unable to synthesize audio. The document text could not be processed into speech. Please verify the document text.");
  }

  // 5. Concatenate audio buffers (WAV requires header recalculation, MP3 is raw stream concatenation)
  const fullAudioBuffer = isWavFormat
    ? concatWavBuffers(audioBuffers)
    : Buffer.concat(audioBuffers);

  // 6. Save to disk
  const docId = `audio_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const ext = isWavFormat ? "wav" : "mp3";
  const outFileName = `${docId}.${ext}`;
  const outPath = path.join(AUDIO_STORAGE_DIR, outFileName);

  fs.writeFileSync(outPath, fullAudioBuffer);

  // Approximate duration: average speaking rate ~140 words per minute
  const durationSeconds = Math.max(5, Math.round((wordCount / 140) * 60));
  const audioUrl = `/generated_audio/${outFileName}`;

  // 7. Update quota
  await incrementUserAudioQuota(userId, userEmail, wordCount, isStaff);

  // 8. Record in Firestore
  const record: AudioDocumentRecord = {
    id: docId,
    userId,
    userEmail: userEmail || "",
    fileName,
    fileType: fileName.split(".").pop() || "doc",
    wordCount,
    voiceId: selectedVoice.id,
    voiceName: selectedVoice.displayName,
    audioUrl,
    durationSeconds,
    status: "completed",
    createdAt: new Date().toISOString()
  };

  await recordAudioDocument(record);

  return {
    id: docId,
    audioUrl,
    durationSeconds,
    wordCount,
    fileName,
    voiceName: selectedVoice.displayName
  };
}
