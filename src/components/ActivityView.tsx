import React, { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { Loader2, Send, Bot, User, Sparkles, X } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface Activity {
  id: string;
  name: string;
  description?: string;
  personaIds: string[];
  systemPrompt?: string;
}

interface Message {
  id: string;
  role: "user" | "model";
  text: string;
}

export default function ActivityView() {
  const { activityId } = useParams<{ activityId: string }>();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadActivity() {
      if (!activityId) return;
      try {
        let actData: any = null;
        
        // Try fetching via secure proxy API first
        try {
          const res = await fetch(`/api/activities/${activityId}`);
          if (res.ok) {
            actData = await res.json();
            console.log("Activity loaded successfully via secure server-side proxy.");
          } else {
            console.warn(`Proxy fetch returned status ${res.status}, falling back to direct Firestore.`);
          }
        } catch (proxyErr) {
          console.warn("Proxy fetch threw an error, trying direct Firestore fallback:", proxyErr);
        }

        // Fallback to direct client-side Firestore SDK
        if (!actData) {
          const docRef = doc(db, "activities", activityId);
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            actData = { id: docSnap.id, ...docSnap.data() };
          }
        }

        if (actData) {
          setActivity(actData as Activity);
          // Insert a friendly greeting message
          setMessages([
            {
              id: "greeting",
              role: "model",
              text: `Welcome to this Interactive Activity!\nI will assist you today with the topic: **${actData.name}**.\n\nHow can I help you get started?`
            }
          ]);
        } else {
          setErrorMessage("This interactive activity was not found or has been removed.");
        }
      } catch (err) {
        console.error("Failed to load activity details:", err);
        setErrorMessage("Could not load activity details. Verify you are authenticated.");
      } finally {
        setLoadingActivity(false);
      }
    }

    loadActivity();
  }, [activityId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isGenerating]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isGenerating || !activityId) return;

    const userQuery = inputText.trim();
    setInputText("");

    // Add user message to state
    const newUserMsg: Message = {
      id: Math.random().toString(36).substring(7),
      role: "user",
      text: userQuery
    };
    
    const updatedMessages = [...messages, newUserMsg];
    setMessages(updatedMessages);
    setIsGenerating(true);

    try {
      // Map message history to Gemini contents API format
      const apiContents = updatedMessages
        .filter(m => m.id !== "greeting")
        .map(m => ({
          role: m.role,
          parts: [{ text: m.text }]
        }));

      const res = await fetch("/api/gemini/generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3-flash-preview",
          contents: apiContents,
          activityId: activityId
        })
      });

      if (!res.ok) {
        throw new Error("Lumen generation failed");
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";

      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          role: "model",
          text: text
        }
      ]);
    } catch (err) {
      console.error("Error communicating with Lumen activity:", err);
      setMessages(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          role: "model",
          text: "I encountered an error generating a response. Please check your network and try again."
        }
      ]);
    } finally {
      setIsGenerating(false);
    }
  };

  if (loadingActivity) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <Loader2 className="animate-spin text-oca-blue mx-auto" size={40} />
          <p className="text-sm text-gray-500 font-bold uppercase tracking-wider">Loading Lumen Interactive Activity...</p>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6 text-center text-oca-blue">
        <div className="max-w-md bg-white p-8 rounded-[2.5rem] border-2 border-gray-100 shadow-sm">
          <p className="text-red-500 font-bold mb-4">{errorMessage}</p>
          <Link to="/" className="px-6 py-2 bg-oca-blue text-white rounded-xl font-bold uppercase text-xs tracking-wider">
            Go Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50/75 text-oca-blue font-sans selection:bg-oca-blue-tint selection:text-oca-blue flex flex-col">
      {/* Top Header Row representing the Activity */}
      <header className="bg-white border-b border-gray-150 px-6 py-4 md:py-5 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
            <Sparkles size={20} />
          </div>
          <div className="text-left">
            <h1 className="text-sm md:text-base font-black uppercase tracking-tight">{activity?.name}</h1>
            {activity?.description && (
              <p className="text-[10px] md:text-xs text-gray-400 font-medium truncate max-w-[200px] sm:max-w-md">{activity.description}</p>
            )}
          </div>
        </div>
        <div className="text-[9px] md:text-[10px] bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full font-mono font-bold select-none">
          Embedded Activity
        </div>
      </header>

      {/* Messages Transcript Scroll Area */}
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-6 md:py-8 max-w-3xl mx-auto w-full space-y-6 pb-28">
        {messages.map((msg) => {
          const isModel = msg.role === "model";
          return (
            <div 
              key={msg.id}
              className={`flex gap-3 md:gap-4 ${isModel ? "justify-start" : "justify-end"}`}
            >
              {isModel && (
                <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100 flex-shrink-0 self-start mt-1">
                  <Bot size={16} />
                </div>
              )}
              
              <div className={`max-w-[85%] rounded-[1.5rem] px-5 py-4 shadow-sm border text-left ${
                isModel 
                  ? "bg-white text-gray-800 border-gray-100" 
                  : "bg-oca-blue text-white border-transparent"
              }`}>
                <div className="markdown-body text-sm leading-relaxed whitespace-pre-wrap font-medium">
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                </div>
              </div>

              {!isModel && (
                <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-150 flex-shrink-0 self-start mt-1">
                  <User size={16} />
                </div>
              )}
            </div>
          );
        })}

        {isGenerating && (
          <div className="flex gap-4 justify-start">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-650 flex items-center justify-center border border-gray-100 flex-shrink-0 mt-1">
              <Bot size={16} className="animate-pulse" />
            </div>
            <div className="bg-white rounded-[1.5rem] px-5 py-4 border border-gray-100 shadow-sm flex items-center gap-2">
              <Loader2 className="animate-spin text-oca-blue" size={16} />
              <span className="text-xs text-gray-400 font-bold tracking-wide animate-none">Lumen is drafting response...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Embedded Input Bar pinned at bottom */}
      <footer className="fixed bottom-0 left-0 right-0 py-4 bg-gradient-to-t from-gray-50 via-gray-50/95 to-transparent border-t border-transparent sticky">
        <div className="max-w-3xl mx-auto px-4 md:px-6">
          <form 
            onSubmit={handleSendMessage}
            className="bg-white rounded-2xl border-2 border-oca-blue shadow-lg flex items-center overflow-hidden p-2 gap-2"
          >
            <input 
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type your reply here..."
              disabled={isGenerating}
              className="flex-1 bg-transparent py-3 px-3 md:px-4 outline-none border-none text-sm text-gray-800 font-medium placeholder-gray-400"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || isGenerating}
              className="w-10 h-10 md:w-12 md:h-12 bg-oca-blue hover:bg-oca-verdigris text-white flex items-center justify-center rounded-xl transition-all disabled:opacity-40 flex-shrink-0 cursor-pointer"
            >
              <Send size={18} />
            </button>
          </form>
          <div className="text-[10px] text-center text-gray-400 mt-2 font-bold select-none">
            Powered by Open College of the Arts • Lumen AI
          </div>
        </div>
      </footer>
    </div>
  );
}
