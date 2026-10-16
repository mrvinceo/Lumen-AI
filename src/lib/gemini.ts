import { Type, FunctionDeclaration } from "@google/genai";

// Helper for logging
function addLog(msg: string) {
  console.log(`[GeminiService] ${msg}`);
}

export const searchKnowledgeBaseFunction: FunctionDeclaration = {
  name: "searchKnowledgeBase",
  description: "Search the Open College of the Arts (OCA) knowledge base. Use this for ANY questions about policies, course units, student guidance, or college procedures. This tool performs a vector search across indexed documents.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: "The specific search query. Be descriptive to get better vector matches.",
      },
      unit: {
        type: Type.STRING,
        description: "The course unit code (e.g., 'PH4APH0925') to filter results. If the user is asking about a specific unit, you MUST provide this.",
      },
    },
    required: ["query"],
  },
};

export const getEmbeddings = async (text: string) => {
  const res = await fetch("/api/gemini/embedContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-embedding-2-preview",
      content: {
        parts: [{ text }]
      },
      config: {
        outputDimensionality: 768
      }
    })
  });
  
  const data = await res.json();
  
  if (!res.ok) {
    console.error("Embedding Error Diagnostics:", data);
    throw new Error(`${data.error?.message || data.error || "Failed to get embeddings"}${data.diagnostics ? `\nDiagnostics: ${data.diagnostics}` : ""}`);
  }
  
  if (data.embedding && data.embedding.values) {
    return data.embedding.values;
  }
  
  if (data.embeddings && data.embeddings[0] && data.embeddings[0].values) {
    return data.embeddings[0].values;
  }

  throw new Error("Unexpected embedding response format");
};

export const getMultimodalFeedback = async (prompt: string, files: { data: string; mimeType: string }[], customSystemInstruction?: string, personaId?: string) => {
  addLog(`Processing ${files.length} files via server proxy...`);
  
  const res = await fetch("/api/gemini/generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { text: customSystemInstruction || `You are a creative arts tutor at the Open College of the Arts. Provide constructive, critical feedback on the following media files. ${prompt}` },
          ...files.map(file => ({ 
            inlineData: { 
              data: file.data, 
              mimeType: file.mimeType 
            } 
          })),
        ],
      },
      personaId
    })
  });

  const data = await res.json();
  
  if (!res.ok) {
    console.error("Multimodal Error Diagnostics:", data);
    throw new Error(`${data.error?.message || data.error || "Failed to generate multimodal feedback"}${data.diagnostics ? `\nDiagnostics: ${data.diagnostics}` : ""}`);
  }

  // Extract text safely
  const candidate = data.candidates?.[0];
  if (candidate?.content?.parts?.[0]?.text) {
    return candidate.content.parts[0].text;
  }
  return "I couldn't generate a response. Please try again.";
};

export const chatWithLumen = async (messages: any[], unit?: string, personaId?: string) => {
  const res = await fetch("/api/gemini/generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-3-flash-preview",
      contents: messages,
      personaId,
      config: {
        systemInstruction: `You are 'Lumen', a helpful and encouraging chatbot for the Open College of the Arts (OCA). 
        Your goal is to assist students and staff with questions about policies, guidance, and course units.
        
        CRITICAL: When a user asks a question, you MUST use the 'searchKnowledgeBase' tool if the answer requires specific OCA knowledge.
        
        If you are provided with "Context from knowledge base", you MUST use that information to answer the question. 
        Do not say you can't find information if context is provided. If the context is relevant, summarize it clearly.
        
        IMPORTANT: If the search returns NO results, do NOT make up an answer based on your internal knowledge for course-specific details (like project titles or exercise content). Instead, admit you don't have that specific information.
        
        ${unit ? `You are currently assisting a student in the course unit: ${unit}. Always prioritize information related to this unit.` : ""}
        
        CITATION RULE: If a source in the context has a URL, you SHOULD include that URL in your response when citing that information, so the user can read more. Format citations like: "[Source Name](URL)".
        
        CONCISENESS & SUCCINCTNESS GUIDELINE:
        - Provide concise, succinct answers that directly address the user's question without unnecessary filler, repetitive preambles, or long-winded commentary.
        - Summarize information cleanly while retaining all necessary detail, facts, policies, and practical steps.
        - Structure information using short paragraphs, concise bullet points, or numbered steps so the student can grasp the answer quickly.
        - When a persona is active, speak in that persona's distinctive voice while still keeping responses succinct, direct, and focused.
        
        If you truly cannot find the information after searching, politely inform the user and suggest they contact student services.
        Always maintain a professional yet creative, supportive, and concise tone.`,
        tools: [{ functionDeclarations: [searchKnowledgeBaseFunction] }],
      },
    })
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("Chat Error Diagnostics:", data);
    throw new Error(`${data.error?.message || data.error || "Failed to chat with Lumen"}${data.diagnostics ? `\nDiagnostics: ${data.diagnostics}` : ""}`);
  }

  // Reconstruct a response object-like structure that the caller expects
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  
  const text = parts.find((p: any) => p.text)?.text || "";
  const functionCalls = parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall);

  return {
    text,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined
  };
};

export const generateSessionTitle = async (firstPrompt: string, firstResponse: string) => {
  try {
    const res = await fetch("/api/gemini/generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [{
              text: `Generate a short, concise, and professional 2-4 word title for a chat session starting with this question and answer. Do not use quotes, match-styles, or punctuation. Just return the clean title.
              
              Question: ${firstPrompt}
              
              Answer: ${firstResponse}`
            }]
          }
        ]
      })
    });
    
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return text.replace(/["']/g, "").trim();
    }
  } catch (err) {
    console.error("Failed to generate session title:", err);
  }
  return null;
};

