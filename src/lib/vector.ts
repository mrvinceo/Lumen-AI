import { vector } from "firebase/firestore";
import { db } from "../firebase";
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
  persona?: string;
  audience?: "all" | "staff";
  distance?: number;
}

type AudienceFilter = "all" | "staff";

function mapPipelineResults(snapshot: any): (DocumentChunk & { distance?: number })[] {
  return snapshot.results.map((res: any) => {
    const data = res.data() as DocumentChunk;
    const rawDistance =
      res.distance ??
      res.distanceValue ??
      (data as any).distance ??
      (typeof res.get === "function" ? res.get("distance") : undefined);
    const distance = typeof rawDistance === "number" ? rawDistance : 1;
    return { ...data, distance };
  });
}

async function runNearestSearch(
  embedding: number[],
  limit: number,
  filters: { field: string; value: unknown }[],
  label: string
): Promise<(DocumentChunk & { distance?: number })[]> {
  try {
    let pipeline = (db as any).pipeline().collection("chunks");
    for (const f of filters) {
      pipeline = pipeline.where(equal(f.field, f.value));
    }
    pipeline = pipeline.findNearest({
      field: "embedding",
      vectorValue: vector(embedding),
      distanceMeasure: "cosine",
      limit,
      distanceField: "distance",
    });
    const snapshot = await execute(pipeline);
    const results = mapPipelineResults(snapshot);
    console.log(`Found ${results.length} ${label} results.`);
    return results;
  } catch (e) {
    console.error(`${label} vector search failed:`, e);
    return [];
  }
}

function mergeAndRank(
  results: (DocumentChunk & { distance?: number })[],
  limit: number
): (DocumentChunk & { distance?: number })[] {
  const uniqueMap = new Map<string, DocumentChunk & { distance?: number }>();
  results.forEach((item) => {
    const key = `${item.fileName}_${item.text.substring(0, 50)}`;
    if (!uniqueMap.has(key) || (uniqueMap.get(key)!.distance! > (item.distance ?? 1))) {
      uniqueMap.set(key, item);
    }
  });

  return Array.from(uniqueMap.values())
    .sort((a, b) => {
      const distA = a.distance ?? 1;
      const distB = b.distance ?? 1;
      if (Math.abs(distA - distB) < 0.05) {
        const scoreA = a.persona ? 0 : a.unit ? 1 : 2;
        const scoreB = b.persona ? 0 : b.unit ? 1 : 2;
        return scoreA - scoreB;
      }
      return distA - distB;
    })
    .slice(0, Math.max(limit, 8));
}

/**
 * Student / public Lumen search — only audience == "all".
 */
export const searchChunks = async (
  queryText: string,
  unit?: string,
  limit: number = 5,
  personaId?: string
) => {
  console.log(`Searching chunks for query: "${queryText}", unit: "${unit}", persona: "${personaId}", audience: all`);
  const embedding = await getEmbeddings(queryText);
  console.log(`Query embedding dimensions: ${embedding.length}`);

  try {
    let results: (DocumentChunk & { distance?: number })[] = [];
    const audience: AudienceFilter = "all";

    if (personaId) {
      results = [
        ...results,
        ...(await runNearestSearch(
          embedding,
          limit,
          [
            { field: "audience", value: audience },
            { field: "persona", value: personaId },
          ],
          "persona-specific"
        )),
      ];
    }

    if (unit) {
      results = [
        ...results,
        ...(await runNearestSearch(
          embedding,
          limit,
          [
            { field: "audience", value: audience },
            { field: "unit", value: unit },
          ],
          "unit-specific"
        )),
      ];
    }

    const globalResults = await runNearestSearch(
      embedding,
      limit,
      [
        { field: "audience", value: audience },
        { field: "unit", value: null },
        { field: "persona", value: null },
      ],
      "global"
    );

    const allResults = mergeAndRank([...results, ...globalResults], limit);
    console.log(`Returning ${allResults.length} total results.`);
    return allResults;
  } catch (error) {
    console.warn(
      "Vector search bypassed (e.g. unauthenticated or missing indices), returning empty fallback content:",
      error
    );
    return [];
  }
};

/**
 * Staff desktop search:
 * - staff-tagged chunks (audience == "staff")
 * - general college KB (audience == "all" + unit/persona null)
 * Excludes unit-specific and persona-specific student content.
 * Student Lumen still never sees audience == "staff".
 */
export const searchStaffChunks = async (queryText: string, limit: number = 8) => {
  console.log(`Staff search for query: "${queryText}" (staff + general global)`);
  const embedding = await getEmbeddings(queryText);

  try {
    const [staffResults, generalResults] = await Promise.all([
      runNearestSearch(embedding, limit, [{ field: "audience", value: "staff" }], "staff"),
      runNearestSearch(
        embedding,
        limit,
        [
          { field: "audience", value: "all" },
          { field: "unit", value: null },
          { field: "persona", value: null },
        ],
        "general-global"
      ),
    ]);
    return mergeAndRank([...staffResults, ...generalResults], limit);
  } catch (error) {
    console.warn("Staff vector search failed:", error);
    return [];
  }
};

/**
 * Personal uploads search — user_chunks owned by the given uid.
 */
export const searchUserChunks = async (queryText: string, userId: string, limit: number = 5) => {
  if (!userId) return [];
  const embedding = await getEmbeddings(queryText);
  try {
    const pipeline = (db as any)
      .pipeline()
      .collection("user_chunks")
      .where(equal("userId", userId))
      .findNearest({
        field: "embedding",
        vectorValue: vector(embedding),
        distanceMeasure: "cosine",
        limit,
        distanceField: "distance",
      });
    const snapshot = await execute(pipeline);
    return mapPipelineResults(snapshot);
  } catch (error) {
    console.warn("Personal user_chunks search failed:", error);
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
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];

  for (const file of files) {
    if (allowedMimeTypes.includes(file.mimeType)) {
      try {
        console.log(`Indexing file: ${file.name} (${file.mimeType})`);
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

        const chunks = text.match(/[\s\S]{1,1500}/g) || [];
        console.log(`Split ${file.name} into ${chunks.length} chunks`);

        for (const chunkText of chunks) {
          await getEmbeddings(chunkText);
        }
      } catch (e) {
        console.error(`Error processing file ${file.name}:`, e);
      }
    }
  }
};
