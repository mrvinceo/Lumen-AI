# Staff audience vector indexes

After deploying the `audience` field on `chunks`, create Firestore **vector indexes** in the Firebase Console (or via `gcloud`) so `findNearest` queries with equality filters succeed.

## Required query shapes

Student Lumen (`searchChunks`):

- `audience == "all"` + `persona == <id>` + vector on `embedding`
- `audience == "all"` + `unit == <code>` + vector on `embedding`
- `audience == "all"` + `unit == null` + `persona == null` + vector on `embedding`

Staff desktop (`searchStaffChunks`):

- `audience == "staff"` + vector on `embedding`

Personal uploads (`searchUserChunks`):

- `user_chunks`: `userId == <uid>` + vector on `embedding`

## Dimension

Embeddings use **768** dimensions (`gemini-embedding-2-preview` with `outputDimensionality: 768`), cosine distance.

## One-time data backfill

In Lumen Admin → Knowledge Base, click **Backfill audience=all** (or `POST /api/admin/backfill-audience` with an admin Bearer ID token) before relying on student filters.
