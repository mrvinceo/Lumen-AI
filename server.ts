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
import fs from "fs";
import crypto from "crypto";
import { 
  parseDocumentBuffer, 
  getDocumentAiConfig, 
  saveDocumentAiConfig,
  createSemanticChunks 
} from "./server/documentAiService";

dotenv.config();

// Load firebase-applet-config.json securely in both ESM and CJS modes
let firebaseConfig: any = {};
try {
  const configFileContent = fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8");
  firebaseConfig = JSON.parse(configFileContent);
} catch (err) {
  console.warn("Failed to load firebase-applet-config.json:", err);
}

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

// Helper to extract non-standard Moodle/WordPress installation subpaths (e.g. "testmoodle")
function extractSubpath(urlStr: string): string {
  if (!urlStr) return "";
  try {
    const url = new URL(urlStr);
    if (url.hostname === "learn.oca.ac.uk" || url.hostname === "www.oca.ac.uk") {
      const parts = url.pathname.split("/").filter(Boolean);
      const standardFolders = [
        "mod", "course", "admin", "lib", "webservice", "user", 
        "grade", "theme", "local", "auth", "login", "blocks", 
        "wp-content", "wp-includes", "uploads"
      ];
      if (parts.length > 0 && !standardFolders.includes(parts[0])) {
        return parts[0];
      }
    }
  } catch (e) {
    // Ignore invalid URLs
  }
  return "";
}

// Helper to extract the public domain, respecting reverse proxies and defaulting correctly for OCA production
function getPublicHost(req: any): string {
  let host = req.headers["x-forwarded-host"] || req.headers["host"] || req.get("host") || "";
  
  if (typeof host === "string") {
    if (host.includes(",")) {
      host = host.split(",")[0].trim();
    }
  }

  const hostname = String(host).toLowerCase();

  // If we find localhost / local container addresses, check if referrer is OCA, override to lumen.oca.ac.uk
  if (!hostname || hostname.includes("localhost") || hostname.includes("127.0.0.1") || hostname.includes("3000")) {
    const referer = safeString(req.headers.referer || "");
    if (referer.includes("oca.ac.uk") || referer.includes("moodle")) {
      return "lumen.oca.ac.uk";
    }
    return "lumen.oca.ac.uk";
  }

  return host;
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

const PRIVATE_KEY_PATH = path.join(process.cwd(), "lti_private_key.pem");
const PUBLIC_KEY_PATH = path.join(process.cwd(), "lti_public_key.pem");

let privateKeyPem = "";
let publicKeyPem = "";

function initializeKeys() {
  try {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
      privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
      publicKeyPem = fs.readFileSync(PUBLIC_KEY_PATH, "utf8");
      console.log("Loaded existing LTI RSA keypair from disk.");
    } else {
      console.log("Generating new LTI RSA keypair...");
      const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: "spki",
          format: "pem"
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem"
        }
      });
      privateKeyPem = privateKey;
      publicKeyPem = publicKey;
      fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, "utf8");
      fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, "utf8");
      console.log("Generated and saved new LTI RSA keypair.");
    }
  } catch (error) {
    console.error("Failed to initialize LTI keys:", error);
  }
}

function safeString(val: any, defaultVal = ""): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) {
    return safeString(val[0], defaultVal);
  }
  return defaultVal;
}

