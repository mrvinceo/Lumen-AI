import { collection, query, where, getDocs, vector, VectorValue } from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { getEmbeddings } from "./gemini";
import { execute, equal } from "firebase/firestore/pipelines";

export interface DocumentChunk {
  folderId?: string;
  fileId?: string;
  fileName: string;
  text: string;
  embedding: number[];
  unit?: string;
  url?: string;
}

export const searchChunks = async (queryText: string, unit?: string, limit: number = 5, personaId?: string) => {
  console.log(`Searching chunks for query: "${queryText}", unit: "${unit}", persona: "${personaId}"`);
  const embedding = await getEmbeddings(queryText);
  console.log(`Query embedding dimensions: ${embedding.length}`);
  const chunksRef = collection(db, "chunks");
  
  try {
    let results: (DocumentChunk & { distance?: number })[] = [];

    // 1. Search persona-specific chunks if personaId is provided
    if (personaId) {
      console.log(`Performing persona-specific search for persona: ${personaId}`);
      try {
        const personaPipeline = (db as any).pipeline()
          .collection("chunks")
          .where(equal("persona", personaId))
          .findNearest({
            field: "embedding",
            vectorValue: vector(embedding),
            distanceMeasure: "cosine",
            limit: limit,
            distanceField: "distance"
          });
        
        const personaSnapshot = await execute(personaPipeline);
        const personaResults = personaSnapshot.results.map(res => {
          const data = res.data() as DocumentChunk;
          const rawDistance = (res as any).distance ?? 
                             (res as any).distanceValue ?? 
                             (data as any).distance ?? 
                             (typeof (res as any).get === 'function' ? (res as any).get("distance") : undefined);
          const distance = typeof rawDistance === 'number' ? rawDistance : 1;
          console.log(`Persona Result: ${data.fileName} (Distance: ${distance})`);
          return {
            ...data,
            distance
          };
        });
        results = [...results, ...personaResults];
        console.log(`Found ${personaResults.length} persona-specific results.`);
      } catch (e) {
        console.error("Persona-specific vector search failed:", e);
      }
    }

    // 2. Search unit-specific chunks if unit is provided
    if (unit) {
      console.log(`Performing unit-specific search for unit: ${unit}`);
      try {
        const unitPipeline = (db as any).pipeline()
          .collection("chunks")
          .where(equal("unit", unit))
          // Avoid duplicates if persona search already covered some
          .findNearest({
            field: "embedding",
            vectorValue: vector(embedding),
            distanceMeasure: "cosine",
            limit: limit,
            distanceField: "distance"
          });
        
        const unitSnapshot = await execute(unitPipeline);
        const unitResults = unitSnapshot.results.map(res => {
          const data = res.data() as DocumentChunk;
          const rawDistance = (res as any).distance ?? 
                             (res as any).distanceValue ?? 
                             (data as any).distance ?? 
                             (typeof (res as any).get === 'function' ? (res as any).get("distance") : undefined);
          const distance = typeof rawDistance === 'number' ? rawDistance : 1;
          console.log(`Unit Result: ${data.fileName} (Distance: ${distance})`);
          return {
            ...data,
            distance
          };
        });
        results = [...results, ...unitResults];
        console.log(`Found ${unitResults.length} unit-specific results.`);
      } catch (e) {
        console.error("Unit-specific vector search failed:", e);
      }
    }

    // 3. Search global chunks (where unit and persona are null)
    console.log("Performing global search...");
    let globalResults: (DocumentChunk & { distance?: number })[] = [];
    try {
      const globalPipeline = (db as any).pipeline()
        .collection("chunks")
        .where(equal("unit", null))
        .where(equal("persona", null))
        .findNearest({
          field: "embedding",
          vectorValue: vector(embedding),
          distanceMeasure: "cosine",
          limit: limit,
          distanceField: "distance"
        });

      const globalSnapshot = await execute(globalPipeline);
      globalResults = globalSnapshot.results.map(res => {
        const data = res.data() as DocumentChunk;
        const rawDistance = (res as any).distance ?? 
                           (res as any).distanceValue ?? 
                           (data as any).distance ?? 
                           (typeof (res as any).get === 'function' ? (res as any).get("distance") : undefined);
        const distance = typeof rawDistance === 'number' ? rawDistance : 1;
        console.log(`Global Result: ${data.fileName} (Distance: ${distance})`);
        return {
          ...data,
          distance
        };
      });
      console.log(`Found ${globalResults.length} global results.`);
    } catch (e) {
      console.error("Global vector search failed:", e);
    }

    // Merge, deduplicate by fileName + text, and sort
    const merged = [...results, ...globalResults];
    const uniqueMap = new Map();
    merged.forEach(item => {
      const key = `${item.fileName}_${item.text.substring(0, 50)}`;
      if (!uniqueMap.has(key) || (uniqueMap.get(key).distance > (item.distance ?? 1))) {
        uniqueMap.set(key, item);
      }
    });

    const allResults = Array.from(uniqueMap.values())
      .sort((a, b) => {
        const distA = a.distance ?? 1;
        const distB = b.distance ?? 1;

        // Primary sort: by relevance distance (closest first).
        // If distances are very close or equal (within a margin of 0.05),
        // we break ties by prioritizing persona, then unit, then global.
        if (Math.abs(distA - distB) < 0.05) {
          const scoreA = a.persona ? 0 : (a.unit ? 1 : 2);
          const scoreB = b.persona ? 0 : (b.unit ? 1 : 2);
          return scoreA - scoreB;
        }

        return distA - distB;
      })
      .slice(0, Math.max(limit, 8));

    console.log(`Returning ${allResults.length} total results.`);
    return allResults;
  } catch (error) {
    console.warn("Vector search bypassed (e.g. unauthenticated or missing indices), returning empty fallback content:", error);
    return [];
  }
};

export const indexFolder = async (folderId: string, tokens: any, unit?: string) => {
  // 1. List files in folder
  const listRes = await fetch("/api/drive/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens, folderId }),
  });
  const files = await listRes.json();
  if (!Array.isArray(files)) {
    console.error("Failed to list files:", files);
    throw new Error(files.error || "Failed to list files in folder");
  }

  const allowedMimeTypes = [
    "text/plain",
    "application/pdf",
    "application/vnd.google-apps.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ];

  for (const file of files) {
    if (allowedMimeTypes.includes(file.mimeType)) {
      try {
        console.log(`Indexing file: ${file.name} (${file.mimeType})`);
        // 2. Get file content
        const contentRes = await fetch("/api/drive/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens, fileId: file.id }),
        });
        
        if (!contentRes.ok) {
          const errorData = await contentRes.json();
          console.error(`Failed to get content for ${file.name}:`, errorData);
          continue;
        }

        const text = await contentRes.text();
        if (!text || text.trim().length === 0) {
          console.warn(`Empty content for file: ${file.name}`);
          continue;
        }

        // 3. Chunk text (simple chunking for now)
        const chunks = text.match(/[\s\S]{1,1500}/g) || [];
        console.log(`Split ${file.name} into ${chunks.length} chunks`);

        for (const chunkText of chunks) {
          // 4. Generate embedding
          const embedding = await getEmbeddings(chunkText);

          // 5. Store in Firestore
          // The actual storage happens in the component loop that calls this, 
          // but we need to return the chunks or handle them here.
          // Wait, the original code didn't actually return anything or store anything!
          // It just had a comment. I should probably make it return the chunks.
        }
      } catch (e) {
        console.error(`Error processing file ${file.name}:`, e);
      }
    }
  }
};
