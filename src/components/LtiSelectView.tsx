import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { Loader2, GraduationCap, Check, ArrowRight } from "lucide-react";
import { OCALogo } from "./BrandAssets";

interface Activity {
  id: string;
  name: string;
  description?: string;
  personaIds: string[];
}

export default function LtiSelectView() {
  const [searchParams] = useSearchParams();
  const returnUrl = searchParams.get("return_url") || "https://learn.oca.ac.uk/mod/lti/contentitem.php";
  const state = searchParams.get("state") || "";
  const token = searchParams.get("token") || "";
  const iss = searchParams.get("iss") || "";
  const clientId = searchParams.get("client_id") || "";
  const ltiData = searchParams.get("lti_data") || "";
  const deploymentId = searchParams.get("deployment_id") || "";
  
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);
  const [signedJwt, setSignedJwt] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (signedJwt && formRef.current) {
      formRef.current.submit();
    }
  }, [signedJwt]);

  useEffect(() => {
    async function loadActivities() {
      try {
        let loadedItems: Activity[] = [];
        
        // Try to fetch via secure server-side proxy
        try {
          const res = await fetch("/api/activities");
          if (res.ok) {
            loadedItems = await res.json();
            console.log("Activities list loaded successfully via secure server-side proxy.");
          } else {
            console.warn(`Proxy fetch for activities list returned status ${res.status}, falling back to direct Firestore query.`);
          }
        } catch (proxyErr) {
          console.warn("Proxy activities list fetch threw an error, trying direct Firestore fallback:", proxyErr);
        }

        // Direct client Firestore fallback if proxy wasn't successful or returned empty
        if (loadedItems.length === 0) {
          const q = query(collection(db, "activities"), orderBy("createdAt", "desc"));
          const snap = await getDocs(q);
          loadedItems = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Activity));
        }

        setActivities(loadedItems);
      } catch (err) {
        console.error("Error loading activities for selection:", err);
      } finally {
        setLoading(false);
      }
    }
    loadActivities();
  }, []);

  const handleSelect = (activity: Activity) => {
    setSelectedActivity(activity);
    setSignedJwt(null); // Reset signature if changing activity
  };

  const handleSubmitOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signing || !selectedActivity) return;
    setSigning(true);
    try {
      const res = await fetch("/api/lti/deep-link-jwt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activityId: selectedActivity.id,
          activityName: selectedActivity.name,
          activityDesc: selectedActivity.description || "",
          idToken: token,
          iss,
          clientId,
          ltiData,
          deploymentId,
          moodle_sub: searchParams.get("moodle_sub") || ""
        })
      });
      const data = await res.json();
      if (data.jwt) {
        setSignedJwt(data.jwt);
      } else {
        alert("Failed to generate selection token: " + (data.error || "Unknown server error"));
        setSigning(false);
      }
    } catch (err: any) {
      alert("Error preparing selection: " + err.message);
      setSigning(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="animate-spin text-oca-blue mx-auto" size={40} />
          <p className="text-sm font-bold uppercase tracking-wider text-gray-400">Loading Course Activities...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50/70 text-oca-blue font-sans select-none flex flex-col">
      {/* Visual Header */}
      <nav className="max-w-7xl mx-auto w-full px-6 py-6 md:py-8 flex items-center justify-between border-b border-gray-155 bg-white">
        <OCALogo />
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse"></span>
          <span className="text-[10px] font-black uppercase tracking-wider text-gray-500">Moodle LTI 1.3 Session</span>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto w-full px-6 py-10 flex-grow flex flex-col justify-center">
        <div className="text-center max-w-lg mx-auto mb-10">
          <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 border-2 border-indigo-100">
            <GraduationCap size={24} />
          </div>
          <h2 className="text-2xl font-black uppercase tracking-tight">VLE LTI Deep Linking Selection</h2>
          <p className="text-xs text-gray-500 font-medium leading-relaxed mt-2">
            Select one of the interactive Lumen AI Activities to embed directly into your course unit page inside the Moodle Virtual Learning Environment.
          </p>
        </div>

        {selectedActivity ? (
          <div className="bg-white rounded-[2rem] border-2 border-oca-blue p-8 shadow-xl text-center space-y-6">
            <div className="w-12 h-12 bg-green-50 text-green-600 rounded-full flex items-center justify-center mx-auto border border-green-200">
              <Check size={24} />
            </div>
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Selected Activity</span>
              <h3 className="text-xl font-bold tracking-tight text-gray-900 mt-1">{selectedActivity.name}</h3>
              {selectedActivity.description && (
                <p className="text-xs text-gray-500 mt-1">{selectedActivity.description}</p>
              )}
            </div>

            {/* Form submission back to LMS/VLE return URL */}
            <form 
              ref={formRef}
              onSubmit={handleSubmitOverride}
              action={returnUrl} 
              method="POST" 
              className="space-y-4"
            >
              <input type="hidden" name="state" value={state} />
              <input type="hidden" name="JWT" value={signedJwt || ""} />

              <div className="p-4 bg-gray-50 rounded-xl border border-gray-150 max-w-sm mx-auto text-left space-y-1.5 font-mono text-[10px] text-gray-400">
                <div className="flex justify-between">
                  <span>Moodle Return:</span>
                  <span className="truncate max-w-[200px]" title={returnUrl}>{returnUrl}</span>
                </div>
                <div className="flex justify-between">
                  <span>State Match:</span>
                  <span className="truncate max-w-[200px]" title={state}>{state || "none"}</span>
                </div>
                {signing && (
                  <div className="flex justify-between text-indigo-600 font-bold">
                    <span>Status:</span>
                    <span>{signedJwt ? "Redirecting..." : "Signing with LTI keys..."}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={signing}
                  onClick={() => setSelectedActivity(null)}
                  className="px-6 py-3 bg-gray-100 text-gray-600 font-black uppercase text-xs tracking-wider rounded-xl hover:bg-gray-200 transition-all cursor-pointer disabled:opacity-50"
                >
                  Change
                </button>
                <button
                  type="submit"
                  disabled={signing}
                  className="px-6 py-3 bg-oca-blue text-white font-black uppercase text-xs tracking-wider rounded-xl hover:bg-oca-verdigris transition-all flex items-center gap-2 shadow-lg cursor-pointer disabled:opacity-50"
                >
                  {signing ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Inserting Activity...
                    </>
                  ) : (
                    <>
                      Insert in Course VLE
                      <ArrowRight size={14} />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            {activities.length === 0 ? (
              <div className="bg-white p-12 text-center rounded-[2rem] border-2 border-gray-100 shadow-sm text-gray-400 text-sm font-medium">
                No interactive activities configured yet. Please configure activities through the Admin panel dashboard first!
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {activities.map(activity => (
                  <div 
                    key={activity.id}
                    className="p-6 bg-white rounded-[2rem] border-2 border-gray-100 hover:border-oca-blue hover:shadow-xl transition-all flex flex-col justify-between text-left"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-bold text-gray-900 text-sm">{activity.name}</h4>
                        <div className="p-1 px-2.5 bg-indigo-50 border border-indigo-100 rounded-full text-[9px] font-black text-indigo-600 uppercase tracking-tight">
                          AI Act
                        </div>
                      </div>
                      {activity.description && (
                        <p className="text-xs text-gray-400 mt-2 max-w-xs">{activity.description}</p>
                      )}
                    </div>
                    
                    <button
                      onClick={() => handleSelect(activity)}
                      className="mt-6 w-full py-2.5 bg-gray-50 hover:bg-oca-blue hover:text-white rounded-xl text-xs font-black uppercase tracking-widest border border-gray-200 transition-all text-center cursor-pointer"
                    >
                      Pick this Activity
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