async function startServer() {
  // Initialize LTI keys on startup
  initializeKeys();

  const app = express();
  app.set("trust proxy", true);
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(cookieParser());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // Allow staff Electron app (file:// / localhost) to call Gemini + auth APIs
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // LTI 1.3 OIDC Login Initiation (Initiate Login Endpoint)
  app.all("/lti/login", (req, res) => {
    const iss = safeString(req.query.iss || req.body.iss);
    const loginHint = safeString(req.query.login_hint || req.body.login_hint);
    const targetLinkUri = safeString(req.query.target_link_uri || req.body.target_link_uri);
    const ltiMessageHint = safeString(req.query.lti_message_hint || req.body.lti_message_hint);
    const clientId = safeString(req.query.client_id || req.body.client_id, "RvtKZccySaXWK8j");

    if (!iss || !loginHint) {
      console.warn("LTI 1.3 OIDC Login Initiation request is missing parameters:", { iss, loginHint });
      return res.status(400).send("Missing required OIDC login initiation parameters (iss, login_hint).");
    }

    // Determine LMS's OIDC Auth redirect endpoint dynamically from the issuer URL
    let baseIssuerUrl = iss;
    let detectedSubpath = "";
    const referer = safeString(req.headers.referer || "");

    // 1. Check direct query/body params
    const qSub = req.query.moodle_sub || req.body.moodle_sub;
    if (qSub) {
      detectedSubpath = safeString(qSub);
    }

    // 2. Extract from targetLinkUri
    if (!detectedSubpath && targetLinkUri) {
      try {
        const parsedTarget = new URL(targetLinkUri);
        const tSub = parsedTarget.searchParams.get("moodle_sub") || parsedTarget.searchParams.get("activity_sub");
        if (tSub) {
          detectedSubpath = tSub;
        }
      } catch (err) {
        // ignore url parsing errors
      }
    }

    // 3. Fallback: inspect referer header using extractSubpath
    if (!detectedSubpath && referer) {
      detectedSubpath = extractSubpath(referer);
    }

    // 4. Secure fallback: if Client ID is the known test Moodle Client ID, assume testmoodle
    if (!detectedSubpath && clientId === "RvtKZccySaXWK8j") {
      detectedSubpath = "testmoodle";
    }

    // Apply the detected subpath to issuer url if not already present
    if (baseIssuerUrl.includes("learn.oca.ac.uk") && detectedSubpath && !baseIssuerUrl.includes(detectedSubpath)) {
      baseIssuerUrl = baseIssuerUrl.endsWith("/") 
        ? `${baseIssuerUrl}${detectedSubpath}` 
        : `${baseIssuerUrl}/${detectedSubpath}`;
      console.log(`LTI Login: Dynamically appended detected subfold /${detectedSubpath} to Issuer Url:`, baseIssuerUrl);
    }

    let authEndpoint = baseIssuerUrl.endsWith("/") ? `${baseIssuerUrl}mod/lti/auth.php` : `${baseIssuerUrl}/mod/lti/auth.php`;

    // Construct a clean redirect_uri without query parameters. Moodle is extremely strict:
    // the redirect_uri passed to auth.php MUST exactly match the configured Redirect URI on the platform settings.
    let cleanRedirectUri = `https://${getPublicHost(req)}/lti/launch`;
    let activityIdFromTarget = "";

    if (targetLinkUri) {
      try {
        const parsedUrl = new URL(targetLinkUri);
        let resolvedHost = parsedUrl.host;
        if (resolvedHost.includes("localhost") || resolvedHost.includes("127.0.0.1") || resolvedHost.includes("3000")) {
          resolvedHost = getPublicHost(req);
        }
        cleanRedirectUri = `${parsedUrl.protocol}//${resolvedHost}${parsedUrl.pathname}`;
        const activityParam = parsedUrl.searchParams.get("activity");
        if (activityParam) {
          activityIdFromTarget = activityParam;
        }
      } catch (err) {
        console.warn("Failed to parse targetLinkUri for clean redirectUri/activity:", err);
      }
    }

    // Preserve the activity identifier and detected subpath in the state parameter
    const randomSuffix = Math.random().toString(36).substring(2, 10);
    let stateVal = "";
    if (detectedSubpath) {
      stateVal = activityIdFromTarget
        ? `sub_${detectedSubpath}_act_${activityIdFromTarget}_${randomSuffix}`
        : `sub_${detectedSubpath}_state_${randomSuffix}`;
    } else {
      stateVal = activityIdFromTarget
        ? `act_${activityIdFromTarget}_${randomSuffix}`
        : safeString(req.query.state || req.body.state, `state_${randomSuffix}`);
    }

    // Construct Moodle LTI 1.3 OIDC authorize parameters
    const redirectParams = new URLSearchParams({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: clientId,
      redirect_uri: cleanRedirectUri,
      login_hint: loginHint,
      state: stateVal,
      nonce: Math.random().toString(36).substring(2, 15)
    });

    if (ltiMessageHint) {
      redirectParams.append("lti_message_hint", ltiMessageHint);
    }

    const redirectUrl = `${authEndpoint}?${redirectParams.toString()}`;
    console.log("Redirecting LTI login handshake to clean URL:", redirectUrl);
    res.redirect(redirectUrl);
  });

  // LTI 1.3 Keyset URL (JWKS endpoint)
  app.get("/lti/keyset", (req, res) => {
    try {
      if (!publicKeyPem) {
        initializeKeys();
      }
      const publicKey = crypto.createPublicKey(publicKeyPem);
      const jwk = publicKey.export({ format: "jwk" });
      
      const jwks = {
        keys: [
          {
            kid: "lumen-lti-key-1",
            use: "sig",
            alg: "RS256",
            kty: "RSA",
            ...jwk
          }
        ]
      };
      res.setHeader("Content-Type", "application/json");
      res.json(jwks);
    } catch (err: any) {
      console.error("JWKS keyset export failed:", err);
      res.status(500).send("Internal server error: " + err.message);
    }
  });

  // LTI 1.3 Deep Linking JWT Generator (Signs selected content items via RSA-SHA256)
  app.post("/api/lti/deep-link-jwt", (req, res) => {
    try {
      const { activityId, activityName, activityDesc, idToken, iss, clientId, ltiData, deploymentId, moodle_sub } = req.body;
      
      if (!activityId || !activityName) {
        return res.status(400).json({ error: "Missing required selection parameters." });
      }

      let client_id = safeString(clientId, "RvtKZccySaXWK8j"); // Default Client ID
      let aud = safeString(iss, "https://learn.oca.ac.uk"); // Standard Moodle production issuer
      let ltiDataVal: any = ltiData;
      let deployment_id = safeString(deploymentId);

      let dlSub = "";

      if (idToken) {
        try {
          const parts = idToken.split(".");
          if (parts.length >= 2) {
            const payloadStr = Buffer.from(parts[1], "base64").toString("utf8");
            const payload = JSON.parse(payloadStr);
            
            if (payload.iss) {
              aud = payload.iss;
            }
            if (payload.aud) {
              client_id = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
            }
            if (payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"]) {
              deployment_id = safeString(payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"]);
            }
            
            let returnUrlStr = "";
            if (payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"]) {
              const dlSettings = payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"];
              if (dlSettings.data) {
                ltiDataVal = dlSettings.data;
              }
              if (dlSettings.deep_link_return_url) {
                returnUrlStr = dlSettings.deep_link_return_url;
              }
            }

            dlSub = extractSubpath(returnUrlStr) || extractSubpath(payload.iss) || extractSubpath(JSON.stringify(payload));
          }
        } catch (tokenErr) {
          console.warn("Could not parse target launch token for signing request:", tokenErr);
        }
      }

      if (!dlSub && moodle_sub) {
        dlSub = safeString(moodle_sub);
      }
      if (!dlSub) {
        dlSub = extractSubpath(req.headers.referer || "");
      }
      if (!dlSub && client_id === "RvtKZccySaXWK8j") {
        dlSub = "testmoodle";
      }

      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + 300; // 5 minutes expiration

      const payload: any = {
        iss: client_id,
        aud: aud,
        iat: iat,
        exp: exp,
        nonce: Math.random().toString(36).substring(2, 15),
        "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse",
        "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
        "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deployment_id,
        "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": [
          {
            type: "ltiResourceLink",
            title: activityName,
            text: activityDesc || "",
            url: dlSub 
              ? `https://${getPublicHost(req)}/lti/launch?activity=${activityId}&moodle_sub=${dlSub}`
              : `https://${getPublicHost(req)}/lti/launch?activity=${activityId}`,
            custom: dlSub ? {
              activity: activityId,
              moodle_sub: dlSub
            } : {
              activity: activityId
            },
            iframe: {
              width: 800,
              height: 600
            }
          }
        ]
      };

      if (ltiDataVal !== undefined && ltiDataVal !== "") {
        let finalLtiData = ltiDataVal;
        if (typeof ltiDataVal === "string") {
          try {
            finalLtiData = JSON.parse(ltiDataVal);
          } catch (e) {
            finalLtiData = ltiDataVal;
          }
        }
        payload["https://purl.imsglobal.org/spec/lti-dl/claim/data"] = finalLtiData;
      }

      const header = {
        alg: "RS256",
        typ: "JWT",
        kid: "lumen-lti-key-1"
      };

      if (!privateKeyPem) {
        initializeKeys();
      }

      const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signInput = `${headerB64}.${payloadB64}`;

      const signer = crypto.createSign("RSA-SHA256");
      signer.update(signInput);
      const signatureB64 = signer.sign(privateKeyPem, "base64url");

      const jwt = `${signInput}.${signatureB64}`;

      res.json({ jwt });
    } catch (e: any) {
      console.error("Deep linking JWT signing failed:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // LTI 1.3 Deep Linking Launch Endpoints
  app.post("/lti/launch", async (req, res) => {
    const idToken = safeString(req.body?.id_token);
    const state = safeString(req.body?.state);

    // 1. Try to extract activity and subpath from state parameter
    let stateActivity = "";
    let stateSubpath = "";
    if (state.startsWith("sub_")) {
      const parts = state.split("_");
      stateSubpath = parts[1];
      const actIdx = parts.indexOf("act");
      if (actIdx !== -1 && actIdx + 1 < parts.length) {
        stateActivity = parts[actIdx + 1];
      }
    } else if (state.startsWith("act_")) {
      const parts = state.split("_");
      if (parts.length >= 2) {
        stateActivity = parts[1];
      }
    }

    // 2. Try to extract activity standard/custom parameters from query/body
    let reqActivity = safeString(req.query.activity || req.body?.activity);

    // 3. Try to extract activity from inside the JWT payload's custom LTI claims
    let tokenActivity = "";
    let tokenMoodleSub = "";
    let deepLinkReturnUrl = "";
    let decodedIss = "";
    let decodedClientId = "";
    let decodedLtiData = "";
    let decodedDeploymentId = "";
    let extractedSubpath = "";

    if (idToken) {
      try {
        const parts = idToken.split(".");
        if (parts.length >= 2) {
          const payloadStr = Buffer.from(parts[1], "base64").toString("utf8");
          const payload = JSON.parse(payloadStr);
          
          if (payload.iss) {
            decodedIss = payload.iss;
          }
          if (payload.aud) {
            decodedClientId = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
          }
          if (payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"]) {
            decodedDeploymentId = safeString(payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"]);
          }

          // Pull out LTI Custom Claims
          const customClaims = payload["https://purl.imsglobal.org/spec/lti/claim/custom"];
          if (customClaims) {
            if (customClaims.activity) {
              tokenActivity = safeString(customClaims.activity);
            }
            if (customClaims.moodle_sub) {
              tokenMoodleSub = safeString(customClaims.moodle_sub);
            }
          }

          // Pull out Deep Linking return URL if available
          const dlSettings = payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"];
          if (dlSettings) {
            if (dlSettings.deep_link_return_url) {
              deepLinkReturnUrl = safeString(dlSettings.deep_link_return_url);
            }
            if (dlSettings.data) {
              decodedLtiData = typeof dlSettings.data === "string" ? dlSettings.data : JSON.stringify(dlSettings.data);
            }
          }

          // Search the entire payload for a Moodle subpath using extractSubpath as fallback
          if (deepLinkReturnUrl) {
            extractedSubpath = extractSubpath(deepLinkReturnUrl);
          }
          if (!extractedSubpath) {
            extractedSubpath = extractSubpath(JSON.stringify(payload));
          }

          // 4. Try to authenticate or link the Moodle user with Firestore/Firebase Auth
          try {
            const email = safeString(payload.email);
            const name = safeString(payload.name || payload.given_name || "LTI User");
            const moodleSub = safeString(payload.sub);

            let firebaseUid = "";

            if (email) {
              try {
                // Find existing user by email
                const userRecord = await admin.auth().getUserByEmail(email);
                firebaseUid = userRecord.uid;
                console.log(`LTI Launch: Found existing Firebase user ${firebaseUid} for email ${email}`);
              } catch (authErr: any) {
                if (authErr.code === "auth/user-not-found") {
                  // Create a new user for this email so they map to the same account later
                  const newUser = await admin.auth().createUser({
                    email,
                    emailVerified: true,
                    displayName: name,
                  });
                  firebaseUid = newUser.uid;
                  console.log(`LTI Launch: Created new Firebase user ${firebaseUid} for email ${email}`);
                } else {
                  console.error("LTI Launch: Error seeking user by email:", authErr);
                }
              }
            } else if (moodleSub) {
              // Fallback using sub
              const subUid = `lti_${moodleSub}`;
              try {
                const userRecord = await admin.auth().getUser(subUid);
                firebaseUid = userRecord.uid;
                console.log(`LTI Launch: Found existing LTI-sub user ${firebaseUid}`);
              } catch (authErr: any) {
                if (authErr.code === "auth/user-not-found") {
                  const newUser = await admin.auth().createUser({
                    uid: subUid,
                    displayName: name,
                  });
                  firebaseUid = newUser.uid;
                  console.log(`LTI Launch: Created new LTI-sub user ${firebaseUid}`);
                } else {
                  console.error("LTI Launch: Error seeking user by sub:", authErr);
                }
              }
            }

            if (firebaseUid) {
              // Set the lumen_uid cookie so the client syncs session
              const host = getPublicHost(req) || "";
              const cookieOptions: any = {
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                httpOnly: true,
                secure: true,
                sameSite: "none", // Required for iframe context
              };
              if (host.includes("oca.ac.uk")) {
                cookieOptions.domain = ".oca.ac.uk";
              }
              res.cookie("lumen_uid", firebaseUid, cookieOptions);
              console.log(`LTI Launch: Set lumen_uid cookie for Firebase user ${firebaseUid}`);
            }
          } catch (firebaseAuthErr) {
            console.error("LTI Launch: Failed to provision or sync Firebase user:", firebaseAuthErr);
          }
        }
      } catch (err) {
        console.warn("LTI ID Token decode failed:", err);
      }
    }

    // Determine the ultimate specific activity target
    const targetActivity = reqActivity || stateActivity || tokenActivity;
    const finalSubpath = stateSubpath || tokenMoodleSub || extractedSubpath;

    console.log("LTI Launch POST request received:", {
      reqActivity,
      stateActivity,
      tokenActivity,
      targetActivity,
      finalSubpath,
      hasIdToken: !!idToken,
      state
    });

    if (targetActivity) {
      console.log(`Redirecting LTI launch to specific activity layout: /activity/${targetActivity}`);
      let destUrl = `/activity/${targetActivity}?state=${encodeURIComponent(state)}`;
      if (finalSubpath) {
        destUrl += `&moodle_sub=${encodeURIComponent(finalSubpath)}`;
      }
      return res.redirect(destUrl);
    }

    if (!deepLinkReturnUrl && req.body?.deep_link_return_url) {
      deepLinkReturnUrl = safeString(req.body.deep_link_return_url);
    }

    if (!deepLinkReturnUrl) {
      deepLinkReturnUrl = "https://learn.oca.ac.uk/mod/lti/contentitem.php";
    }

    let selectParams = `?return_url=${encodeURIComponent(deepLinkReturnUrl)}` +
      `&state=${encodeURIComponent(state)}` +
      `&iss=${encodeURIComponent(decodedIss)}` +
      `&client_id=${encodeURIComponent(decodedClientId)}` +
      `&lti_data=${encodeURIComponent(decodedLtiData)}` +
      `&deployment_id=${encodeURIComponent(decodedDeploymentId)}`;

    if (finalSubpath) {
      selectParams += `&moodle_sub=${encodeURIComponent(finalSubpath)}`;
    }

    const redirectUrl = `/lti/select` + selectParams;

    console.log("Redirecting LTI select to clean URL:", redirectUrl);
    res.redirect(redirectUrl);
  });

  app.get("/lti/launch", (req, res) => {
    const state = safeString(req.query.state);
    
    // Try to extract activity and subpath from state parameter
    let stateActivity = "";
    let stateSubpath = "";
    if (state.startsWith("sub_")) {
      const parts = state.split("_");
      stateSubpath = parts[1];
      const actIdx = parts.indexOf("act");
      if (actIdx !== -1 && actIdx + 1 < parts.length) {
        stateActivity = parts[actIdx + 1];
      }
    } else if (state.startsWith("act_")) {
      const parts = state.split("_");
      if (parts.length >= 2) {
        stateActivity = parts[1];
      }
    }

    const querySub = safeString(req.query.moodle_sub || stateSubpath);
    const targetActivity = safeString(req.query.activity || stateActivity);

    console.log("LTI Launch GET request received:", {
      reqActivity: req.query.activity,
      stateActivity,
      targetActivity,
      state,
      querySub
    });

    if (targetActivity) {
      let destUrl = `/activity/${targetActivity}?state=${encodeURIComponent(state)}`;
      if (querySub) {
        destUrl += `&moodle_sub=${encodeURIComponent(querySub)}`;
      }
      return res.redirect(destUrl);
    }

    const deepLinkReturnUrl = safeString(req.query.deep_link_return_url, "https://learn.oca.ac.uk/mod/lti/contentitem.php");
    let selectUrl = `/lti/select?return_url=${encodeURIComponent(deepLinkReturnUrl)}&state=${encodeURIComponent(state)}`;
    if (querySub) {
      selectUrl += `&moodle_sub=${encodeURIComponent(querySub)}`;
    }
    res.redirect(selectUrl);
  });

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
      const host = getPublicHost(req) || "";
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

      let email: string | undefined = undefined;
      let emailVerified: boolean | undefined = undefined;
      try {
        const userRecord = await admin.auth().getUser(uid);
        email = userRecord.email;
        emailVerified = userRecord.emailVerified;
      } catch (userErr) {
        console.warn("Could not retrieve user record during session sync:", userErr);
      }

      const additionalClaims: any = {};
      if (email) {
        additionalClaims.email = email;
      }
      if (emailVerified !== undefined) {
        additionalClaims.email_verified = emailVerified;
      }

      // Generate a client custom token to sync the Firebase Client Auth SDK in iframes/embeds
      let customToken = "";
      try {
        customToken = await admin.auth().createCustomToken(uid, additionalClaims);
      } catch (tokenErr: any) {
        console.warn("Could not sign custom token for client SDK sync (expected in sandbox environments without signBlob permissions):", tokenErr.message);
      }
      res.json({ uid, customToken });
    } catch (err: any) {
      console.error("Failed to generate Custom Token for session sync:", err);
      res.status(500).json({ error: err.message || "Failed to generate session token." });
    }
  });

  // Secure endpoints to proxy Firestore activities queries for embeds & LTI launch
  app.get("/api/activities", async (req, res) => {
    try {
      const uid = req.cookies.lumen_uid;
      if (!uid) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
      const snapshot = await firestore.collection("activities").orderBy("createdAt", "desc").get();
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      res.json(list);
    } catch (err: any) {
      console.error("Failed to list activities:", err);
      res.status(500).json({ error: err.message || "Failed to load activities." });
    }
  });

  app.get("/api/activities/:id", async (req, res) => {
    try {
      const uid = req.cookies.lumen_uid;
      if (!uid) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { id } = req.params;
      const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
      const docSnap = await firestore.collection("activities").doc(id).get();
      if (!docSnap.exists) {
        return res.status(404).json({ error: "Activity not found" });
      }
      res.json({ id: docSnap.id, ...docSnap.data() });
    } catch (err: any) {
      console.error(`Failed to load activity details for ${req.params.id}:`, err);
      res.status(500).json({ error: err.message || "Failed to load activity details." });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const host = getPublicHost(req) || "";
    const cookieOptions: any = {};
    if (host.includes("oca.ac.uk")) {
      cookieOptions.domain = ".oca.ac.uk";
    }
    res.clearCookie("lumen_uid", cookieOptions);
    res.json({ status: "success" });
  });

  // --- Staff desktop: Google SSO domain + Groups → custom claims ---

  function getBootstrapAdminEmails(): string[] {
    const raw = process.env.BOOTSTRAP_ADMIN_EMAILS || "paulvincent@oca.ac.uk";
    return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  }

  function loadWorkspaceAuthClient() {
    const adminEmail = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL;
    if (!adminEmail) {
      throw new Error("GOOGLE_WORKSPACE_ADMIN_EMAIL is not configured");
    }

    let credentials: any = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_PATH) {
      credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH, "utf8"));
    } else {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_PATH is required for Groups checks");
    }

    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/admin.directory.group.member.readonly"],
      subject: adminEmail,
    });
    return auth;
  }

  async function isGroupMember(groupEmail: string, memberEmail: string): Promise<boolean> {
    if (!groupEmail) return false;
    try {
      const auth = loadWorkspaceAuthClient();
      const directory = google.admin({ version: "directory_v1", auth });
      const res = await directory.members.hasMember({
        groupKey: groupEmail,
        memberKey: memberEmail,
      });
      return !!res.data?.isMember;
    } catch (err: any) {
      // 404 = not a member
      if (err?.code === 404 || err?.response?.status === 404) return false;
      console.warn(`Group membership check failed for ${memberEmail} in ${groupEmail}:`, err?.message || err);
      return false;
    }
  }

  async function resolveStaffClaims(email: string): Promise<{ staff: boolean; admin: boolean }> {
    const normalized = email.toLowerCase();
    const bootstrapAdmins = getBootstrapAdminEmails();
    let admin = bootstrapAdmins.includes(normalized);
    let staff = admin;

    const staffGroup = process.env.STAFF_GROUP_EMAIL || "";
    const adminGroup = process.env.ADMIN_GROUP_EMAIL || "";

    if (staffGroup || adminGroup) {
      try {
        if (staffGroup && !staff) {
          staff = await isGroupMember(staffGroup, normalized);
        }
        if (adminGroup && !admin) {
          admin = await isGroupMember(adminGroup, normalized);
          if (admin) staff = true;
        }
      } catch (err: any) {
        console.warn("Groups resolution unavailable, falling back to bootstrap admins only:", err?.message || err);
      }
    }

    // Dev / misconfig safety: if no groups configured, any @oca.ac.uk user is treated as staff
    // (still blocked from admin unless bootstrap). Prefer configuring STAFF_GROUP_EMAIL in production.
    if (!staffGroup && !admin && normalized.endsWith("@oca.ac.uk")) {
      staff = true;
    }

    return { staff, admin };
  }

  function isRequestAdmin(decoded: admin.auth.DecodedIdToken): boolean {
    const email = (decoded.email || "").toLowerCase();
    return (
      decoded.admin === true ||
      getBootstrapAdminEmails().includes(email) ||
      decoded.uid === "ZqpJke7dXaXj4aKsBdLycqIiXgK2"
    );
  }

  /**
   * POST /api/auth/staff-session
   * Body: { idToken }
   * Verifies Google SSO, enforces @oca.ac.uk, checks Groups, sets custom claims.
   */
  app.post("/api/auth/staff-session", async (req, res) => {
    try {
      const { idToken } = req.body;
      if (!idToken) return res.status(400).json({ error: "Missing idToken" });

      const decoded = await admin.auth().verifyIdToken(idToken);
      const email = (decoded.email || "").toLowerCase();
      if (!email || !email.endsWith("@oca.ac.uk")) {
        return res.status(403).json({ error: "Access restricted to @oca.ac.uk accounts" });
      }

      const claims = await resolveStaffClaims(email);
      if (!claims.staff) {
        return res.status(403).json({
          error: "Your account is not in the staff allowlist. Contact IT if you need access.",
        });
      }

      await admin.auth().setCustomUserClaims(decoded.uid, {
        staff: claims.staff,
        admin: claims.admin,
      });

      const customToken = await admin.auth().createCustomToken(decoded.uid, {
        staff: claims.staff,
        admin: claims.admin,
        email,
      });

      res.json({
        status: "success",
        uid: decoded.uid,
        email,
        staff: claims.staff,
        admin: claims.admin,
        customToken,
      });
    } catch (error: any) {
      console.error("Staff session error:", error);
      res.status(401).json({ error: error.message || "Invalid token" });
    }
  });

  /**
   * POST /api/admin/backfill-audience
   * Sets audience=all on folders/chunks missing the field (Admin SDK).
   */
  app.post("/api/admin/backfill-audience", async (req, res) => {
    try {
      const authHeader = req.headers.authorization || "";
      const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.body?.idToken;
      if (!idToken) return res.status(401).json({ error: "Missing Authorization bearer token" });

      const decoded = await admin.auth().verifyIdToken(idToken);
      if (!isRequestAdmin(decoded)) {
        return res.status(403).json({ error: "Admin only" });
      }

      const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
      let foldersUpdated = 0;
      let chunksUpdated = 0;

      const foldersSnap = await firestore.collection("folders").get();
      let batch = firestore.batch();
      let ops = 0;
      for (const docSnap of foldersSnap.docs) {
        const data = docSnap.data();
        if (data.audience !== "staff" && data.audience !== "all") {
          batch.update(docSnap.ref, { audience: "all" });
          foldersUpdated++;
          ops++;
          if (ops === 400) {
            await batch.commit();
            batch = firestore.batch();
            ops = 0;
          }
        }
      }
      if (ops > 0) await batch.commit();

      batch = firestore.batch();
      ops = 0;
      const chunksSnap = await firestore.collection("chunks").get();
      for (const docSnap of chunksSnap.docs) {
        const data = docSnap.data();
        if (data.audience !== "staff" && data.audience !== "all") {
          batch.update(docSnap.ref, { audience: "all" });
          chunksUpdated++;
          ops++;
          if (ops === 400) {
            await batch.commit();
            batch = firestore.batch();
            ops = 0;
          }
        }
      }
      if (ops > 0) await batch.commit();

      res.json({ status: "success", foldersUpdated, chunksUpdated });
    } catch (error: any) {
      console.error("Backfill audience error:", error);
      res.status(500).json({ error: error.message || "Backfill failed" });
    }
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

      const { model, contents, config, personaId, activityId } = req.body;
      const modelName = model || "gemini-2.0-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeApiKey}`;

      // Handle Activity and Persona integration
      let additionalInstruction = "";
      let activitySystemPrompt = "";
      let allowedPersonaIds: string[] = [];
      let activityName = "Activity";

      if (activityId) {
        try {
          const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
          const activityDoc = await firestore.collection('activities').doc(activityId).get();
          if (activityDoc.exists) {
            const actData = activityDoc.data();
            activitySystemPrompt = actData?.systemPrompt || "";
            allowedPersonaIds = actData?.personaIds || [];
            activityName = actData?.name || "Activity";
            console.log(`Activity identified: ${activityName}`);
          }
        } catch (err) {
          console.error("Failed to fetch activity data:", err);
        }
      }

      const activePersonaId = personaId || (allowedPersonaIds.length > 0 ? allowedPersonaIds[0] : null);

      if (activePersonaId) {
        try {
          const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
          const personaDoc = await firestore.collection('personas').doc(activePersonaId).get();
          if (personaDoc.exists) {
            const personaData = personaDoc.data();
            // The activity systemPrompt overrides whatever has been inputted for the Persona
            additionalInstruction = activitySystemPrompt || personaData?.system_prompt || "";
            console.log(`Applying persona inside activity/standard: ${personaData?.display_name}`);
          }
        } catch (err) {
          console.error("Failed to fetch persona data:", err);
        }
      } else if (activitySystemPrompt) {
        // If there's no active persona, but there is an activity-level system prompt
        additionalInstruction = activitySystemPrompt;
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

          # RESPONSE STYLE & CONCISENESS:
          - Deliver all responses, answers, insights, and guidance in a concise and succinct manner.
          - Summarize thoughts, advice, and facts directly with sufficient depth and clarity, without unnecessary filler or rambling.
          - Stay completely true to your persona's distinctive personality, tone, and perspective while keeping replies focused and digestible.

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

      // Automatically save conversation in embedded/iframe active activities to User History
      const uid = req.cookies.lumen_uid;
      if (uid) {
        try {
          const userParts = contents?.filter((c: any) => c.role === "user") || [];
          const lastUserMsg = userParts[userParts.length - 1];
          const userText = lastUserMsg?.parts?.[0]?.text;
          const modelText = data.candidates?.[0]?.content?.parts?.[0]?.text;

          if (userText && modelText) {
            const firestore = getFirestore(firebaseConfig.firestoreDatabaseId);
            const currentSessionId = activityId ? `activity_${activityId}` : "default";

            const userDocData = {
              userId: uid,
              sessionId: currentSessionId,
              role: "user",
              parts: [{ text: userText }],
              createdAt: FieldValue.serverTimestamp(),
              unit: activityId ? `${activityName}` : "global"
            };

            const modelDocData = {
              userId: uid,
              sessionId: currentSessionId,
              role: "model",
              parts: [{ text: modelText }],
              createdAt: FieldValue.serverTimestamp(),
              unit: activityId ? `${activityName}` : "global"
            };

            await firestore.collection("chat_history").add(userDocData);
            await firestore.collection("chat_history").add(modelDocData);
            console.log(`Successfully saved activity message turn to chat_history for user: ${uid}`);
          }
        } catch (saveErr) {
          console.error("Failed to automatically save activity conversation to user chat_history:", saveErr);
        }
      }

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
          audience: "all",
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

  // Document AI Status and Configuration API
  app.get("/api/document-ai/status", async (req, res) => {
    try {
      const config = await getDocumentAiConfig();
      const isConfigured = Boolean(config.processorId && config.processorId.trim().length > 0);
      res.json({
        success: true,
        configured: isConfigured,
        processorId: config.processorId || "",
        location: config.location || "us",
        projectId: config.projectId || "gen-lang-client-0701859835",
        enableDocumentAi: config.enableDocumentAi ?? true,
        activeBackend: isConfigured && config.enableDocumentAi !== false ? "document_ai_layout_parser" : "gemini_layout_parser",
        supportedFeatures: [
          "Layout-Aware PDF Parsing",
          "Markdown Table Reconstruction",
          "Hierarchical Ancestor Heading Chunking",
          "Semantic Section Segmentation",
          "Multi-column Reading Order Correction"
        ]
      });
    } catch (err: any) {
      console.error("[DocumentAI] Status check error:", err);
      res.status(500).json({ error: "Failed to retrieve Document AI status", details: err.message });
    }
  });

  app.post("/api/document-ai/config", async (req, res) => {
    try {
      const { processorId, location, projectId, enableDocumentAi } = req.body;
      const updatedConfig = await saveDocumentAiConfig({
        processorId,
        location,
        projectId,
        enableDocumentAi
      });
      
      res.json({ 
        success: true, 
        message: "Document AI configuration updated successfully",
        config: updatedConfig 
      });
    } catch (err: any) {
      console.error("[DocumentAI] Failed to save config:", err);
      res.status(500).json({ error: "Failed to save Document AI configuration", details: err.message });
    }
  });

  app.post("/api/document-ai/test-parse", async (req, res) => {
    try {
      const { base64Pdf, sampleText } = req.body;
      const activeApiKey = getApiKey();

      if (base64Pdf) {
        const pdfBuffer = Buffer.from(base64Pdf, "base64");
        const parseResult = await parseDocumentBuffer(pdfBuffer, activeApiKey);
        return res.json(parseResult);
      }

      if (sampleText) {
        // Run contextual semantic chunker on sample text
        const chunks = createSemanticChunks(sampleText, 1000);
        return res.json({
          success: true,
          parserUsed: "contextual_semantic_chunker",
          chunks,
          fullText: sampleText,
          chunksCount: chunks.length
        });
      }

      return res.status(400).json({ error: "Please provide either base64Pdf or sampleText to test." });
    } catch (err: any) {
      console.error("[DocumentAI] Test parse error:", err);
      res.status(500).json({ error: "Document parse test failed", details: err.message });
    }
  });

  app.post("/api/drive/content", async (req, res) => {
    const { tokens, fileId, returnChunks } = req.body;
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
        const docText = String(response.data || "");
        if (returnChunks) {
          const chunks = createSemanticChunks(docText, 1200);
          return res.json({
            success: true,
            fileName,
            mimeType,
            parserUsed: "google_docs_semantic_chunker",
            chunks,
            text: docText
          });
        }
        return res.send(docText);
      } else if (mimeType === "application/pdf") {
        // High-fidelity Layout Parsing (Document AI with Gemini layout understanding fallback)
        const driveResponse = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" }
        );
        
        try {
          const pdfBuffer = Buffer.from(driveResponse.data as ArrayBuffer);
          const activeApiKey = getApiKey();
          
          const parseResult = await parseDocumentBuffer(pdfBuffer, activeApiKey);
          
          console.log(`[DriveProxy] Layout parser (${parseResult.parserUsed}) generated ${parseResult.chunks.length} contextual chunks for ${fileName}`);
          
          if (returnChunks) {
            return res.json({
              success: true,
              fileName,
              mimeType,
              parserUsed: parseResult.parserUsed,
              chunks: parseResult.chunks,
              text: parseResult.fullText,
              stats: {
                pagesCount: parseResult.pagesCount,
                tablesDetected: parseResult.tablesDetected,
                chunksCount: parseResult.chunks.length
              }
            });
          }

          // Backwards-compatible text response
          return res.send(parseResult.fullText);
        } catch (pdfErr: any) {
          console.error(`[DriveProxy] PDF Layout Extraction failed for ${fileName}:`, pdfErr.message);
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
        const docxText = data.value || "";
        if (returnChunks) {
          const chunks = createSemanticChunks(docxText, 1200);
          return res.json({
            success: true,
            fileName,
            mimeType,
            parserUsed: "mammoth_docx_semantic_chunker",
            chunks,
            text: docxText
          });
        }
        return res.send(docxText);
      } else {
        // Fallback for other text-based files
        const response = await drive.files.get(
          { fileId, alt: "media" },
          { responseType: "text" }
        );
        const rawText = String(response.data || "");
        if (returnChunks) {
          const chunks = createSemanticChunks(rawText, 1200);
          return res.json({
            success: true,
            fileName,
            mimeType,
            parserUsed: "plain_text_semantic_chunker",
            chunks,
            text: rawText
          });
        }
        return res.send(rawText);
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
