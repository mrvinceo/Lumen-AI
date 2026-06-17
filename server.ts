import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import admin from "firebase-admin";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import cookieParser from "cookie-parser";
import AdmZip from "adm-zip";
import mammoth from "mammoth";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// const pdf = require("pdf-parse"); // Removed as we use Gemini for PDF extraction now
const firebaseConfig = require("./firebase-applet-config.json");

dotenv.config();

// Initialize Firebase Admin
if (firebaseConfig.projectId) {
  process.env.FIREBASE_PROJECT_ID = firebaseConfig.projectId;
  process.env.GCLOUD_PROJECT = firebaseConfig.projectId;
}

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: firebaseConfig?.projectId
  });
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper for fetch with exponential backoff on 429s
async function fetchWithRetry(url: string, options: any, maxRetries = 2) {
  let retries = 0;
  while (retries <= maxRetries) {
    const res = await fetch(url, options);
    if (res.status === 429 && retries < maxRetries) {
      const waitTime = Math.pow(2, retries) * 1500 + Math.random() * 1000;
      console.warn(`Gemini rate limited (429). Retry ${retries + 1}/${maxRetries} in ${Math.round(waitTime)}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      retries++;
      continue;
    }
    return res;
  }
}

// Aggressive API Key Lookup
function getApiKey() {
  const keys = [
    "LUMEN_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "NEXT_PUBLIC_GEMINI_API_KEY",
    "VITE_GEMINI_API_KEY",
    "API_KEY"
  ];
  
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      const trimmed = value.trim();
      // Only filter out exact common placeholder names
      const placeholders = [
        "MY_GEMINI_API_KEY",
        "YOUR_API_KEY",
        "REPLACE_WITH_YOUR_KEY",
        "YOUR_GOOGLE_CLIENT_ID",
        "YOUR_GOOGLE_CLIENT_SECRET",
        "MY_APP_URL"
      ];
      if (!placeholders.includes(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

function getDiagnostics() {
  const envKeys = Object.keys(process.env);
  const relevantKeys = envKeys.filter(k => 
    k.includes("API") || k.includes("KEY") || k.includes("GOOGLE") || k.includes("GEMINI")
  );
  
  return relevantKeys.map(k => {
    const val = process.env[k] || "";
    const isPlaceholder = ["MY_GEMINI_API_KEY", "YOUR_API_KEY"].includes(val);
    return `${k}(len:${val.length},prefix:${val.substring(0, 3)}...,placeholder:${isPlaceholder})`;
  }).join(", ") || "No relevant keys found";
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cookieParser());
  app.use(express.json({ limit: "50mb" }));

  // Auth Session Endpoints for Cross-Subdomain SSO
  app.post("/api/auth/session", async (req, res) => {
    try {
      const { idToken } = req.body;
      if (!idToken) return res.status(400).json({ error: "Missing idToken" });

      // Verify the ID token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const uid = decodedToken.uid;

      // Set a long-lived session cookie for the root domain
      // We are using a secure, httpOnly cookie scoped to .oca.ac.uk if in production
      const host = req.get("host") || "";
      const cookieOptions: any = {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: true,
        sameSite: "none", // Required for iframe context
      };
      if (host.includes("oca.ac.uk")) {
        cookieOptions.domain = ".oca.ac.uk";
      }
      res.cookie("lumen_uid", uid, cookieOptions);

      res.json({ status: "success", uid });
    } catch (error) {
      console.error("Auth session error:", error);
      res.status(401).json({ error: "Invalid token" });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    try {
      const uid = req.cookies.lumen_uid;
      if (!uid) return res.status(401).json({ error: "Not authenticated" });

      // Generate a client custom token to sync the Firebase Client Auth SDK in iframes/embeds
      const customToken = await admin.auth().createCustomToken(uid);
      res.json({ uid, customToken });
    } catch (err: any) {
      console.error("Failed to generate Custom Token for session sync:", err);
      res.status(500).json({ error: err.message || "Failed to generate session token." });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const host = req.get("host") || "";
    const cookieOptions: any = {};
    if (host.includes("oca.ac.uk")) {
      cookieOptions.domain = ".oca.ac.uk";
    }
    res.clearCookie("lumen_uid", cookieOptions);
    res.json({ status: "success" });
  });

  // Rate Limiting Logic
  async function checkRateLimit() {
    try {
      const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
      const today = new Date().toISOString().split('T')[0];
      const statsRef = firestore.collection('stats').doc('daily_usage');
      const settingsRef = firestore.collection('settings').doc('rate_limit');

      // 1. Get current limit (default 150)
      const settingsDoc = await settingsRef.get();
      const maxLimit = settingsDoc.exists ? settingsDoc.data()?.value : 150;

      // 2. Get current usage
      const statsDoc = await statsRef.get();
      let usage = 0;
      
      if (statsDoc.exists) {
        const data = statsDoc.data();
        if (data?.date === today) {
          usage = data?.count || 0;
        } else {
          // New day, reset count
          await statsRef.set({ count: 0, date: today });
          usage = 0;
          console.log(`Rate limit reset for new day: ${today}`);
        }
      } else {
        // First time initialization
        await statsRef.set({ count: 0, date: today });
        usage = 0;
      }

      return { isLimited: usage >= maxLimit, currentUsage: usage, maxLimit };
    } catch (err: any) {
      console.error("Rate limit check failed (bypassing):", err.message);
      // Fail open if database is unreachable or permission denied to keep chat working
      return { isLimited: false, currentUsage: 0, maxLimit: 150 };
    }
  }

  async function incrementUsage() {
    try {
      const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
      const today = new Date().toISOString().split('T')[0];
      const statsRef = firestore.collection('stats').doc('daily_usage');
      
      await statsRef.set({
        count: FieldValue.increment(1),
        date: today
      }, { merge: true });
    } catch (err: any) {
      console.error("Increment usage failed:", err.message);
    }
  }

  // Gemini Proxy Endpoints
  // Using direct fetch to ensure API key is properly passed in embedded environments
  app.post("/api/gemini/generateContent", async (req, res) => {
    try {
      const activeApiKey = getApiKey();
      
      if (!activeApiKey) {
        console.error("Critical: No Gemini API key found. Diagnostics:", getDiagnostics());
        return res.status(500).json({ 
          error: "Gemini API key is missing on the server.", 
          diagnostics: getDiagnostics(),
          hint: "Please ensure GEMINI_API_KEY is set in your AI Studio Secrets panel and wait for deployment to finish."
        });
      }

      // Check Rate Limit
      const { isLimited, currentUsage, maxLimit } = await checkRateLimit();
      if (isLimited) {
        console.warn(`Global rate limit hit: ${currentUsage}/${maxLimit}`);
        return res.status(429).json({ 
          error: "DAILY_RATE_LIMIT_EXCEEDED", 
          message: "Lumen's global daily message limit has been reached. The limit resets at midnight every day.",
          currentUsage,
          maxLimit
        });
      }

      const { model, contents, config, personaId } = req.body;
      const modelName = model || "gemini-2.0-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeApiKey}`;

      // Handle Persona integration
      let additionalInstruction = "";
      if (personaId) {
        try {
          const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
          const personaDoc = await firestore.collection('personas').doc(personaId).get();
          if (personaDoc.exists) {
            const personaData = personaDoc.data();
            additionalInstruction = personaData?.system_prompt || "";
            console.log(`Applying persona: ${personaData?.display_name}`);
          }
        } catch (err) {
          console.error("Failed to fetch persona data:", err);
        }
      }

      // Normalize SDK-style config to REST-style payload
      const restPayload: any = {
        contents: Array.isArray(contents) ? contents : [contents],
      };

      if (config || additionalInstruction) {
        // Handle systemInstruction
        let systemText = "";
        if (config?.systemInstruction) {
          if (typeof config.systemInstruction === 'string') {
            systemText = config.systemInstruction;
          } else if (config.systemInstruction.parts && config.systemInstruction.parts[0]) {
            systemText = config.systemInstruction.parts[0].text;
          }
        }

        if (additionalInstruction) {
          // Wrap the entire task context inside the persona's persona to ensure 100% adherence to the voice.
          systemText = `
          # YOUR CORE IDENTITY:
          ${additionalInstruction}

          # YOUR KNOWLEDGE BASE & TECHNICAL GUIDELINES:
          The following are your specific task instructions and access to technical information. YOU MUST ADHERE TO THESE WHILE REMAINING 100% IN CHARACTER. 
          If you use the provided research or knowledge base, refer to it as your own memory, letters, or wisdom. Never break character.
          
          --- TECHNICAL TASK CONTEXT START ---
          ${systemText}
          --- TECHNICAL TASK CONTEXT END ---

          # FINAL COMMAND:
          Never refer to yourself as an AI or mention that you are "Based on" a persona. You ARE the persona described in the CORE IDENTITY. Use 'I', 'me', 'my', do NOT refer to yourself in the third person.
          `.trim();
        }

        if (systemText) {
          restPayload.systemInstruction = {
            parts: [{ text: systemText }]
          };
        }

        // Handle tools
        if (config?.tools) {
          restPayload.tools = config.tools;
        }

        // Handle toolConfig
        if (config?.toolConfig) {
          restPayload.toolConfig = config.toolConfig;
        }

        // Handle generationConfig
        const genConfigKeys = ['temperature', 'topP', 'topK', 'candidateCount', 'maxOutputTokens', 'stopSequences', 'responseMimeType', 'responseSchema'];
        const generationConfig: any = {};
        genConfigKeys.forEach(key => {
          if (config && config[key] !== undefined) {
            generationConfig[key] = config[key];
          }
        });
        
        // Also check if config.generationConfig exists
        if (config?.generationConfig) {
          Object.assign(generationConfig, config.generationConfig);
        }

        if (Object.keys(generationConfig).length > 0) {
          restPayload.generationConfig = generationConfig;
        }

        // Handle safetySettings
        if (config?.safetySettings) {
          restPayload.safetySettings = config.safetySettings;
        }
      }

      const geminiRes = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(restPayload)
      }) || await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(restPayload) });

      const data = await geminiRes.json();
      
      if (!geminiRes.ok) {
        console.error("Gemini API Error Response:", JSON.stringify(data));
        return res.status(geminiRes.status).json(data);
      }

      // Increment global usage counter
      await incrementUsage();

      res.json(data);
    } catch (error: any) {
      console.error("Gemini Proxy Error (Generate):", error);
      res.status(500).json({ error: error.message || "Internal server error during Gemini proxy call" });
    }
  });

  app.post("/api/gemini/embedContent", async (req, res) => {
    try {
      const activeApiKey = getApiKey();
      
      if (!activeApiKey) {
        return res.status(500).json({ 
          error: "Gemini API key is missing on the server.",
          diagnostics: getDiagnostics()
        });
      }

      const { model, content, config } = req.body;
      const modelName = model || "gemini-embedding-2-preview";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${activeApiKey}`;

      const geminiRes = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, ...config })
      }) || await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, ...config }) });

      const data = await geminiRes.json();
      
      if (!geminiRes.ok) {
        console.error("Gemini API Error Response (Embed):", JSON.stringify(data));
        return res.status(geminiRes.status).json(data);
      }

      res.json(data);
    } catch (error: any) {
      console.error("Gemini Proxy Error (Embed):", error);
      res.status(500).json({ error: error.message || "Internal server error during Gemini proxy call" });
    }
  });

  // Moodle API Proxy & Cataloguer
  app.post("/api/moodle/catalogue", async (req, res) => {
    const { unitCode } = req.body;
    const token = process.env.MOODLE_TOKEN;
    const baseUrl = "https://learn.oca.ac.uk/webservice/rest/server.php";

    if (!token) {
      console.error("Moodle token is missing from environment variables.");
      return res.status(500).json({ error: "Moodle configuration error: Token is missing." });
    }

    const logs: { level: "info" | "warning" | "error"; message: string; timestamp: string }[] = [];
    const addLog = (level: "info" | "warning" | "error", message: string) => {
      const timestamp = new Date().toISOString();
      console.log(`[CatalogueLog][${level.toUpperCase()}] ${message}`);
      logs.push({ level, message, timestamp });
    };

    const modulesLog: { name: string; type: string; status: "success" | "warning" | "error"; chunksCount: number; details: string }[] = [];
    const addModuleLog = (name: string, type: string, status: "success" | "warning" | "error", chunksCount: number, details: string) => {
      modulesLog.push({ name, type, status, chunksCount, details });
    };

    addLog("info", `Starting cataloguing process for unit code "${unitCode}"`);

    try {
      // 1. Get course by idnumber
      addLog("info", `Looking up course in Moodle by field 'idnumber' with value '${unitCode}'...`);
      let courseRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=core_course_get_courses_by_field&moodlewsrestformat=json&field=idnumber&value=${encodeURIComponent(unitCode)}`);
      let courseData = await courseRes.json();
      
      if (courseData.exception) {
        addLog("error", `Moodle Course Fetch Exception: ${courseData.message}`);
        return res.status(500).json({ error: `Moodle API error: ${courseData.message}`, logs });
      }

      if (!courseData.courses || courseData.courses.length === 0) {
        addLog("info", `Course "${unitCode}" not found by idnumber, testing field 'shortname'...`);
        courseRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=core_course_get_courses_by_field&moodlewsrestformat=json&field=shortname&value=${encodeURIComponent(unitCode)}`);
        courseData = await courseRes.json();
      }

      if (!courseData.courses || courseData.courses.length === 0) {
        addLog("error", `Course "${unitCode}" not found in Moodle by idnumber or shortname.`);
        return res.status(404).json({ error: `Course "${unitCode}" not found. Please ensure the Unit Code is correct and exists in OCA Learn.`, logs });
      }

      const course = courseData.courses[0];
      const courseId = course.id;
      addLog("info", `Successfully identified course target in Moodle: "${course.fullname}" (Course ID: ${courseId})`);

      // 2. Get course contents
      addLog("info", `Fetching complete sections and course modules outline for course ID ${courseId}...`);
      const contentsRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=core_course_get_contents&moodlewsrestformat=json&courseid=${courseId}`);
      const sections = await contentsRes.json();

      if (sections.exception) {
        addLog("error", `Moodle Contents Fetch Exception: ${sections.message}`);
        const advice = sections.exception === 'webservice_access_exception' 
          ? " Please ensure the Moodle token has the 'core_course_get_contents' capability."
          : "";
        return res.status(500).json({ error: `Moodle API error: ${sections.message}.${advice}`, logs });
      }

      if (!Array.isArray(sections)) {
        addLog("error", `Contents API returned unexpected non-array payload format.`);
        return res.status(500).json({ error: "Moodle API returned an unexpected response format for course contents.", logs });
      }

      addLog("info", `Received ${sections.length} course sections.`);
      const chunks: any[] = [];

      const stripHtml = (html: string) => {
        return html
          // Remove scripts and styles
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          // Remove images with base64 data specifically
          .replace(/<img[^>]+src="data:image\/[^;]+;base64,[^"]+"[^>]*>/gi, "")
          // Remove all multimedia tags
          .replace(/<(img|video|audio|source|embed|object|iframe)\b[^>]*>/gi, "")
          // Remove any remaining base64-like strings (very long alphanumeric strings without spaces)
          .replace(/[a-zA-Z0-9+/]{100,}/g, " ")
          // Remove all other tags
          .replace(/<[^>]*>/g, " ")
          // Clean up entities and whitespace
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/\s+/g, " ")
          .trim();
      };

      // Prefetch Assignments and Pages
      addLog("info", `Prefetching assignments detail payload to index complete intro fields...`);
      const assignmentsMap = new Map<string, { intro: string, name: string }>();
      try {
        const assignUrl = `${baseUrl}?wstoken=${token}&wsfunction=mod_assign_get_assignments&moodlewsrestformat=json&courseids[0]=${courseId}`;
        const assignRes = await fetch(assignUrl);
        const assignData = await assignRes.json();
        if (assignData && assignData.courses && Array.isArray(assignData.courses)) {
          for (const c of assignData.courses) {
            if (c.assignments && Array.isArray(c.assignments)) {
              for (const a of c.assignments) {
                const info = { intro: a.intro || "", name: a.name || "" };
                if (a.id) {
                  assignmentsMap.set(`instance-${a.id}`, info);
                }
                const cmid = a.cmid || a.coursemodule;
                if (cmid) {
                  assignmentsMap.set(`cmid-${cmid}`, info);
                }
              }
            }
          }
          addLog("info", `Successfully prefetched descriptions for ${assignmentsMap.size / 2} assignments in course.`);
        } else {
          addLog("warning", `Prefetching assignments returned no courses or unexpected format: ${JSON.stringify(assignData)}`);
        }
      } catch (err: any) {
        addLog("warning", `Failed to prefetch assignments detail: ${err.message}`);
      }

      addLog("info", `Prefetching custom page content details to index sub-page bodies...`);
      const pagesMap = new Map<string, { content: string, name: string, intro: string }>();
      try {
        const pageUrl = `${baseUrl}?wstoken=${token}&wsfunction=mod_page_get_pages_by_courses&moodlewsrestformat=json&courseids[0]=${courseId}`;
        const pageRes = await fetch(pageUrl);
        const pageData = await pageRes.json();
        if (pageData && pageData.pages && Array.isArray(pageData.pages)) {
          for (const p of pageData.pages) {
            const info = { content: p.content || "", name: p.name || "", intro: p.intro || "" };
            if (p.id) {
              pagesMap.set(`instance-${p.id}`, info);
            }
            const cmid = p.coursemodule || p.cmid;
            if (cmid) {
              pagesMap.set(`cmid-${cmid}`, info);
            }
          }
          addLog("info", `Successfully prefetched content body for ${pagesMap.size / 2} text/HTML pages in course.`);
        } else {
          addLog("warning", `Prefetching pages returned no pages or unexpected shape: ${JSON.stringify(pageData)}`);
        }
      } catch (err: any) {
        addLog("warning", `Failed to prefetch page bodies: ${err.message}`);
      }

      let modulesProcessed = 0;
      let assignmentsCount = 0;
      let pagesCount = 0;
      let booksCount = 0;
      let scormsCount = 0;
      let labelsCount = 0;

      for (const section of sections) {
        const sectionName = section.name || "Unnamed Section";
        addLog("info", `Parsing Section: "${sectionName}"`);
        
        for (const module of section.modules) {
          modulesProcessed++;
          let content = "";
          let title = module.name;
          const moduleUrl = module.url || `https://learn.oca.ac.uk/mod/${module.modname}/view.php?id=${module.id}`;
          
          let moduleChunks = 0;
          let moduleDetails = "";
          let moduleStatus: "success" | "warning" | "error" = "success";

          if (module.modname === "page" || module.modname === "assign" || module.modname === "label") {
            const descriptionText = module.description || "";
            const introText = module.intro || "";
            
            content = descriptionText + "\n" + introText;

            if (module.modname === "assign") {
              assignmentsCount++;
              const assignmentInfo = assignmentsMap.get(`cmid-${module.id}`) || assignmentsMap.get(`instance-${module.instance}`);
              if (assignmentInfo) {
                content += "\n" + (assignmentInfo.intro || "");
                moduleDetails = `Prefetched detailed intro text.`;
              } else {
                addLog("warning", `Assignment "${module.name}" (CMID: ${module.id}) details not found in prefetch. Proceeding with basic metadata.`);
                moduleDetails = `Basic description only; full body not prefetched.`;
                moduleStatus = "warning";
              }
            } else if (module.modname === "page") {
              pagesCount++;
              const pageInfo = pagesMap.get(`cmid-${module.id}`) || pagesMap.get(`instance-${module.instance}`);
              if (pageInfo) {
                content += "\n" + (pageInfo.content || "") + "\n" + (pageInfo.intro || "");
                moduleDetails = `Prefetched page content.`;
              } else if (module.contents) {
                let hasExtraFile = false;
                for (const file of module.contents) {
                  if (file.type === "content") {
                    content += "\n" + file.content;
                    hasExtraFile = true;
                  }
                }
                if (hasExtraFile) {
                  moduleDetails = `Flipped back to module resource attachments metadata.`;
                } else {
                  moduleDetails = `Empty page content fields.`;
                  moduleStatus = "warning";
                }
              } else {
                moduleDetails = `Page body is empty.`;
                moduleStatus = "warning";
              }
            } else if (module.modname === "label") {
              labelsCount++;
              moduleDetails = "Catalogued course label block.";
            }

            // Generate content chunks for these module types
            let finalContent = stripHtml(content);

            // CRITICAL INTRINSICS FIX:
            // Force title inclusion as default to ensure element existence is perfectly indexable
            if (!finalContent && title) {
              finalContent = `This is the OCA Learn module: "${title}". View it directly on OCA Learn using the course link.`;
            }

            if (finalContent) {
              const textChunks = finalContent.match(/[\s\S]{1,1500}/g) || [];
              for (const text of textChunks) {
                // Formatting with context-structure so vector search is aware of the title
                const structuredText = `Course Section: ${sectionName}\nModule Name: ${title}\nType: ${module.modname}\nURL: ${moduleUrl}\n---\n${text}`;
                chunks.push({
                  unit: unitCode,
                  fileName: title,
                  text: structuredText,
                  url: moduleUrl
                });
                moduleChunks++;
              }
              if (!moduleDetails) {
                moduleDetails = `Generated ${moduleChunks} context chunks.`;
              }
            } else {
              moduleDetails = "No readable text content found to index.";
              moduleStatus = "warning";
            }

          } else if (module.modname === "book") {
            booksCount++;
            try {
              addLog("info", `Processing Book: "${module.name}" (CMID: ${module.id})`);
              
              if (module.contents && module.contents.length > 0) {
                const downloadPromises = module.contents.map(async (file: any) => {
                  const isTextFile = (file.filename && (
                                     file.filename.toLowerCase().endsWith(".html") || 
                                     file.filename.toLowerCase().endsWith(".htm") || 
                                     file.filename.toLowerCase().endsWith(".txt")
                                   )) || (file.mimetype && file.mimetype.startsWith("text/"));
                  
                  if (file.fileurl && isTextFile) {
                    try {
                      const downloadUrl = `${file.fileurl}${file.fileurl.includes("?") ? "&" : "?"}token=${token}&forcedownload=1`;
                      const fileRes = await fetch(downloadUrl);
                      if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
                      const html = await fileRes.text();
                      const cleanText = stripHtml(html);
                      if (cleanText) {
                        const textChunks = cleanText.match(/[\s\S]{1,1500}/g) || [];
                        const chapterTitle = file.content || file.filename.replace(".html", "");
                        return textChunks.map(text => ({
                          unit: unitCode,
                          fileName: `${module.name} - ${chapterTitle}`,
                          text: `Course Section: ${sectionName}\nBook Name: ${module.name}\nChapter: ${chapterTitle}\nURL: ${moduleUrl}\n---\n${text}`,
                          url: moduleUrl
                        }));
                      }
                    } catch (err: any) {
                      addLog("warning", `Error downloading chapter "${file.filename}" in book "${module.name}": ${err.message}`);
                    }
                  }
                  return [];
                });
                
                const results = await Promise.all(downloadPromises);
                let bookChunksAdded = 0;
                for (const chunkGroup of results) {
                  if (chunkGroup) {
                    chunks.push(...chunkGroup);
                    bookChunksAdded += chunkGroup.length;
                  }
                }
                moduleChunks = bookChunksAdded;
                moduleDetails = `Extracted ${bookChunksAdded} chunks across ${module.contents.length} chapters.`;
              } else {
                addLog("warning", `Book "${module.name}" (CMID: ${module.id}) contains zero downloadable chapters. Falling back to book description.`);
                const desc = stripHtml(module.description || "");
                if (desc) {
                  const textChunks = desc.match(/[\s\S]{1,1500}/g) || [];
                  for (const text of textChunks) {
                    chunks.push({
                      unit: unitCode,
                      fileName: module.name,
                      text: `Course Section: ${sectionName}\nBook Name: ${module.name}\nType: book\nURL: ${moduleUrl}\n---\n${text}`,
                      url: moduleUrl
                    });
                    moduleChunks++;
                  }
                  moduleDetails = `Zero chapters metadata. Extracted ${moduleChunks} chunks from description instead.`;
                } else {
                  moduleDetails = "No chapter files and description is completely empty.";
                  moduleStatus = "warning";
                }
              }
            } catch (e: any) {
              addLog("error", `Failed processing book module "${module.name}": ${e.message}`);
              moduleDetails = `Book error: ${e.message}`;
              moduleStatus = "error";
            }
          } else if (module.modname === "scorm") {
            scormsCount++;
            try {
              addLog("info", `Processing SCORM Package: "${module.name}"...`);
              const scormRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=mod_scorm_get_scorms_by_courses&moodlewsrestformat=json&courseids[0]=${courseId}`);
              const scorms = await scormRes.json();
              const scorm = scorms.scorms?.find((s: any) => s.course === courseId);
              if (scorm && scorm.packageurl) {
                const zipRes = await fetch(`${scorm.packageurl}&token=${token}`);
                const zipBuffer = await zipRes.arrayBuffer();
                const zip = new AdmZip(Buffer.from(zipBuffer));
                const indexEntry = zip.getEntries().find(e => e.entryName.endsWith("index.html"));
                if (indexEntry) {
                   const html = indexEntry.getData().toString("utf8");
                   const match = html.match(/deserialize\("([^"]+)"\)/);
                   if (match && match[1]) {
                     const jsonStr = Buffer.from(match[1], "base64").toString("utf8");
                     const data = JSON.parse(jsonStr);
                     if (data.course && data.course.lessons) {
                       for (const lesson of data.course.lessons) {
                         content += `\nLesson: ${lesson.title}\n`;
                         if (lesson.items) {
                           for (const item of lesson.items) {
                             if (item.items) {
                               for (const subItem of item.items) {
                                 content += (subItem.heading || "") + " " + (subItem.paragraph || "") + " " + (subItem.description || "") + "\n";
                               }
                             }
                           }
                         }
                       }
                     }
                   } else {
                     content = html;
                   }
                }
              }
              const scormContent = stripHtml(content);
              if (scormContent) {
                const textChunks = scormContent.match(/[\s\S]{1,1500}/g) || [];
                for (const text of textChunks) {
                  chunks.push({
                    unit: unitCode,
                    fileName: title,
                    text: `Course Section: ${sectionName}\nSCORM Module: ${title}\nURL: ${moduleUrl}\n---\n${text}`,
                    url: moduleUrl
                  });
                  moduleChunks++;
                }
                moduleDetails = `Extracted ${moduleChunks} SCORM lesson chunks successfully.`;
              } else {
                moduleDetails = "SCORM package extracted but contained no indexable text.";
                moduleStatus = "warning";
              }
            } catch (e: any) {
              addLog("error", `Failed processing SCORM package "${module.name}": ${e.message}`);
              moduleDetails = `SCORM error: ${e.message}`;
              moduleStatus = "error";
            }
          }

          addModuleLog(title || `Untitled (${module.modname})`, module.modname, moduleStatus, moduleChunks, moduleDetails);
        }
      }

      addLog("info", `Success! Catalogued ${chunks.length} chunks from ${modulesProcessed} total elements processed in this Moodle Course.`);

      res.json({ 
        courseId, 
        fullname: course.fullname, 
        chunksCount: chunks.length,
        chunks: chunks,
        stats: {
          sectionsCount: sections.length,
          modulesCount: modulesProcessed,
          assignmentsCount,
          pagesCount,
          booksCount,
          scormsCount,
          labelsCount
        },
        modulesLog,
        logs
      });
    } catch (error: any) {
      addLog("error", `Moodle catalogue fatal crash: ${error.message}`);
      console.error("Moodle catalogue error:", error);
      res.status(500).json({ error: "Failed to catalogue course", logs });
    }
  });

  app.post("/api/moodle/index", async (req, res) => {
    const { unitCode } = req.body;
    if (!unitCode || !unitCode.trim()) {
      return res.status(400).json({ error: "Unit Code is required." });
    }

    const formattedUnit = unitCode.trim();
    const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);

    try {
      console.log(`[Indexer] Starting Moodle indexing for unit: ${formattedUnit}`);
      
      // 1. Check if already successfully completed
      const querySnapshot = await firestore.collection("moodleUnits").where("unitCode", "==", formattedUnit).get();
      let unitDocRef;
      if (!querySnapshot.empty) {
        const docSnap = querySnapshot.docs[0];
        const currentData = docSnap.data();
        unitDocRef = docSnap.ref;
        if (currentData.status === "completed") {
          console.log(`[Indexer] Unit ${formattedUnit} is already indexed.`);
          return res.json({ status: "success", fullname: currentData.fullname, alreadyCompleted: true });
        }
      } else {
        unitDocRef = firestore.collection("moodleUnits").doc();
      }

      // Update unit status to cataloguing so other parts of the system are aware of it
      await unitDocRef.set({
        unitCode: formattedUnit,
        status: "cataloguing",
        cataloguedAt: FieldValue.serverTimestamp(),
        logs: [{ level: "info", message: "Starting backend moodle indexing job...", timestamp: new Date().toISOString() }]
      }, { merge: true });

      // 2. Fetch catalogue from localhost
      console.log(`[Indexer] Dispatched catalogue request to localhost:${PORT}`);
      const catalogueRes = await fetch(`http://127.0.0.1:${PORT}/api/moodle/catalogue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitCode: formattedUnit }),
      });

      const data = await catalogueRes.json();

      if (!catalogueRes.ok) {
        const errorMsg = data.error || "Failed to fetch course details from Moodle.";
        await unitDocRef.set({
          status: "error",
          errorDetail: errorMsg,
          logs: [{ level: "error", message: `Moodle Catalogue failed: ${errorMsg}`, timestamp: new Date().toISOString() }]
        }, { merge: true });
        return res.status(catalogueRes.status).json({ error: errorMsg });
      }

      console.log(`[Indexer] Moodle catalogued successfully. Received ${data.chunksCount} chunks.`);

      // 3. Purge existing chunks for this unit Code
      const chunksSnapshot = await firestore.collection("chunks").where("unit", "==", formattedUnit).get();
      if (!chunksSnapshot.empty) {
        console.log(`[Indexer] Purging ${chunksSnapshot.size} old chunks...`);
        let deleteBatch = firestore.batch();
        let delCount = 0;
        for (const doc of chunksSnapshot.docs) {
          deleteBatch.delete(doc.ref);
          delCount++;
          if (delCount === 500) {
            await deleteBatch.commit();
            deleteBatch = firestore.batch();
            delCount = 0;
          }
        }
        if (delCount > 0) {
          await deleteBatch.commit();
        }
      }

      // Helper function to get embedding with retry
      async function getEmbedding(text: string): Promise<number[]> {
        const activeApiKey = getApiKey();
        if (!activeApiKey) throw new Error("Gemini API key is missing on the server.");
        const modelName = "gemini-embedding-2-preview";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${activeApiKey}`;
        const response = await fetchWithRetry(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text }] },
            config: { outputDimensionality: 768 }
          })
        }) || await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text }] },
            config: { outputDimensionality: 768 }
          })
        });

        const embedData = await response.json();
        if (!response.ok) {
          throw new Error(embedData.error?.message || embedData.error || "Failed to get embedding");
        }
        if (embedData.embedding && embedData.embedding.values) {
          return embedData.embedding.values;
        }
        if (embedData.embeddings && embedData.embeddings[0] && embedData.embeddings[0].values) {
          return embedData.embeddings[0].values;
        }
        throw new Error("Unexpected embedding response format");
      }

      // 4. Generate embeddings for each chunk
      const chunkList = data.chunks || [];
      const CONCURRENCY_LIMIT = 10;
      const chunksWithEmbeddings: any[] = [];
      let failures = 0;

      for (let i = 0; i < chunkList.length; i += CONCURRENCY_LIMIT) {
        const batchSlice = chunkList.slice(i, i + CONCURRENCY_LIMIT);
        const promises = batchSlice.map(async (chunk: any) => {
          try {
            const embedding = await getEmbedding(chunk.text);
            return { ...chunk, embedding };
          } catch (err: any) {
            failures++;
            console.error(`[Indexer] Failed to generate embedding for ${chunk.fileName}:`, err?.message || err);
            return null;
          }
        });
        const batchResults = await Promise.all(promises);
        batchResults.forEach(r => {
          if (r) chunksWithEmbeddings.push(r);
        });
      }

      console.log(`[Indexer] Embeddings generation completed. Success: ${chunksWithEmbeddings.length}, Failures: ${failures}`);

      // 5. Bulk upload to chunks collection in firestore
      let batch = firestore.batch();
      let writeCount = 0;
      for (const chunk of chunksWithEmbeddings) {
        const newChunkRef = firestore.collection("chunks").doc();
        batch.set(newChunkRef, {
          unit: chunk.unit,
          fileName: chunk.fileName,
          text: chunk.text,
          url: chunk.url || null,
          persona: null,
          embedding: FieldValue.vector(chunk.embedding),
          indexedAt: FieldValue.serverTimestamp()
        });
        writeCount++;
        if (writeCount === 500) {
          await batch.commit();
          batch = firestore.batch();
          writeCount = 0;
        }
      }
      if (writeCount > 0) {
        await batch.commit();
      }

      // 6. Complete status
      const logs = [
        ...(data.logs || []),
        { level: "info", message: `Successfully generated ${chunksWithEmbeddings.length} embeddings on server.`, timestamp: new Date().toISOString() },
        { level: "info", message: "Server-side indexing process completed.", timestamp: new Date().toISOString() }
      ];

      await unitDocRef.set({
        unitCode: formattedUnit,
        courseId: data.courseId,
        fullname: data.fullname,
        status: "completed",
        cataloguedAt: FieldValue.serverTimestamp(),
        stats: data.stats || null,
        modulesLog: data.modulesLog || [],
        logs: logs,
        errorDetail: failures > 0 ? `Completed indexing, but with ${failures} embedding failures.` : null
      }, { merge: true });

      console.log(`[Indexer] Successfully in-memory indexed Course: ${data.fullname}`);
      res.json({
        status: "success",
        fullname: data.fullname,
        chunksCount: chunksWithEmbeddings.length,
        alreadyCompleted: false
      });

    } catch (error: any) {
      console.error("[Indexer] Indexing fatal error:", error);
      res.status(500).json({ error: error.message || "Failed to index unit course." });
    }
  });

  app.post("/api/moodle/diagnostic", async (req, res) => {
    const { unitCode } = req.body;
    const token = process.env.MOODLE_TOKEN;
    const baseUrl = "https://learn.oca.ac.uk/webservice/rest/server.php";
    
    const diag = { auth: false, lookup: false, contents: false, books: false, chapters: false, error: "" };

    if (!token) {
      diag.error = "Moodle token is missing from environment variables.";
      return res.json(diag);
    }

    try {
      const siteRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=core_web_service_get_site_info&moodlewsrestformat=json`);
      const siteData = await siteRes.json();
      if (siteData.exception) {
        diag.error = `Auth failed: ${siteData.message}`;
        return res.json(diag);
      }
      diag.auth = true;

      const courseRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=core_course_get_courses_by_field&moodlewsrestformat=json&field=idnumber&value=${encodeURIComponent(unitCode)}`);
      const courseData = await courseRes.json();
      if (courseData.exception || !courseData.courses || courseData.courses.length === 0) {
        diag.error = courseData.exception ? `Lookup failed: ${courseData.message}` : `Course "${unitCode}" not found.`;
        return res.json(diag);
      }
      diag.lookup = true;
      const courseId = courseData.courses[0].id;

      const contentsRes = await fetch(`${baseUrl}?wstoken=${token}&wsfunction=core_course_get_contents&moodlewsrestformat=json&courseid=${courseId}`);
      const contentsData = await contentsRes.json();
      if (contentsData.exception) {
        diag.error = `Content access failed: ${contentsData.message}`;
        return res.json(diag);
      }
      diag.contents = true;

      // Check for book content availability in the course contents
      const hasBooks = contentsData.some((s: any) => s.modules.some((m: any) => m.modname === "book"));
      if (hasBooks) {
        diag.books = true;
        const bookWithContent = contentsData.find((s: any) => 
          s.modules.find((m: any) => m.modname === "book" && m.contents && m.contents.length > 0)
        );
        if (bookWithContent) {
          diag.chapters = true;
        }
      } else {
        diag.books = true; // No books to check, so we're "ok"
        diag.chapters = true;
      }

      res.json(diag);
    } catch (error: any) {
      diag.error = error.message;
      res.json(diag);
    }
  });

  // GDrive API Proxy
  app.post("/api/drive/list", async (req, res) => {
    const { tokens, folderId } = req.body;
    const token = tokens?.access_token;
    
    console.log(`[DriveProxy] Listing files for folder ${folderId}. Token length: ${token?.length || 0}`);
    
    if (!token) {
      console.error("[DriveProxy] Missing access token");
      return res.status(400).json({ error: "Missing access token" });
    }

    try {
      if (!folderId) {
        throw new Error("Missing folderId in request");
      }

      // Using direct fetch for better debugging of auth headers
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed = false`)}&fields=${encodeURIComponent("files(id, name, mimeType)")}`;
      
      const driveRes = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });

      const data = await driveRes.json();

      if (!driveRes.ok) {
        console.error("[DriveProxy] Google Drive API Error:", JSON.stringify(data));
        return res.status(driveRes.status).json({
          error: "Google Drive API returned an error",
          details: data.error?.message || JSON.stringify(data),
          code: data.error?.code,
          status: driveRes.status
        });
      }

      console.log(`[DriveProxy] Successfully listed ${data.files?.length || 0} files`);
      res.json(data.files);
    } catch (error: any) {
      console.error("[DriveProxy] Drive list error:", error.message);
      res.status(500).json({ 
        error: "Failed to list files", 
        details: error.message,
        stack: error.stack
      });
    }
  });

  app.post("/api/drive/content", async (req, res) => {
    const { tokens, fileId } = req.body;
    const token = tokens?.access_token;
    
    console.log(`[DriveProxy] Fetching content for file ${fileId}`);

    if (!token) {
      return res.status(400).json({ error: "Missing access token" });
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: token });
    const drive = google.drive({ version: "v3", auth });
    try {
      // 1. Get file metadata to check MIME type
      const metadata = await drive.files.get({ fileId, fields: "name, mimeType" });
      const mimeType = metadata.data.mimeType;
      const fileName = metadata.data.name;

      console.log(`Fetching content for file: ${fileName} (${mimeType})`);

      if (mimeType === "application/vnd.google-apps.document") {
        // Google Doc - Export as plain text
        const response = await drive.files.export({
          fileId,
          mimeType: "text/plain",
        });
        return res.send(response.data);
      } else if (mimeType === "application/pdf") {
        // Robust PDF Handling using Gemini 1.5 Flash for text extraction
        const driveResponse = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" }
        );
        
        try {
          const pdfBuffer = Buffer.from(driveResponse.data as ArrayBuffer);
          const activeApiKey = getApiKey();
          if (!activeApiKey) throw new Error("API Key missing for PDF extraction");

          // Use Gemini Flash (fast & efficient for OCR/text extraction)
          const ai = new GoogleGenAI({ apiKey: activeApiKey });
          const geminiResponse = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [
              {
                inlineData: {
                  data: pdfBuffer.toString("base64"),
                  mimeType: "application/pdf"
                }
              },
              "Extract all text content from this PDF. Output only the extracted text content. Do not describe the document."
            ]
          });
          
          const text = geminiResponse.text;
          if (!text) throw new Error("No text content returned from Gemini during PDF extraction");
          
          console.log(`[DriveProxy] Successfully extracted ${text.length} chars from PDF: ${fileName}`);
          return res.send(text);
        } catch (pdfErr: any) {
          console.error(`[DriveProxy] PDF Extraction failed for ${fileName}:`, pdfErr.message);
          res.status(500).json({ error: "PDF_EXTRACTION_FAILED", details: pdfErr.message });
          return;
        }
      } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        // docx - Download and parse
        const response = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" }
        );
        const data = await mammoth.extractRawText({ buffer: Buffer.from(response.data as ArrayBuffer) });
        return res.send(data.value);
      } else {
        // Fallback for other text-based files
        const response = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "text" }
        );
        return res.send(response.data);
      }
    } catch (error: any) {
      console.error("[DriveProxy] Content error detail:", error.message);
      res.status(error.response?.status || 500).json({ 
        error: "Failed to get file content", 
        details: error.message,
        googleError: error.response?.data || null,
        stack: error.stack
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
